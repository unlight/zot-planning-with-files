import { readCurrentBranch } from './branch.ts';
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
} from './state.ts';
import type { CommandResponse, ProtocolContext } from './types.ts';

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
    'slug\tbranch\tclosed\tphases\tmtime',
  ];
  for (const candidate of candidates) {
    const status = readPlanStatus(context.state.cwd, candidate.paths);
    const marker = branch && candidate.branch === branch ? '*' : ' ';
    lines.push(
      `${marker}${candidate.slug}\t${candidate.branch ?? 'unbound'}\t${status.isClosed ? 'yes' : 'no'}\t${status.completePhases}/${status.totalPhases}\t${new Date(candidate.mtimeMs).toISOString()}`,
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
