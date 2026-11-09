import {
  isAllPhasesComplete,
  readPlanStatus,
  resolvePlanPathsForTarget,
} from './plan.ts';
import {
  checkPlanAttestation,
  clearPlanAttestation,
  writePlanAttestation,
} from './attestation.ts';
import {
  DEFAULT_GOAL_CONDITION,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_LOOP_PROMPT,
  INVALID_PLAN_ROOT_NOTICE,
  PLAN_SELECTOR_REJECTED_NOTICE,
  SESSION_PLAN_AMBIGUOUS_NOTICE,
} from './constants.ts';
import { buildTamperMessage, summarizePlan } from './runtime.ts';
import {
  approveExecution,
  clearExecution,
  clearSessionLoop,
  isExecutionApproved,
} from './state.ts';
import type { CommandResponse, PlanStatus, ProtocolContext } from './types.ts';

export function selectionErrorNotice(status: PlanStatus): string {
  switch (status.selectionError) {
    case 'session-plan-ambiguous': {
      return SESSION_PLAN_AMBIGUOUS_NOTICE;
    }
    case 'invalid-plan-root': {
      return INVALID_PLAN_ROOT_NOTICE;
    }
    case 'plan-selector-rejected': {
      return PLAN_SELECTOR_REJECTED_NOTICE;
    }
    default: {
      return '';
    }
  }
}

