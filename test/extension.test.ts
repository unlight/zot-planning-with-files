import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const EXT_DIR = dirname(dirname(import.meta.filename));

const EXPECTED_COMMANDS = [
  'plan-status',
  'plan-attest',
  'plan-list',
  'plan-use',
  'plan-close',
  'plan-execute',
  'plan-goal',
  'plan-loop',
  'pwf',
  'pwf-status',
];

const PLAN = `# Task Plan: Test

## Goal

Prove the extension works.

## Phases

### Phase 1: One

- [ ] alpha
- **Status:** in_progress

### Phase 2: Two

- [ ] beta
- **Status:** pending
`;

const PROGRESS = `# Progress Log

## Session: 2026-01-01

### Phase 1: One

- **Status:** in_progress
- Actions taken:
  - started
`;

interface TestFrame {
  type: string;
  id?: string;
  name?: string;
  message?: string;
  text?: string;
  system_prompt?: string;
  startup?: boolean;
  display?: string;
  error?: string;
  action?: string;
  prompt?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  events?: string[];
  intercept?: string[];
  [key: string]: unknown;
}

type TestChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface FrameQueue {
  next: (
    predicate: (frame: TestFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<TestFrame>;
  queue: TestFrame[];
}

interface Waiter {
  predicate: (frame: TestFrame) => boolean;
  resolve: (frame: TestFrame) => void;
}

function createProject({
  withPlan = true,
}: { withPlan?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'zot-pwf-'));
  if (withPlan) {
    writeFileSync(join(dir, 'task_plan.md'), PLAN);
    writeFileSync(join(dir, 'findings.md'), '# Findings\n');
    writeFileSync(join(dir, 'progress.md'), PROGRESS);
  }
  return dir;
}

function setGitBranch(projectDir: string, branch: string): void {
  const gitDirectory = join(projectDir, '.git');
  mkdirSync(gitDirectory, { recursive: true });
  writeFileSync(join(gitDirectory, 'HEAD'), `ref: refs/heads/${branch}\n`);
}

function createFrameQueue(child: TestChild): FrameQueue {
  const queue: TestFrame[] = [];
  const waiters: Waiter[] = [];

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line: string) => {
    let frame: TestFrame;
    try {
      frame = JSON.parse(line) as TestFrame;
    } catch {
      return;
    }

    const index = waiters.findIndex(waiter => waiter.predicate(frame));
    if (index !== -1) {
      const waiter = waiters[index];
      waiters.splice(index, 1);
      waiter?.resolve(frame);
      return;
    }
    queue.push(frame);
  });

  function next(
    predicate: (frame: TestFrame) => boolean,
    timeoutMs = 3000,
  ): Promise<TestFrame> {
    const index = queue.findIndex(frame => predicate(frame));
    if (index !== -1) {
      const frame = queue[index];
      if (frame) {
        queue.splice(index, 1);
        return Promise.resolve(frame);
      }
    }

    return new Promise<TestFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = waiters.indexOf(waiter);
        if (pending !== -1) waiters.splice(pending, 1);
        const queuedTypes = queue.map(frame => frame.type);
        reject(
          new Error(
            `timeout waiting for frame; queued=${JSON.stringify(queuedTypes)}`,
          ),
        );
      }, timeoutMs);

      const waiter: Waiter = {
        predicate,
        resolve: (frame: TestFrame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      waiters.push(waiter);
    });
  }

  return { next, queue };
}

interface Session {
  child: TestChild;
  send: (frame: Record<string, unknown>) => void;
  frames: FrameQueue;
  command: (name: string, arguments_?: string) => Promise<TestFrame>;
  beginSession: (sessionId?: string) => Promise<TestFrame | undefined>;
  close: () => Promise<void>;
  stderr: () => string;
  hello: TestFrame;
  commands: TestFrame[];
  subscribe: TestFrame;
}

