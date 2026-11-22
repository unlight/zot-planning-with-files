import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { clearPlanAttestation } from './attestation.ts';
import { PLAN_CLOSED_MARKER } from './constants.ts';
import { readPlanStatus } from './plan.ts';
import { selectionErrorNotice, summarizePlan } from './runtime.ts';
import { clearPlanApprovals, clearSessionLoop } from './state.ts';
import type { CommandResponse, ProtocolContext } from './types.ts';

function writePlanAtomically(planPath: string, content: string): void {
  const temporaryPath = `${planPath}.pwf-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporaryPath, content, 'utf8');
  try {
    renameSync(temporaryPath, planPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup; rethrow the original rename failure.
    }
    throw error;
  }
}

export function handlePlanClose(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const status = readPlanStatus(context.state.cwd);
  const notice = selectionErrorNotice(status);
  if (notice) {
    context.notify('warn', notice);
    return { action: 'noop' };
  }
  if (!status.exists || !status.planPath) {
    context.notify('warn', 'No active plan (task_plan.md not found)');
    return { action: 'noop' };
  }

  const parts = commandArguments
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const isReopen =
    parts.length === 1 && ['clear', 'open', 'reopen'].includes(parts[0] ?? '');
  const isForce = parts.some(part =>
    ['--force', 'force', '--yes', 'yes'].includes(part),
  );
  const unknown = parts.filter(
    part => !isReopen && !['--force', 'force', '--yes', 'yes'].includes(part),
  );
  if (unknown.length > 0) {
    return {
      action: 'noop',
      error: 'usage: /plan-close [--force] | /plan-close clear',
    };
  }

  const content = readFileSync(status.planPath, 'utf8');
  const closedPattern = /<!--\s*pwf:\s*closed\s*-->/i;

  if (isReopen) {
    if (!closedPattern.test(content)) {
      context.notify('info', `Plan is already open: ${status.planPath}`);
      return { action: 'noop' };
    }
    const next = content.replaceAll(/\n?<!--\s*pwf:\s*closed\s*-->\n?/gi, '\n');
    writePlanAtomically(status.planPath, next);
    clearPlanApprovals(context.state, status);
    clearSessionLoop(context.state, context.state.sessionId);
    context.notify(
      'info',
      `Plan reopened: ${status.planPath}\nRun /plan-attest and /plan-execute to approve it again.`,
    );
    return { action: 'noop' };
  }

  if (closedPattern.test(content)) {
    context.notify('info', `Plan is already closed: ${status.planPath}`);
    return { action: 'noop' };
  }

  if (!isForce && status.completePhases < status.totalPhases) {
    context.notify(
      'warn',
      [
        `[plan-close] Plan is incomplete (${status.completePhases}/${status.totalPhases}).`,
        'Run /plan-close --force to close it anyway.',
      ].join('\n'),
    );
    return { action: 'noop' };
  }

  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  writePlanAtomically(
    status.planPath,
    `${content}${separator}${PLAN_CLOSED_MARKER}\n`,
  );
  clearPlanApprovals(context.state, status);
  clearSessionLoop(context.state, context.state.sessionId);
  const removed = clearPlanAttestation(status);
  context.notify(
    'info',
    [
      `Plan closed: ${summarizePlan(status)}`,
      `Plan path: ${status.planPath}`,
      'Execution approval cleared. Auto-continue stopped.',
      removed.length > 0
        ? 'Attestation cleared because the closed marker changed the plan bytes.'
        : '',
      'Run /plan-close clear to reopen.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return { action: 'noop' };
}
