import { readCurrentBranch } from './branch.ts';
import { checkPlanAttestation } from './attestation.ts';
import {
  bindPlanToBranch,
  listPlanCandidates,
  readPlanStatus,
  resolvePlanPathsForTarget,
  setActivePlan,
} from './plan.ts';
import {
  clearPlanApprovals,
  clearSessionAutoContinue,
  clearSessionLoop,
  isExecutionApproved,
} from './state.ts';
import { logSelection, selectionErrorNotice } from './runtime.ts';
import type { CommandResponse, PlanStatus, ProtocolContext } from './types.ts';

export function handlePlanStatus(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const raw = commandArguments.trim();
  let target: string | undefined;
  if (raw) {
    const parts = raw.split(/\s+/);
    if (parts.length === 1 && !parts[0]?.startsWith('-')) {
      target = parts[0];
    } else if (parts.length === 2 && parts[0] === '--target') {
      target = parts[1];
    } else if (parts.length === 1 && parts[0]?.startsWith('--target=')) {
      target = parts[0].slice('--target='.length);
    }
  }
  if (raw && !target) {
    return {
      action: 'noop',
      error: 'usage: /plan-status [<slug|root>] [--target <slug|root>]',
    };
  }

  let status: PlanStatus;
  if (target) {
    const paths = resolvePlanPathsForTarget(context.state.cwd, target);
    if (!paths) {
      return {
        action: 'noop',
        error: `[plan-status] ${target} did not resolve to a plan.`,
      };
    }
    status = readPlanStatus(context.state.cwd, paths);
    logSelection(context, status);
    if (!status.exists) {
      return {
        action: 'noop',
        error: `[plan-status] ${target} does not contain task_plan.md.`,
      };
    }
  } else {
    status = readPlanStatus(context.state.cwd);
    logSelection(context, status);
    const notice = selectionErrorNotice(status);
    if (notice) {
      context.notify('warn', notice);
      return { action: 'noop' };
    }
    if (!status.exists) {
      context.notify('warn', 'No active plan (task_plan.md not found)');
      return { action: 'noop' };
    }
  }

  const attestation = checkPlanAttestation(status);
  const isApproved = isExecutionApproved(
    context.state,
    context.state.sessionId,
    status,
  );
  const lines: string[] = [
    ...(target ? [`View: ${target} (read-only)`] : []),
    `Plan path: ${status.planPath}`,
    `Scope: ${status.scope}`,
    ...(status.planId ? [`Plan ID: ${status.planId}`] : []),
    ...(status.currentBranch
      ? [`Current branch: ${status.currentBranch}`]
      : []),
    ...(status.branch ? [`Plan branch: ${status.branch}`] : []),
    `Phases: ${status.totalPhases}`,
    `Complete: ${status.completePhases}`,
    `In progress: ${status.inProgressPhases}`,
    `Pending: ${status.pendingPhases}`,
    `Blocked: ${status.blockedPhases}`,
    `Attestation: ${attestation.enabled ? (attestation.tampered ? 'TAMPERED' : 'valid') : 'not recorded'}`,
    `Closed: ${status.isClosed ? 'yes' : 'no'}`,
    `Execution: ${status.isClosed ? 'closed' : isApproved ? 'active' : 'passive (run /plan-execute)'}`,
  ];
  return { action: 'display', display: lines.join('\n') };
}

export function handlePlanList(context: ProtocolContext): CommandResponse {
  const branch = readCurrentBranch(context.state.cwd);
  const candidates = listPlanCandidates(context.state.cwd);
  if (candidates.length === 0) {
    context.log(`plan-list current=${branch ?? 'none'} plans=0`);
    return { action: 'display', display: '[plan-list] No plans found.' };
  }
  context.log(
    `plan-list current=${branch ?? 'none'} plans=${candidates.length} archived=${candidates.filter(candidate => candidate.archived).length}`,
  );

  const lines = [
    `Current branch: ${branch ?? 'none'}`,
    '',
    'slug\tbranch\tclosed\tphases\tmtime\tstate',
  ];
  for (const candidate of candidates) {
    const status = readPlanStatus(context.state.cwd, candidate.paths);
    const marker =
      branch && !candidate.archived && candidate.branch === branch ? '*' : ' ';
    lines.push(
      `${marker}${candidate.slug}\t${candidate.branch ?? 'unbound'}\t${status.isClosed ? 'yes' : 'no'}\t${status.completePhases}/${status.totalPhases}\t${new Date(candidate.mtimeMs).toISOString()}\t${candidate.archived ? 'archived' : 'live'}`,
    );
  }
  lines.push('', '* = current branch');
  return { action: 'display', display: lines.join('\n') };
}

export function handlePlanUse(
  commandArguments: string,
  context: ProtocolContext,
): CommandResponse {
  const target = commandArguments.trim();
  if (!target) {
    return { action: 'noop', error: 'usage: /plan-use <slug|root>' };
  }

  const paths = resolvePlanPathsForTarget(context.state.cwd, target);
  if (!paths) {
    return {
      action: 'noop',
      error: `[plan-use] ${target} did not resolve to a plan. Nothing was selected.`,
    };
  }

  const status = readPlanStatus(context.state.cwd, paths);
  if (!status.exists) {
    return {
      action: 'noop',
      error: `[plan-use] ${target} does not contain task_plan.md. Nothing was selected.`,
    };
  }

  const branch = readCurrentBranch(context.state.cwd);
  context.log(
    `plan-use target=${target} branch=${branch ?? 'none'} scope=${status.scope} plan=${status.planId ?? 'none'}`,
  );
  const previousBranch = paths.branch;
  if (branch) bindPlanToBranch(paths, branch);
  setActivePlan(context.state.cwd, target);
  clearPlanApprovals(context.state, status);
  clearSessionAutoContinue(context.state, context.state.sessionId);
  clearSessionLoop(context.state, context.state.sessionId);
  context.notify(
    'info',
    [
      `Plan selected: ${target}`,
      `Plan path: ${status.planPath}`,
      branch ? `Branch: ${branch}` : 'Branch: none (git not detected)',
      previousBranch && branch && previousBranch !== branch
        ? `Rebound from branch ${previousBranch} to ${branch}.`
        : '',
      status.isClosed
        ? 'Plan is closed. Run /plan-close clear to reopen.'
        : 'Run /plan-execute to approve it.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return { action: 'noop' };
}
