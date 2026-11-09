// Ported from the upstream planning-with-files extension runtime.ts.
// zot-specific event mapping and injection behavior adapted from docs/extensions.md.
import {
  isAllPhasesComplete,
  isPlanIncomplete,
  isSessionAttached,
  readPlanStatus,
} from './plan.ts';
import { checkPlanAttestation } from './attestation.ts';
import {
  AUTO_CONTINUE_LIMIT,
  CACHE_SAFE_REMINDER,
  POST_WRITE_REMINDER,
} from './constants.ts';
import {
  buildParityPlanInjection,
  buildTamperMessage,
  deriveEffectiveMode,
  resolveConfiguredMode,
  selectionErrorNotice,
  summarizePlan,
} from './runtime.ts';
import {
  clearSessionApprovals,
  clearSessionAutoContinue,
  clearSessionLoop,
  isExecutionApproved,
  planSessionKey,
} from './state.ts';
import type {
  EventFrame,
  InterceptFrame,
  ProtocolContext,
  RuntimeState,
} from './types.ts';

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\bsudo\b/i,
  /\bchmod\s+(0?777|a\+rwx)\b/i,
  /\bgit\s+push\s+.*(--force|-f\b|--mirror|\+)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fdx]/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/,
  /\bdd\s+.*of=\/dev\/[sh]d[a-z]/i,
];

function isDangerousBashCommand(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some(pattern => pattern.test(command));
}

function isToolUseStop(stop: string | undefined): boolean {
  return /tool/i.test(stop || '');
}

function isFailedTurn(frame: EventFrame): boolean {
  const stop = (frame.stop || '').toLowerCase();
  return Boolean(frame.error) || stop === 'error' || stop === 'aborted';
}

function appendBlock(prompt: string, block: string): string {
  return prompt.length === 0 ? block : `${prompt}\n\n${block}`;
}

function syncContext(
  frame: { cwd?: string; session_id?: string },
  context: ProtocolContext,
): void {
  if (frame.cwd) context.state.cwd = frame.cwd;
  if (frame.session_id) context.state.sessionId = frame.session_id;
}

function debug(context: ProtocolContext, message: string): void {
  if (process.env.PWF_DEBUG) context.log(message);
}

export function handleEvent(frame: EventFrame, context: ProtocolContext): void {
  syncContext(frame, context);

  switch (frame.event) {
    case 'session_start': {
      onSessionStart(context);
      break;
    }
    case 'session_end': {
      onSessionEnd(context);
      break;
    }
    case 'user_prompt_submit': {
      onUserPromptSubmit(frame, context);
      break;
    }
    case 'turn_end': {
      onTurnEnd(frame, context);
      break;
    }
    case 'tool_call': {
      onToolCall(frame, context);
      break;
    }
    case 'tool_result': {
      onToolResult(frame, context);
      break;
    }
    case 'pre_compact': {
      onPreCompact(context);
      break;
    }
    case 'post_compact': {
      onPostCompact(context);
      break;
    }
    default: {
      break;
    }
  }
}

function onSessionStart(context: ProtocolContext): void {
  const state: RuntimeState = context.state;
  state.lastNotification = undefined;
  clearSessionAutoContinue(state, state.sessionId);
  clearSessionApprovals(state, state.sessionId);
  clearSessionLoop(state, state.sessionId);

  const status = readPlanStatus(state.cwd);
  const notice = selectionErrorNotice(status);
  if (notice) {
    context.notify('warn', notice, true);
    return;
  }
  if (!status.exists) return;
  if (!isSessionAttached(status.cwd, state.sessionId)) {
    context.notify(
      'warn',
      '[planning-with-files] session not attached to planning context',
      true,
    );
    return;
  }
  context.notify(
    'info',
    `${summarizePlan(status)} - run /plan-execute to activate hooks`,
    true,
  );
}

function onSessionEnd(context: ProtocolContext): void {
  const state = context.state;
  state.lastNotification = undefined;
  clearSessionAutoContinue(state, state.sessionId);
  clearSessionApprovals(state, state.sessionId);
  clearSessionLoop(state, state.sessionId);
}

function onUserPromptSubmit(frame: EventFrame, context: ProtocolContext): void {
  const state = context.state;
  const text = typeof frame.text === 'string' ? frame.text : '';

  // Our own submit calls are not user input; do not reset the retry budget.
  const pending = state.extensionSubmits.get(text);
  if (pending) {
    if (pending <= 1) state.extensionSubmits.delete(text);
    else state.extensionSubmits.set(text, pending - 1);
    return;
  }
  state.lastNotification = undefined;
  clearSessionAutoContinue(state, state.sessionId);
}