async function startExtension(
  projectDir: string,
  environment: Record<string, string> = {},
): Promise<Session> {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: EXT_DIR,
    env: { ...process.env, PWF_MODE: 'parity', ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as TestChild;

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const frames = createFrameQueue(child);
  const send = (frame: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  const hello = await frames.next(frame => frame.type === 'hello');

  send({
    type: 'hello_ack',
    protocol_version: 1,
    zot_version: 'test',
    provider: 'anthropic',
    model: 'claude-test',
    cwd: projectDir,
    extension_dir: EXT_DIR,
    data_dir: EXT_DIR,
  });

  const commands: TestFrame[] = [];
  for (let index = 0; index < EXPECTED_COMMANDS.length; index++) {
    commands.push(
      await frames.next(frame => frame.type === 'register_command'),
    );
  }
  const subscribe = await frames.next(frame => frame.type === 'subscribe');
  await frames.next(frame => frame.type === 'ready');

  const close = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    try {
      send({ type: 'shutdown' });
      await frames.next(frame => frame.type === 'shutdown_ack', 2000);
    } catch {
      // The process may already be gone; exit cleanup below is enough.
    }
    child.stdin.end();
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
  };

  const command = async (name: string, arguments_ = ''): Promise<TestFrame> => {
    const id = `${name}-${Math.random().toString(36).slice(2)}`;
    send({ type: 'command_invoked', id, name, args: arguments_ });
    return frames.next(
      frame => frame.type === 'command_response' && frame.id === id,
    );
  };

  const beginSession = async (
    sessionId = 's1',
  ): Promise<TestFrame | undefined> => {
    send({
      type: 'event',
      event: 'session_start',
      session_id: sessionId,
      cwd: projectDir,
    });
    try {
      return await frames.next(
        frame => frame.type === 'notify' && frame.startup === true,
        500,
      );
    } catch {
      return undefined;
    }
  };

  return {
    child,
    send,
    frames,
    command,
    beginSession,
    close,
    stderr: () => stderr,
    hello,
    commands,
    subscribe,
  };
}

test('registers the planning command surface', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  assert.equal(session.hello.name, 'planning-with-files');
  const commandNames = session.commands
    .map(entry => entry.name ?? '')
    .toSorted((a, b) => a.localeCompare(b));
  const expectedNames = [...EXPECTED_COMMANDS].toSorted((a, b) =>
    a.localeCompare(b),
  );
  assert.deepEqual(commandNames, expectedNames);
  assert.ok((session.subscribe.events ?? []).includes('turn_end'));
  assert.ok((session.subscribe.events ?? []).includes('tool_result'));
  assert.deepEqual(session.subscribe.intercept ?? [], ['before_agent_start']);

  const response = await session.command('plan-status');
  assert.equal(response.action, 'display');
  assert.match(response.display ?? '', /Phases: 2/);
  assert.match(response.display ?? '', /Complete: 0/);
  assert.match(response.display ?? '', /In progress: 1/);
  assert.match(response.display ?? '', /Blocked: 0/);
  assert.match(response.display ?? '', /Attestation: not recorded/);
  assert.match(response.display ?? '', /Execution: passive/);
});

test('pwf aliases start the workflow and show status', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  const started = await session.command('pwf', 'ship the feature');
  assert.equal(started.action, 'tool_prompt');
  assert.equal(started.tool_name, 'skill');
  assert.deepEqual(started.tool_args, { name: 'planning-with-files' });
  assert.equal(started.prompt, 'ship the feature');

  const defaultStart = await session.command('pwf');
  assert.match(
    defaultStart.prompt ?? '',
    /Start the planning-with-files workflow/,
  );

  const status = await session.command('pwf-status');
  assert.equal(status.action, 'display');
  assert.match(status.display ?? '', /Planning status/);
  assert.match(status.display ?? '', /Current: Phase 1: One/);
  assert.match(
    status.display ?? '',
    /Phases: 0\/2 complete, 1 in progress, 1 pending, 0 blocked/,
  );
  assert.match(status.display ?? '', /Attestation: not recorded/);
  assert.match(status.display ?? '', /Execution: passive/);
});

test('attestation lifecycle writes, verifies, and clears', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  const attested = await session.command('plan-attest');
  assert.equal(attested.action, 'display');
  assert.match(attested.display ?? '', /Plan attested/);

  const attestationPath = join(project, '.plan-attestation');
  assert.equal(existsSync(attestationPath), true);
  assert.match(readFileSync(attestationPath, 'utf8').trim(), /^[a-f0-9]{64}$/);

  const shown = await session.command('plan-attest', '--show');
  assert.match(shown.display ?? '', /Status: valid/);

  const cleared = await session.command('plan-attest', '--clear');
  assert.match(cleared.display ?? '', /Cleared attestation/);
  assert.equal(existsSync(attestationPath), false);
});

