/* eslint-disable @typescript-eslint/no-floating-promises -- node:test accepts async cleanup hooks */
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
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';

const EXT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const EXPECTED_COMMANDS = [
  'plan-status',
  'plan-attest',
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

test('registers the pi-agent command surface', async t => {
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
    /Phases: 0\/2 complete, 1 in progress, 1 pending/,
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