function onTurnEnd(frame: EventFrame, context: ProtocolContext): void {
  // turn_end also fires for tool-use steps; only a terminal turn can continue.
  if (isToolUseStop(frame.stop)) return;

  const state = context.state;
  const status = readPlanStatus(state.cwd);
  if (!status.exists) return;

  const sessionId = state.sessionId;
  const planKey = planSessionKey(sessionId, status);

  if (status.isClosed) {
    state.autoContinueBySessionPlan.set(planKey, 0);
    return;
  }

  if (isAllPhasesComplete(status)) {
    state.autoContinueBySessionPlan.set(planKey, 0);
    context.notify(
      'info',
      `[planning-with-files] ALL PHASES COMPLETE (${status.completePhases}/${status.totalPhases}).`,
    );
    return;
  }

  if (isFailedTurn(frame) || !isPlanIncomplete(status)) return;

  if (!isExecutionApproved(state, sessionId, status)) {
    context.notify(
      'warn',
      `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases}). Run /plan-execute to activate hooks.`,
    );
    return;
  }

  const mode = deriveEffectiveMode(
    resolveConfiguredMode(status.cwd),
    state.host,
  );
  if (mode === 'notify') {
    context.notify(
      'warn',
      `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases}). Continue manually.`,
    );
    return;
  }

  const current = state.autoContinueBySessionPlan.get(planKey) ?? 0;
  if (current >= AUTO_CONTINUE_LIMIT) {
    context.notify(
      'warn',
      `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases}). Auto-continue limit reached.`,
    );
    return;
  }

  state.autoContinueBySessionPlan.set(planKey, current + 1);
  debug(
    context,
    `auto-continue ${current + 1}/${AUTO_CONTINUE_LIMIT} for ${sessionId} (${status.completePhases}/${status.totalPhases} phases)`,
  );
  const goal = state.goalBySession.get(sessionId);
  const message =
    `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases} phases done). ` +
    'Update progress.md with what was done, then read task_plan.md and continue remaining phases.' +
    (goal ? ` Goal: ${goal}` : '');

  context.submit(message);
}

function onToolCall(frame: EventFrame, context: ProtocolContext): void {
  const status = readPlanStatus(context.state.cwd);
  const toolName = frame.tool_name || '';

  if (
    !status.exists &&
    !status.selectionError &&
    (toolName === 'write' || toolName === 'edit')
  ) {
    context.notify(
      'warn',
      '[planning-with-files] No task_plan.md found. Create planning files first.',
    );
  }

  if (toolName !== 'bash') return;

  const toolArguments: Record<string, unknown> = frame.tool_args ?? {};
  const command =
    typeof toolArguments.command === 'string' ? toolArguments.command : '';
  if (isDangerousBashCommand(command)) {
    context.notify(
      'warn',
      '[planning-with-files] Dangerous command detected. Review current phase in task_plan.md before approval.',
    );
  }
}

function onToolResult(frame: EventFrame, context: ProtocolContext): void {
  if (frame.tool_name !== 'write' && frame.tool_name !== 'edit') return;

  const status = readPlanStatus(context.state.cwd);
  if (
    !status.exists ||
    !isExecutionApproved(context.state, context.state.sessionId, status)
  )
    return;

  context.notify('info', POST_WRITE_REMINDER);
}

function onPreCompact(context: ProtocolContext): void {
  const status = readPlanStatus(context.state.cwd);
  if (!status.exists) return;

  const attestation = checkPlanAttestation(status);
  const reminder = [
    '[planning-with-files] PreCompact: context compaction is about to occur.',
    'Before compaction completes: ensure progress.md captures recent actions and task_plan.md status reflects current phase.',
    attestation.enabled && attestation.expected
      ? `Plan-SHA256 at compaction: ${attestation.expected}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  context.notify('info', reminder);
}

function onPostCompact(context: ProtocolContext): void {
  context.state.lastNotification = undefined;
}

export function handleBeforeAgentStart(
  frame: InterceptFrame,
  context: ProtocolContext,
): string | undefined {
  const state = context.state;
  syncContext(frame, context);
  if (frame.provider) state.host.provider = frame.provider;
  if (frame.model) state.host.model = frame.model;

  // A missing prompt means the host did not include one; never replace it.
  if (typeof frame.system_prompt !== 'string') return undefined;

  const status = readPlanStatus(state.cwd);
  const notice = selectionErrorNotice(status);
  if (notice) return appendBlock(frame.system_prompt, notice);
  if (
    !status.exists ||
    !isSessionAttached(status.cwd, state.sessionId) ||
    !isExecutionApproved(state, state.sessionId, status)
  ) {
    return undefined;
  }

  const attestation = checkPlanAttestation(status);
  if (attestation.tampered) {
    return appendBlock(frame.system_prompt, buildTamperMessage(status));
  }

  const mode = deriveEffectiveMode(
    resolveConfiguredMode(status.cwd),
    state.host,
  );
  if (mode === 'notify') return undefined;

  debug(context, `injecting ${mode} plan context for ${status.planPath}`);
  const block =
    mode === 'parity' ? buildParityPlanInjection(status) : CACHE_SAFE_REMINDER;
  return appendBlock(frame.system_prompt, block);
}