test('plan-execute activates the before_agent_start injection', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  const startup = await session.beginSession('s1');
  assert.match(startup?.message ?? '', /0\/2 phases complete/);

  await session.command('plan-attest');
  await session.command('plan-execute');
  const approved = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );
  assert.match(approved.message ?? '', /hooks are now active/);

  session.send({
    type: 'event_intercept',
    id: 'start-1',
    event: 'before_agent_start',
    system_prompt: 'BASE PROMPT',
    cwd: project,
    session_id: 's1',
  });
  const response = await session.frames.next(
    frame =>
      frame.type === 'event_intercept_response' && frame.id === 'start-1',
  );

  assert.match(response.system_prompt ?? '', /^BASE PROMPT/);
  assert.match(response.system_prompt ?? '', /===BEGIN PLAN DATA===/);
  assert.match(response.system_prompt ?? '', /### Phase 1: One/);
  assert.match(response.system_prompt ?? '', /=== recent progress ===/);
});

test('plan-close closes the plan and reopens it', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');
  await session.command('plan-attest');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  const closed = await session.command('plan-close');
  assert.equal(closed.action, 'noop');
  const closedNotify = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan closed'),
  );
  assert.match(closedNotify.message ?? '', /Execution approval cleared/);
  assert.match(
    readFileSync(join(project, 'task_plan.md'), 'utf8'),
    /<!-- pwf: closed -->/,
  );

  const closedStatus = await session.command('plan-status');
  assert.match(closedStatus.display ?? '', /Closed: yes/);
  assert.match(closedStatus.display ?? '', /Execution: closed/);
  assert.match(closedStatus.display ?? '', /Attestation: not recorded/);

  session.send({
    type: 'event',
    event: 'turn_end',
    stop: 'end_turn',
    session_id: 's1',
    cwd: project,
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(
    session.frames.queue.some(frame => frame.type === 'submit'),
    false,
  );

  session.send({
    type: 'event_intercept',
    id: 'closed-start',
    event: 'before_agent_start',
    system_prompt: 'BASE PROMPT',
    cwd: project,
    session_id: 's1',
  });
  const intercept = await session.frames.next(
    frame =>
      frame.type === 'event_intercept_response' && frame.id === 'closed-start',
  );
  assert.equal(intercept.system_prompt, undefined);

  const refused = await session.command('plan-execute');
  assert.equal(refused.action, 'noop');
  const refusedNotify = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan is closed'),
  );
  assert.match(refusedNotify.message ?? '', /plan-close clear/);

  await session.command('plan-close', 'clear');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan reopened'),
  );
  assert.doesNotMatch(
    readFileSync(join(project, 'task_plan.md'), 'utf8'),
    /<!-- pwf: closed -->/,
  );

  const reopenedStatus = await session.command('plan-status');
  assert.match(reopenedStatus.display ?? '', /Closed: no/);
  assert.match(reopenedStatus.display ?? '', /Execution: passive/);

  await session.command('plan-attest');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  session.send({
    type: 'event',
    event: 'turn_end',
    stop: 'end_turn',
    session_id: 's1',
    cwd: project,
  });
  const submit = await session.frames.next(frame => frame.type === 'submit');
  assert.match(submit.text ?? '', /Task incomplete/);
});

test('a changed plan is blocked from injection', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');
  await session.command('plan-attest');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  writeFileSync(
    join(project, 'task_plan.md'),
    PLAN.replace('in_progress', 'complete'),
  );

  session.send({
    type: 'event_intercept',
    id: 'start-2',
    event: 'before_agent_start',
    system_prompt: 'BASE PROMPT',
    cwd: project,
    session_id: 's1',
  });
  const response = await session.frames.next(
    frame =>
      frame.type === 'event_intercept_response' && frame.id === 'start-2',
  );

  assert.match(response.system_prompt ?? '', /PLAN TAMPERED/);
  assert.doesNotMatch(response.system_prompt ?? '', /===BEGIN PLAN DATA===/);
});

test('turn_end auto-continues three times and then stops', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');
  await session.command('plan-attest');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    session.send({
      type: 'event',
      event: 'turn_end',
      stop: 'end_turn',
      session_id: 's1',
      cwd: project,
    });
    const submit = await session.frames.next(frame => frame.type === 'submit');
    assert.match(submit.text ?? '', /Task incomplete/);
  }

  session.send({
    type: 'event',
    event: 'turn_end',
    stop: 'end_turn',
    session_id: 's1',
    cwd: project,
  });
  const limit = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Auto-continue limit reached'),
  );
  assert.ok(limit);

  session.send({
    type: 'event',
    event: 'user_prompt_submit',
    text: 'please continue',
    session_id: 's1',
    cwd: project,
  });
  session.send({
    type: 'event',
    event: 'turn_end',
    stop: 'end_turn',
    session_id: 's1',
    cwd: project,
  });
  const afterReset = await session.frames.next(
    frame => frame.type === 'submit',
  );
  assert.match(afterReset.text ?? '', /Task incomplete/);
});