function notifySelectionError(
  status: PlanStatus,
  notify: ProtocolContext['notify'],
): string {
  const notice = selectionErrorNotice(status);
  if (!notice) return '';
  notify('warn', notice);
  return notice;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function parseIntervalSpec(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return undefined;

  const rawAmount = match[1];
  if (!rawAmount) return undefined;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  const unit = match[2]?.toLowerCase();
  if (!unit) return undefined;

  const factors: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const factor = factors[unit];
  return factor ? amount * factor : undefined;
}

function isStopWord(value: string): boolean {
  return ['stop', 'off', 'clear', 'disable'].includes(value);
}

export function handleCommand(
  name: string,
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  switch (name) {
    case 'plan-status': {
      return handlePlanStatus(context);
    }
    case 'plan-attest': {
      return handlePlanAttest(commandArguments, context);
    }
    case 'plan-execute': {
      return handlePlanExecute(commandArguments, context);
    }
    case 'plan-goal': {
      return handlePlanGoal(commandArguments, context);
    }
    case 'plan-loop': {
      return handlePlanLoop(commandArguments, context);
    }
    default: {
      return { action: 'noop', error: `unknown command /${name}` };
    }
  }
}

function handlePlanStatus(context: ProtocolContext): CommandResponse {
  const status = readPlanStatus(context.state.cwd);
  if (notifySelectionError(status, context.notify)) return { action: 'noop' };
  if (!status.exists) {
    context.notify('warn', 'No active plan (task_plan.md not found)');
    return { action: 'noop' };
  }

  const attestation = checkPlanAttestation(status);
  const isApproved = isExecutionApproved(
    context.state,
    context.state.sessionId,
    status,
  );
  const lines: string[] = [
    `Plan path: ${status.planPath}`,
    `Scope: ${status.scope}`,
    ...(status.planId ? [`Plan ID: ${status.planId}`] : []),
    `Phases: ${status.totalPhases}`,
    `Complete: ${status.completePhases}`,
    `In progress: ${status.inProgressPhases}`,
    `Pending: ${status.pendingPhases}`,
    `Attestation: ${attestation.enabled ? (attestation.tampered ? 'TAMPERED' : 'valid') : 'not recorded'}`,
    `Execution: ${isApproved ? 'active' : 'passive (run /plan-execute)'}`,
  ];
  return { action: 'display', display: lines.join('\n') };
}

function handlePlanAttest(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const parts = commandArguments.trim()
    ? commandArguments.trim().split(/\s+/)
    : [];
  let mode: 'attest' | 'show' | 'clear' = 'attest';
  let target: string | undefined;

  if (parts.length === 1 && (parts[0] === '--show' || parts[0] === '-Show')) {
    mode = 'show';
  } else if (
    parts.length === 1 &&
    (parts[0] === '--clear' || parts[0] === '-Clear')
  ) {
    mode = 'clear';
  } else if (
    parts.length === 2 &&
    (parts[0] === '--target' || parts[0] === '-Target')
  ) {
    target = parts[1];
  } else if (parts.length > 0) {
    return {
      action: 'noop',
      error: 'usage: /plan-attest [--show|--clear|--target root|<plan-id>]',
    };
  }

  let status: PlanStatus;
  if (target) {
    const paths = resolvePlanPathsForTarget(context.state.cwd, target);
    if (!paths) {
      return {
        action: 'noop',
        error: `[plan-attest] --target ${target} did not resolve to a plan. An explicit target is a binding: nothing was attested and no other plan was substituted.`,
      };
    }
    status = readPlanStatus(context.state.cwd, paths);
  } else {
    status = readPlanStatus(context.state.cwd);
    if (notifySelectionError(status, context.notify)) {
      return { action: 'noop' };
    }
  }

  if (!status.exists || !status.planPath) {
    return {
      action: 'noop',
      error: '[plan-attest] No task_plan.md found. Create a plan first.',
    };
  }

  if (mode === 'show') {
    const attestation = checkPlanAttestation(status);
    if (!attestation.enabled) {
      return {
        action: 'display',
        display: `[plan-attest] No attestation set for ${status.planPath}.`,
      };
    }
    return {
      action: 'display',
      display: [
        `Plan: ${status.planPath}`,
        `Attestation: ${attestation.attestationPath}`,
        `SHA-256: ${attestation.expected ?? '<unreadable or invalid>'}`,
        `Actual: ${attestation.actual ?? '<unreadable>'}`,
        `Status: ${attestation.tampered ? 'TAMPERED' : 'valid'}`,
      ].join('\n'),
    };
  }

  if (mode === 'clear') {
    const removed = clearPlanAttestation(status);
    if (removed.length === 0) {
      return {
        action: 'display',
        display: '[plan-attest] No attestation to clear.',
      };
    }
    return {
      action: 'display',
      display: `[plan-attest] Cleared attestation for ${status.planPath}.\nRemoved: ${removed.join(', ')}`,
    };
  }

  if (!status.planSha256) {
    return {
      action: 'noop',
      error: `[plan-attest] Cannot read ${status.planPath}.`,
    };
  }

  const attestationPath = writePlanAttestation(status, status.planSha256);
  return {
    action: 'display',
    display: [
      `Plan: ${status.planPath}`,
      `Attestation: ${attestationPath}`,
      `SHA-256: ${status.planSha256}`,
      'Plan attested.',
    ].join('\n'),
  };
}

function handlePlanExecute(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const status = readPlanStatus(context.state.cwd);
  if (notifySelectionError(status, context.notify)) return { action: 'noop' };
  if (!status.exists) {
    context.notify('warn', 'No active plan (task_plan.md not found)');
    return { action: 'noop' };
  }

  const normalized = commandArguments.trim().toLowerCase();
  if (['clear', 'off', 'reset', 'disable'].includes(normalized)) {
    clearExecution(context.state, context.state.sessionId, status);
    context.notify(
      'info',
      `Plan execution approval cleared: ${summarizePlan(status)}`,
    );
    return { action: 'noop' };
  }

  const attestation = checkPlanAttestation(status);
  if (attestation.tampered) {
    context.notify('error', buildTamperMessage(status));
    return { action: 'noop' };
  }

  approveExecution(context.state, context.state.sessionId, status);
  context.notify(
    'info',
    [
      `Plan execution approved: ${summarizePlan(status)}`,
      `Plan path: ${status.planPath}`,
      'planning-with-files hooks are now active for this session and plan.',
    ].join('\n'),
  );
  return { action: 'noop' };
}

function handlePlanGoal(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const sessionId = context.state.sessionId;
  const normalized = commandArguments.trim();

  if (
    !normalized ||
    ['clear', 'off', 'disable'].includes(normalized.toLowerCase())
  ) {
    context.state.goalBySession.delete(sessionId);
    context.notify('info', 'Plan goal cleared');
    return { action: 'noop' };
  }

  const goal = normalized === 'default' ? DEFAULT_GOAL_CONDITION : normalized;
  context.state.goalBySession.set(sessionId, goal);
  context.notify('info', `Plan goal set: ${goal}`);
  return { action: 'noop' };
}

function handlePlanLoop(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const sessionId = context.state.sessionId;
  const raw = commandArguments.trim();

  if (isStopWord(raw.toLowerCase())) {
    clearSessionLoop(context.state, sessionId);
    context.notify('info', 'plan-loop stopped');
    return { action: 'noop' };
  }

  const parts = raw ? raw.split(/\s+/) : [];
  const maybeInterval = parseIntervalSpec(parts[0]);
  const intervalMs = maybeInterval ?? DEFAULT_LOOP_INTERVAL_MS;
  const prompt = maybeInterval
    ? parts.slice(1).join(' ').trim()
    : parts.join(' ').trim();
  const tickPrompt = prompt || DEFAULT_LOOP_PROMPT;

  const initialStatus = readPlanStatus(context.state.cwd);
  if (notifySelectionError(initialStatus, context.notify)) {
    return { action: 'noop' };
  }
  if (!initialStatus.exists) {
    context.notify('warn', 'No active plan (task_plan.md not found)');
    return { action: 'noop' };
  }

  clearSessionLoop(context.state, sessionId);

  const timer = setInterval(() => {
    try {
      const status = readPlanStatus(context.state.cwd);
      if (!status.exists) return;

      if (isAllPhasesComplete(status) || status.isClosed) {
        clearSessionLoop(context.state, sessionId);
        context.notify(
          'info',
          `[planning-with-files] plan-loop stopped: ${summarizePlan(status)}.`,
        );
        return;
      }

      context.submit(tickPrompt);
    } catch (error) {
      context.log(`plan-loop tick failed: ${errorText(error)}`);
    }
  }, intervalMs);

  context.state.loopTimersBySession.set(sessionId, timer);
  context.notify(
    'info',
    `plan-loop started (${Math.round(intervalMs / 1000)}s)`,
  );
  return { action: 'noop' };
}
