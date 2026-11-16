import { readFileSync, writeFileSync } from 'node:fs';
import { clearPlanAttestation } from './attestation.ts';
import { PLAN_CLOSED_MARKER } from './constants.ts';
import { readPlanStatus } from './plan.ts';
import { selectionErrorNotice, summarizePlan } from './runtime.ts';
import { clearPlanApprovals, clearSessionLoop } from './state.ts';
import type { CommandResponse, ProtocolContext } from './types.ts';

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

  const normalized = commandArguments.trim().toLowerCase();
  const isReopen = ['clear', 'open', 'reopen'].includes(normalized);
  const content = readFileSync(status.planPath, 'utf8');
  const closedPattern = /<!--\s*pwf:\s*closed\s*-->/i;

  if (isReopen) {
    if (!closedPattern.test(content)) {
      context.notify('info', `Plan is already open: ${status.planPath}`);
      return { action: 'noop' };
    }
    const next = content.replaceAll(/\n?<!--\s*pwf:\s*closed\s*-->\n?/gi, '\n');
    writeFileSync(status.planPath, next, 'utf8');
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

  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(
    status.planPath,
    `${content}${separator}${PLAN_CLOSED_MARKER}\n`,
    'utf8',
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