test('turn_end does not auto-continue without an in_progress phase', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(
    join(project, 'task_plan.md'),
    `# Task Plan: Test

## Phases

### Phase 1: One

- [ ] alpha
- **Status:** pending

### Phase 2: Two

- [ ] beta
- **Status:** pending
`,
  );
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');
  await session.command('plan-attest');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  session.send({
    type: 'event',
    event: 'turn_end',
    stop: 'end_turn',
    session_id: 's1',
    cwd: project,
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(
    session.frames.queue.some(frame => frame.type === 'submit'),
    false,
  );
});

test('blocked phase is reported and does not auto-continue', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(
    join(project, 'task_plan.md'),
    `# Task Plan: Test

## Phases

### Phase 1: One

- [x] alpha
- **Status:** complete

### Phase 2: Two

- [ ] beta
- **Status:** blocked
`,
  );
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');
  const status = await session.command('plan-status');
  assert.match(status.display ?? '', /Complete: 1/);
  assert.match(status.display ?? '', /Pending: 0/);
  assert.match(status.display ?? '', /Blocked: 1/);

  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  session.send({
    type: 'event',
    event: 'turn_end',
    stop: 'end_turn',
    session_id: 's1',
    cwd: project,
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(
    session.frames.queue.some(frame => frame.type === 'submit'),
    false,
  );
});

test('plan-loop submits a tick and stops on command', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');

  const started = await session.command('plan-loop', '1s');
  assert.equal(started.action, 'noop');
  const startedNotify = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('plan-loop started'),
  );
  assert.match(startedNotify.message ?? '', /1s/);

  const submit = await session.frames.next(
    frame => frame.type === 'submit',
    2500,
  );
  assert.match(submit.text ?? '', /Read task_plan\.md/);

  await session.command('plan-loop', 'stop');
  const stopped = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('plan-loop stopped'),
  );
  assert.ok(stopped);
});

test('reports a missing plan and never injects one', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');
  const response = await session.command('plan-status');
  const warning = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('No active plan'),
  );
  assert.equal(response.action, 'noop');
  assert.ok(warning);

  const pwfStatus = await session.command('pwf-status');
  assert.match(pwfStatus.display ?? '', /No planning files found/);

  session.send({
    type: 'event',
    event: 'tool_call',
    tool_name: 'write',
    tool_args: { path: 'x.txt' },
    cwd: project,
    session_id: 's1',
  });
  const toolWarning = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('No task_plan.md found'),
  );
  assert.ok(toolWarning);

  session.send({
    type: 'event_intercept',
    id: 'start-3',
    event: 'before_agent_start',
    system_prompt: 'BASE PROMPT',
    cwd: project,
    session_id: 's1',
  });
  const intercept = await session.frames.next(
    frame =>
      frame.type === 'event_intercept_response' && frame.id === 'start-3',
  );
  assert.equal(intercept.system_prompt, undefined);
});

test('deduplicates identical notifications until user input', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project);
  t.after(() => session.close());

  await session.beginSession('s1');

  const sendWriteCall = (): void => {
    session.send({
      type: 'event',
      event: 'tool_call',
      tool_name: 'write',
      tool_args: { path: 'x.txt' },
      cwd: project,
      session_id: 's1',
    });
  };

  sendWriteCall();
  const first = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('No task_plan.md found'),
  );
  assert.equal(
    first.message,
    'No task_plan.md found. Create planning files first.',
  );

  sendWriteCall();
  await assert.rejects(
    session.frames.next(frame => frame.type === 'notify', 300),
    /timeout waiting for frame/,
  );

  session.send({
    type: 'event',
    event: 'user_prompt_submit',
    text: 'new user prompt',
    session_id: 's1',
    cwd: project,
  });
  sendWriteCall();
  const repeated = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('No task_plan.md found'),
  );
  assert.equal(
    repeated.message,
    'No task_plan.md found. Create planning files first.',
  );
});

