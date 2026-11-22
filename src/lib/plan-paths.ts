import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { PlanCandidate, PlanPaths, SelectionError } from './types.ts';

export const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const ANCHOR_WALK_CAP = 10;

export function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readPlanBranch(branchPath: string): string | undefined {
  const value = safeRead(branchPath).trim();
  return value || undefined;
}

// Containment: a scoped candidate must canonicalize under the anchor.
export function isWithinRoot(root: string, candidate: string): boolean {
  let rootReal: string;
  let candReal: string;
  try {
    rootReal = realpathSync(root);
    candReal = realpathSync(candidate);
  } catch {
    return false;
  }
  if (candReal === rootReal) return true;
  return candReal.startsWith(
    rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep,
  );
}

// Walk parents until a directory carries planning state. Stop at .git or the fs root.
export function resolveAnchor(cwd: string): string {
  let directory = cwd;
  for (let depth = 0; depth < ANCHOR_WALK_CAP; depth++) {
    if (
      existsSync(path.join(directory, '.planning')) ||
      existsSync(path.join(directory, 'task_plan.md'))
    ) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory || existsSync(path.join(directory, '.git'))) {
      return cwd;
    }
    directory = parent;
  }
  return cwd;
}

export function makeScoped(cwd: string, planDirectory: string): PlanPaths {
  const branchPath = path.join(planDirectory, '.branch');
  return {
    cwd,
    scope: 'scoped',
    planDir: planDirectory,
    planId: path.basename(planDirectory),
    planPath: path.join(planDirectory, 'task_plan.md'),
    progressPath: path.join(planDirectory, 'progress.md'),
    findingsPath: path.join(planDirectory, 'findings.md'),
    branchPath,
    branch: readPlanBranch(branchPath),
    attestationCandidates: [
      path.join(planDirectory, '.attestation'),
      path.join(cwd, '.plan-attestation'),
    ],
  };
}

export function makeRoot(cwd: string): PlanPaths {
  const branchPath = path.join(cwd, '.plan-branch');
  return {
    cwd,
    scope: 'root',
    planPath: path.join(cwd, 'task_plan.md'),
    progressPath: path.join(cwd, 'progress.md'),
    findingsPath: path.join(cwd, 'findings.md'),
    branchPath,
    branch: readPlanBranch(branchPath),
    attestationCandidates: [path.join(cwd, '.plan-attestation')],
  };
}

export function makeNone(
  cwd: string,
  selectionError?: SelectionError,
  selectionErrorDetail?: string,
): PlanPaths {
  return {
    cwd,
    scope: 'none',
    selectionError,
    selectionErrorDetail,
    attestationCandidates: [path.join(cwd, '.plan-attestation')],
  };
}

export function resolveProjectRoot(sessionCwd: string): {
  cwd: string;
  error?: SelectionError;
} {
  const pinnedRoot = process.env.PWF_PLAN_ROOT?.trim();
  if (!pinnedRoot) return { cwd: resolveAnchor(sessionCwd) };

  // An explicit root pin is a binding: refuse it rather than fall back.
  if (!path.isAbsolute(pinnedRoot)) {
    return { error: 'invalid-plan-root', cwd: path.resolve(sessionCwd) };
  }
  try {
    if (!statSync(pinnedRoot).isDirectory()) {
      return { error: 'invalid-plan-root', cwd: path.resolve(sessionCwd) };
    }
  } catch {
    return { error: 'invalid-plan-root', cwd: path.resolve(sessionCwd) };
  }
  return { cwd: pinnedRoot };
}

export function withCurrentBranch(
  paths: PlanPaths,
  currentBranch?: string,
): PlanPaths {
  return currentBranch ? { ...paths, currentBranch } : paths;
}

export function bindPlanToBranch(paths: PlanPaths, branch: string): void {
  if (!paths.branchPath) return;
  writeFileSync(paths.branchPath, `${branch}\n`, 'utf8');
}

export function setActivePlan(cwd: string, target: string): void {
  const planRoot = path.join(cwd, '.planning');
  if (!existsSync(planRoot)) return;
  writeFileSync(path.join(planRoot, '.active_plan'), `${target}\n`, 'utf8');
}

export function readActivePlanId(cwd: string): string | undefined {
  const value = safeRead(path.join(cwd, '.planning', '.active_plan')).trim();
  if (!value) return undefined;
  return value === 'root' || SLUG_RE.test(value) ? value : undefined;
}

function planMtime(planPath: string): number {
  try {
    return statSync(planPath).mtimeMs;
  } catch {
    return 0;
  }
}

export function listPlanCandidatesAt(cwd: string): PlanCandidate[] {
  const planRoot = path.join(cwd, '.planning');
  const candidates: PlanCandidate[] = [];

  const rootPaths = makeRoot(cwd);
  if (rootPaths.planPath && existsSync(rootPaths.planPath)) {
    candidates.push({
      slug: 'root',
      paths: rootPaths,
      branch: rootPaths.branch,
      mtimeMs: planMtime(rootPaths.planPath),
    });
  }

  try {
    const entries = readdirSync(planRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        !SLUG_RE.test(entry.name)
      ) {
        continue;
      }
      const directory = path.join(planRoot, entry.name);
      const planPath = path.join(directory, 'task_plan.md');
      if (!existsSync(planPath) || !isWithinRoot(cwd, directory)) continue;
      const paths = makeScoped(cwd, directory);
      candidates.push({
        slug: entry.name,
        paths,
        branch: paths.branch,
        mtimeMs: planMtime(planPath),
      });
    }
  } catch {
    // Missing .planning is normal; other read failures yield no scoped plans.
  }

  return candidates.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

export function listPlanCandidates(sessionCwd: string): PlanCandidate[] {
  const rootResult = resolveProjectRoot(sessionCwd);
  return rootResult.error ? [] : listPlanCandidatesAt(rootResult.cwd);
}

function candidateLine(candidate: PlanCandidate): string {
  return `- ${candidate.slug}${candidate.branch ? ` (branch: ${candidate.branch})` : ' (unbound)'}`;
}

export function describeCandidates(
  candidates: PlanCandidate[],
  branch?: string,
): string {
  const heading = branch
    ? `[planning-with-files] Multiple plans are available for branch ${branch}.`
    : '[planning-with-files] Multiple plans are available.';
  return [
    `${heading} Run /plan-list and /plan-use <slug>, or set PLAN_ID; nothing injected.`,
    ...candidates.map(candidate => candidateLine(candidate)),
  ].join('\n');
}

export function branchMismatchDetail(
  candidates: PlanCandidate[],
  branch: string,
): string {
  return [
    `[planning-with-files] No plan is bound to branch ${branch}. Run /plan-list and /plan-use <slug>; nothing injected.`,
    ...candidates.map(candidate => candidateLine(candidate)),
  ].join('\n');
}
