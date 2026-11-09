import { readFileSync } from 'node:fs';
import { checkPlanAttestation } from './attestation.ts';
import { readPlanStatus } from './plan.ts';
import {
  deriveEffectiveMode,
  resolveConfiguredMode,
  selectionErrorNotice,
} from './runtime.ts';
import { isExecutionApproved } from './state.ts';
import type { CommandResponse, PlanStatus, ProtocolContext } from './types.ts';

export function handlePwf(commandArguments: string): CommandResponse {
  const task =
    commandArguments.trim() ||
    'Start the planning-with-files workflow for this project.';

  return {
    action: 'tool_prompt',
    prompt: task,
    tool_name: 'skill',
    tool_args: { name: 'planning-with-files' },
  };
}

function currentPhaseName(status: PlanStatus): string {
  if (!status.planPath) return 'none';

  try {
    const content = readFileSync(status.planPath, 'utf8');
    let heading = '';

    for (const line of content.split('\n')) {
      if (/^###\s+/.test(line)) heading = line.replace(/^###\s+/, '').trim();
      if (
        /\*\*Status:\*\*\s*in_progress\b/i.test(line) ||
        /\[in_progress\]/i.test(line)
      ) {
        return heading || 'none';
      }
    }

    const section = content.match(/^##\s+Current Phase\s*\n+([^\n#]+)/im);
    return section?.[1]?.trim() ?? 'none';
  } catch {
    return 'none';
  }
}

export function handlePwfStatus(context: ProtocolContext): CommandResponse {
  const status = readPlanStatus(context.state.cwd);
  const notice = selectionErrorNotice(status);
  if (notice) {
    context.notify('warn', notice);
    return { action: 'noop' };
  }

  if (!status.exists) {
    return {
      action: 'display',
      display:
        'No planning files found. Run /pwf to start a new planning session.',
    };
  }

  const attestation = checkPlanAttestation(status);
  const mode = deriveEffectiveMode(
    resolveConfiguredMode(status.cwd),
    context.state.host,
  );
  const isApproved = isExecutionApproved(
    context.state,
    context.state.sessionId,
    status,
  );
  const lines = [
    'Planning status',
    `Plan: ${status.planId ?? 'root'} (${status.planPath})`,
    `Scope: ${status.scope}`,
    `Mode: ${mode}`,
    `Attestation: ${attestation.enabled ? (attestation.tampered ? 'TAMPERED' : 'valid') : 'not recorded'}`,
    `Execution: ${isApproved ? 'active' : 'passive (run /plan-execute)'}`,
    `Current: ${currentPhaseName(status)}`,
    `Phases: ${status.completePhases}/${status.totalPhases} complete, ${status.inProgressPhases} in progress, ${status.pendingPhases} pending`,
  ];

  return { action: 'display', display: lines.join('\n') };
}