test('selects only the plan bound to the current branch', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const slug of ['feature-a', 'feature-b']) {
    mkdirSync(join(project, '.planning', slug), { recursive: true });
    writeFileSync(join(project, '.planning', slug, 'task_plan.md'), PLAN);
  }
  writeFileSync(
    join(project, '.planning', 'feature-a', '.branch'),
    'feature/a\n',
  );
  writeFileSync(
    join(project, '.planning', 'feature-b', '.branch'),
    'feature/b\n',
  );
  writeFileSync(join(project, '.planning', '.active_plan'), 'feature-b\n');
  setGitBranch(project, 'feature/a');

  const session = await startExtension(project);
  t.after(() => session.close());

  const status = await session.command('plan-status');
  assert.match(status.display ?? '', /Current branch: feature\/a/);
  assert.match(status.display ?? '', /Plan branch: feature\/a/);
  assert.match(status.display ?? '', /\.planning\/feature-a\/task_plan\.md/);
  assert.doesNotMatch(
    status.display ?? '',
    /\.planning\/feature-b\/task_plan\.md/,
  );

  setGitBranch(project, 'feature/b');
  const switched = await session.command('plan-status');
  assert.match(switched.display ?? '', /Current branch: feature\/b/);
  assert.match(switched.display ?? '', /Plan branch: feature\/b/);
  assert.match(switched.display ?? '', /\.planning\/feature-b\/task_plan\.md/);
});

test('multiple matching plans require /plan-use', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const slug of ['alpha', 'beta']) {
    mkdirSync(join(project, '.planning', slug), { recursive: true });
    writeFileSync(join(project, '.planning', slug, 'task_plan.md'), PLAN);
    writeFileSync(join(project, '.planning', slug, '.branch'), 'feature/a\n');
  }
  setGitBranch(project, 'feature/a');

  const session = await startExtension(project);
  t.after(() => session.close());

  const list = await session.command('plan-list');
  assert.match(list.display ?? '', /Current branch: feature\/a/);
  assert.match(list.display ?? '', /\*alpha\tfeature\/a/);
  assert.match(list.display ?? '', /\*beta\tfeature\/a/);

  const ambiguous = await session.command('plan-status');
  assert.equal(ambiguous.action, 'noop');
  const warning = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes(
        'Multiple plans are available for branch feature/a',
      ),
  );
  assert.match(warning.message ?? '', /alpha \(branch: feature\/a\)/);
  assert.match(warning.message ?? '', /beta \(branch: feature\/a\)/);

  const selected = await session.command('plan-use', 'alpha');
  assert.equal(selected.action, 'noop');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan selected: alpha'),
  );
  assert.equal(
    readFileSync(join(project, '.planning', '.active_plan'), 'utf8'),
    'alpha\n',
  );
  assert.equal(
    readFileSync(join(project, '.planning', 'alpha', '.branch'), 'utf8'),
    'feature/a\n',
  );

  const status = await session.command('plan-status');
  assert.match(status.display ?? '', /\.planning\/alpha\/task_plan\.md/);

  const rejected = await session.command('plan-use', 'missing');
  assert.equal(rejected.action, 'noop');
  assert.match(rejected.error ?? '', /did not resolve/);

  const missingRoot = await session.command('plan-use', 'root');
  assert.equal(missingRoot.action, 'noop');
  assert.match(missingRoot.error ?? '', /does not contain task_plan\.md/);
});

test('refuses a plan bound to another branch', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.planning', 'other'), { recursive: true });
  writeFileSync(join(project, '.planning', 'other', 'task_plan.md'), PLAN);
  writeFileSync(join(project, '.planning', 'other', '.branch'), 'feature/b\n');
  setGitBranch(project, 'feature/a');

  const session = await startExtension(project);
  t.after(() => session.close());

  const status = await session.command('plan-status');
  assert.equal(status.action, 'noop');
  const warning = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('No plan is bound to branch feature/a'),
  );
  assert.match(warning.message ?? '', /other \(branch: feature\/b\)/);
});

test('binds a single unbound plan to the current branch', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.planning', 'alpha'), { recursive: true });
  writeFileSync(join(project, '.planning', 'alpha', 'task_plan.md'), PLAN);
  setGitBranch(project, 'feature/a');

  const session = await startExtension(project);
  t.after(() => session.close());

  const status = await session.command('plan-status');
  assert.match(status.display ?? '', /\.planning\/alpha\/task_plan\.md/);
  assert.equal(
    readFileSync(join(project, '.planning', 'alpha', '.branch'), 'utf8'),
    'feature/a\n',
  );
  assert.equal(
    readFileSync(join(project, '.planning', '.active_plan'), 'utf8'),
    'alpha\n',
  );
});

