import { existsSync } from 'node:fs';
import path from 'node:path';
import { readCurrentBranch } from './branch.ts';
import {
  SLUG_RE,
  bindPlanToBranch,
  branchMismatchDetail,
  describeCandidates,
  isWithinRoot,
  listPlanCandidatesAt,
  makeNone,
  makeRoot,
  makeScoped,
  readActivePlanId,
  resolveProjectRoot,
  setActivePlan,
  withCurrentBranch,
} from './plan-paths.ts';
import type { PlanCandidate, PlanPaths } from './types.ts';

function bindAndSelect(
  cwd: string,
  candidate: PlanCandidate,
  branch: string,
): PlanPaths {
  bindPlanToBranch(candidate.paths, branch);
  setActivePlan(cwd, candidate.slug);
  return withCurrentBranch(
    { ...candidate.paths, branch, branchPath: candidate.paths.branchPath },
    branch,
  );
}

export function resolvePlanPaths(sessionCwd: string): PlanPaths {
  const rootResult = resolveProjectRoot(sessionCwd);
  const cwd = rootResult.cwd;
  const currentBranch = readCurrentBranch(cwd);
  if (rootResult.error) {
    return withCurrentBranch(makeNone(cwd, rootResult.error), currentBranch);
  }

  // A set PLAN_ID is a binding, not a hint.
  const planId = process.env.PLAN_ID?.trim();
  if (planId) {
    if (SLUG_RE.test(planId)) {
      const candidate = path.join(cwd, '.planning', planId);
      if (
        existsSync(path.join(candidate, 'task_plan.md')) &&
        isWithinRoot(cwd, candidate)
      ) {
        return withCurrentBranch(makeScoped(cwd, candidate), currentBranch);
      }
    }
    return withCurrentBranch(
      makeNone(cwd, 'plan-selector-rejected'),
      currentBranch,
    );
  }

  const candidates = listPlanCandidatesAt(cwd);
  if (candidates.length === 0) {
    return withCurrentBranch(makeNone(cwd), currentBranch);
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only) return withCurrentBranch(makeNone(cwd), currentBranch);
    if (currentBranch) {
      if (!only.branch) return bindAndSelect(cwd, only, currentBranch);
      if (only.branch !== currentBranch) {
        return withCurrentBranch(
          makeNone(
            cwd,
            'plan-branch-mismatch',
            branchMismatchDetail(candidates, currentBranch),
          ),
          currentBranch,
        );
      }
    }
    return withCurrentBranch(only.paths, currentBranch);
  }

  const activeId = readActivePlanId(cwd);
  const activeCandidate = activeId
    ? candidates.find(candidate => candidate.slug === activeId)
    : undefined;

  if (!currentBranch) {
    const selected = activeCandidate
      ? activeCandidate.paths
      : makeNone(cwd, 'plan-selector-required', describeCandidates(candidates));
    return withCurrentBranch(selected, currentBranch);
  }

  const matching = candidates.filter(
    candidate => candidate.branch === currentBranch,
  );
  const unbound = candidates.filter(candidate => !candidate.branch);
  const others = candidates.filter(
    candidate => candidate.branch && candidate.branch !== currentBranch,
  );

  if (activeCandidate && activeCandidate.branch === currentBranch) {
    return withCurrentBranch(activeCandidate.paths, currentBranch);
  }

  if (matching.length === 1) {
    const only = matching[0];
    return withCurrentBranch(only ? only.paths : makeNone(cwd), currentBranch);
  }

  if (matching.length > 1) {
    return withCurrentBranch(
      makeNone(
        cwd,
        'plan-selector-required',
        describeCandidates(matching, currentBranch),
      ),
      currentBranch,
    );
  }

  if (unbound.length === 1 && others.length === 0) {
    const only = unbound[0];
    return only
      ? bindAndSelect(cwd, only, currentBranch)
      : withCurrentBranch(makeNone(cwd), currentBranch);
  }

  if (unbound.length === 0 && others.length > 0) {
    return withCurrentBranch(
      makeNone(
        cwd,
        'plan-branch-mismatch',
        branchMismatchDetail(candidates, currentBranch),
      ),
      currentBranch,
    );
  }

  if (unbound.length > 0) {
    return withCurrentBranch(
      makeNone(
        cwd,
        'plan-selector-required',
        describeCandidates(candidates, currentBranch),
      ),
      currentBranch,
    );
  }

  return withCurrentBranch(makeNone(cwd), currentBranch);
}

export function resolvePlanPathsForTarget(
  sessionCwd: string,
  target: string,
): PlanPaths | undefined {
  const rootResult = resolveProjectRoot(sessionCwd);
  if (rootResult.error) return undefined;
  const cwd = rootResult.cwd;
  const currentBranch = readCurrentBranch(cwd);

  if (!target || target === 'root') {
    return withCurrentBranch(makeRoot(cwd), currentBranch);
  }
  if (!SLUG_RE.test(target)) return undefined;

  const candidate = path.join(cwd, '.planning', target);
  return existsSync(path.join(candidate, 'task_plan.md')) &&
    isWithinRoot(cwd, candidate)
    ? withCurrentBranch(makeScoped(cwd, candidate), currentBranch)
    : undefined;
}
