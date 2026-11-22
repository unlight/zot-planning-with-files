import { existsSync } from 'node:fs';
import path from 'node:path';
import { readCurrentBranch } from './branch.ts';
import {
  SLUG_RE,
  archiveSelectionDetail,
  bindPlanToBranch,
  branchMismatchDetail,
  describeCandidates,
  isWithinRoot,
  listArchivedCandidatesAt,
  listPlanCandidatesAt,
  makeNone,
  makeScoped,
  readActivePlanId,
  resolveProjectRoot,
  setActivePlan,
  withCurrentBranch,
} from './plan-paths.ts';
import type { PlanCandidate, PlanPaths } from './types.ts';

function mark(paths: PlanPaths, reason: string): PlanPaths {
  return { ...paths, selectionReason: reason };
}

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
    return mark(
      withCurrentBranch(makeNone(cwd, rootResult.error), currentBranch),
      'invalid-plan-root',
    );
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
        return mark(
          withCurrentBranch(makeScoped(cwd, candidate), currentBranch),
          'plan-id',
        );
      }
    }
    return mark(
      withCurrentBranch(makeNone(cwd, 'plan-selector-rejected'), currentBranch),
      'plan-id-rejected',
    );
  }

  const candidates = listPlanCandidatesAt(cwd);
  if (candidates.length === 0) {
    return mark(withCurrentBranch(makeNone(cwd), currentBranch), 'no-plan');
  }

  const activeId = readActivePlanId(cwd);
  const activeCandidate = activeId
    ? candidates.find(candidate => candidate.slug === activeId)
    : undefined;

  const archived = listArchivedCandidatesAt(cwd);
  if (!activeCandidate && archived.length > 0) {
    const detail = archiveSelectionDetail(candidates, archived);
    const paths = makeNone(cwd, 'plan-selector-required', detail);
    return mark(
      withCurrentBranch(paths, currentBranch),
      'archived-selection-required',
    );
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only) {
      return mark(withCurrentBranch(makeNone(cwd), currentBranch), 'none');
    }
    if (currentBranch) {
      if (!only.branch) {
        return mark(
          bindAndSelect(cwd, only, currentBranch),
          'single-unbound-bound',
        );
      }
      if (only.branch !== currentBranch) {
        const detail = branchMismatchDetail(candidates, currentBranch);
        const paths = makeNone(cwd, 'plan-branch-mismatch', detail);
        return mark(
          withCurrentBranch(paths, currentBranch),
          'single-branch-mismatch',
        );
      }
    }
    return mark(
      withCurrentBranch(only.paths, currentBranch),
      currentBranch ? 'single-branch' : 'single-candidate',
    );
  }

  if (!currentBranch) {
    const selected = activeCandidate
      ? activeCandidate.paths
      : makeNone(cwd, 'plan-selector-required', describeCandidates(candidates));
    return mark(
      withCurrentBranch(selected, currentBranch),
      activeCandidate ? 'active-plan-no-git' : 'selector-required-no-git',
    );
  }

  const matching = candidates.filter(
    candidate => candidate.branch === currentBranch,
  );
  const unbound = candidates.filter(candidate => !candidate.branch);
  const others = candidates.filter(
    candidate => candidate.branch && candidate.branch !== currentBranch,
  );

  if (activeCandidate && activeCandidate.branch === currentBranch) {
    return mark(
      withCurrentBranch(activeCandidate.paths, currentBranch),
      'active-plan',
    );
  }

  if (matching.length === 1) {
    const only = matching[0];
    return mark(
      withCurrentBranch(only ? only.paths : makeNone(cwd), currentBranch),
      'single-matching-branch',
    );
  }

  if (matching.length > 1) {
    const detail = describeCandidates(matching, currentBranch);
    const paths = makeNone(cwd, 'plan-selector-required', detail);
    return mark(withCurrentBranch(paths, currentBranch), 'multiple-matching');
  }

  if (unbound.length === 1 && others.length === 0) {
    const only = unbound[0];
    return mark(
      only
        ? bindAndSelect(cwd, only, currentBranch)
        : withCurrentBranch(makeNone(cwd), currentBranch),
      'single-unbound-bound',
    );
  }

  if (unbound.length === 0 && others.length > 0) {
    const detail = branchMismatchDetail(candidates, currentBranch);
    const paths = makeNone(cwd, 'plan-branch-mismatch', detail);
    return mark(withCurrentBranch(paths, currentBranch), 'branch-mismatch');
  }

  if (unbound.length > 0) {
    const detail = describeCandidates(candidates, currentBranch);
    const paths = makeNone(cwd, 'plan-selector-required', detail);
    return mark(withCurrentBranch(paths, currentBranch), 'selector-required');
  }

  return mark(withCurrentBranch(makeNone(cwd), currentBranch), 'none');
}

export function resolvePlanPathsForTarget(
  sessionCwd: string,
  target: string,
): PlanPaths | undefined {
  const rootResult = resolveProjectRoot(sessionCwd);
  if (
    !target ||
    target === 'root' ||
    !SLUG_RE.test(target) ||
    rootResult.error
  ) {
    return undefined;
  }
  const cwd = rootResult.cwd;
  const currentBranch = readCurrentBranch(cwd);

  const candidate = path.join(cwd, '.planning', target);
  return existsSync(path.join(candidate, 'task_plan.md')) &&
    isWithinRoot(cwd, candidate)
    ? mark(
        withCurrentBranch(makeScoped(cwd, candidate), currentBranch),
        'target',
      )
    : undefined;
}