test('branch sidecar does not invalidate attestation', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.planning', 'alpha'), { recursive: true });
  writeFileSync(join(project, '.planning', 'alpha', 'task_plan.md'), PLAN);
  setGitBranch(project, 'feature/a');

  const session = await startExtension(project);
  t.after(() => session.close());
  await session.beginSession('s1');
  await session.command('plan-attest', '--target alpha');
  writeFileSync(join(project, '.planning', 'alpha', '.branch'), 'feature/a\n');

  const show = await session.command('plan-attest', '--show');
  assert.match(show.display ?? '', /Status: valid/);
});

test('branch change clears execution approval', async t => {
  const project = createProject({ withPlan: false });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.planning', 'alpha'), { recursive: true });
  writeFileSync(join(project, '.planning', 'alpha', 'task_plan.md'), PLAN);
  writeFileSync(join(project, '.planning', 'alpha', '.branch'), 'feature/a\n');
  setGitBranch(project, 'feature/a');

  const session = await startExtension(project);
  t.after(() => session.close());
  await session.beginSession('s1');
  await session.command('plan-attest');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  const active = await session.command('plan-status');
  assert.match(active.display ?? '', /Execution: active/);

  setGitBranch(project, 'feature/b');
  await session.command('plan-status');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Branch changed: feature/a -> feature/b'),
  );

  setGitBranch(project, 'feature/a');
  const passive = await session.command('plan-status');
  assert.match(passive.display ?? '', /Execution: passive/);
});

test('PLAN_ID binds resolution and a bad selector is refused', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  mkdirSync(join(project, '.planning', 'alpha'), { recursive: true });
  mkdirSync(join(project, '.planning', 'beta'), { recursive: true });
  writeFileSync(join(project, '.planning', 'alpha', 'task_plan.md'), PLAN);
  writeFileSync(join(project, '.planning', 'beta', 'task_plan.md'), PLAN);

  const scoped = await startExtension(project, { PLAN_ID: 'alpha' });
  t.after(() => scoped.close());
  const status = await scoped.command('plan-status');
  assert.match(status.display ?? '', /\.planning\/alpha\/task_plan\.md/);

  const rejected = await startExtension(project, { PLAN_ID: 'missing' });
  t.after(() => rejected.close());
  const rejectedResponse = await rejected.command('plan-status');
  const rejectedWarning = await rejected.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('PLAN_ID did not resolve'),
  );
  assert.equal(rejectedResponse.action, 'noop');
  assert.ok(rejectedWarning);
});

test('an invalid PWF_PLAN_ROOT is refused', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project, {
    PWF_PLAN_ROOT: '/definitely/not/here',
  });
  t.after(() => session.close());

  const response = await session.command('plan-status');
  const warning = await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('PWF_PLAN_ROOT'),
  );
  assert.equal(response.action, 'noop');
  assert.ok(warning);
});

test('auto mode picks cache-safe for DeepSeek', async t => {
  const project = createProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = await startExtension(project, { PWF_MODE: 'auto' });
  t.after(() => session.close());

  // The hello_ack provider is anthropic in startExtension; switch the host
  // model by sending a second hello_ack with DeepSeek metadata.
  session.send({
    type: 'hello_ack',
    protocol_version: 1,
    zot_version: 'test',
    provider: 'deepseek',
    model: 'deepseek-chat',
    cwd: project,
    extension_dir: EXT_DIR,
    data_dir: EXT_DIR,
  });

  await session.beginSession('s1');
  await session.command('plan-execute');
  await session.frames.next(
    frame =>
      frame.type === 'notify' &&
      typeof frame.message === 'string' &&
      frame.message.includes('Plan execution approved'),
  );

  session.send({
    type: 'event_intercept',
    id: 'start-4',
    event: 'before_agent_start',
    system_prompt: 'BASE PROMPT',
    cwd: project,
    session_id: 's1',
  });
  const response = await session.frames.next(
    frame =>
      frame.type === 'event_intercept_response' && frame.id === 'start-4',
  );

  assert.match(
    response.system_prompt ?? '',
    /Read task_plan\.md for current phase and status/,
  );
  assert.doesNotMatch(response.system_prompt ?? '', /===BEGIN PLAN DATA===/);
});
