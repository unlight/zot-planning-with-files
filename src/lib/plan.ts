import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { PlanPaths, PlanStatus, SelectionError } from './types.ts';

export const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const ANCHOR_WALK_CAP = 10;

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function selectAttestationPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      // Only absence allows a fallback; other lookup errors fail closed.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return candidate;
    }
  }
  return undefined;
}

// Flatten wall-clock times so identical plans produce identical bytes.
export function normalizeWallClock(text: string): string {
  return text
    .replaceAll(/T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z/g, 'T00:00:00Z')
    .replaceAll(
      /T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([+-][0-9]{2}:[0-9]{2})/g,
      'T00:00:00$2',
    );
}

function resolveNewestPlanDirectory(planRoot: string): string | undefined {
  if (!existsSync(planRoot)) return undefined;

  const directories = readdirSync(planRoot, { withFileTypes: true })
    .filter(
      entry =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        SLUG_RE.test(entry.name),
    )
    .map(entry => path.join(planRoot, entry.name))
    .filter(directory => existsSync(path.join(directory, 'task_plan.md')))
    .map(directory => {
      let mtime = 0;
      try {
        // Rank by task_plan.md mtime: editing a plan does not bump the dir mtime.
        mtime = statSync(path.join(directory, 'task_plan.md')).mtimeMs;
      } catch {
        // Keep the zero default when the file disappears between checks.
      }
      return { directory, mtime };
    })
    .toSorted((a, b) => b.mtime - a.mtime);

  return directories[0]?.directory;
}

function sessionIsolationState(cwd: string): 'absent' | 'armed' | 'invalid' {
  try {
    const sessions = lstatSync(path.join(cwd, '.planning', 'sessions'));
    return sessions.isDirectory() && !sessions.isSymbolicLink()
      ? 'armed'
      : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : 'invalid';
  }
}

function isSessionIsolationArmed(cwd: string): boolean {
  return sessionIsolationState(cwd) === 'armed';
}

function hasMultipleLivePlans(cwd: string, planRoot: string): boolean {
  let count = existsSync(path.join(cwd, 'task_plan.md')) ? 1 : 0;

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
      const candidate = path.join(planRoot, entry.name);
      if (
        !existsSync(path.join(candidate, 'task_plan.md')) ||
        !isWithinRoot(cwd, candidate)
      ) {
        continue;
      }
      count += 1;
      if (count > 1) return true;
    }
  } catch {
    return true;
  }

  return false;
}

// Containment: a scoped candidate must canonicalize under the anchor.
function isWithinRoot(root: string, candidate: string): boolean {
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

function makeScoped(cwd: string, planDirectory: string): PlanPaths {
  return {
    cwd,
    scope: 'scoped',
    planDir: planDirectory,
    planId: path.basename(planDirectory),
    planPath: path.join(planDirectory, 'task_plan.md'),
    progressPath: path.join(planDirectory, 'progress.md'),
    findingsPath: path.join(planDirectory, 'findings.md'),
    attestationCandidates: [
      path.join(planDirectory, '.attestation'),
      path.join(cwd, '.plan-attestation'),
    ],
  };
}

function makeRoot(cwd: string): PlanPaths {
  return {
    cwd,
    scope: 'root',
    planPath: path.join(cwd, 'task_plan.md'),
    progressPath: path.join(cwd, 'progress.md'),
    findingsPath: path.join(cwd, 'findings.md'),
    attestationCandidates: [path.join(cwd, '.plan-attestation')],
  };
}

function makeNone(cwd: string, selectionError?: SelectionError): PlanPaths {
  return {
    cwd,
    scope: 'none',
    selectionError,
    attestationCandidates: [path.join(cwd, '.plan-attestation')],
  };
}

function resolveProjectRoot(sessionCwd: string): {
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

export function resolvePlanPaths(sessionCwd: string): PlanPaths {
  const rootResult = resolveProjectRoot(sessionCwd);
  const cwd = rootResult.cwd;
  if (rootResult.error) return makeNone(cwd, rootResult.error);

  const planRoot = path.join(cwd, '.planning');

  // A set PLAN_ID is a binding, not a hint.
  const planId = process.env.PLAN_ID?.trim();
  if (planId) {
    if (SLUG_RE.test(planId)) {
      const candidate = path.join(planRoot, planId);
      if (
        existsSync(path.join(candidate, 'task_plan.md')) &&
        isWithinRoot(cwd, candidate)
      ) {
        return makeScoped(cwd, candidate);
      }
    }
    return makeNone(cwd, 'plan-selector-rejected');
  }

  // With isolation armed, the shared pointer cannot select a plan.
  if (isSessionIsolationArmed(cwd) && hasMultipleLivePlans(cwd, planRoot)) {
    return makeNone(cwd, 'session-plan-ambiguous');
  }

  const activePlanFile = path.join(planRoot, '.active_plan');
  if (existsSync(activePlanFile)) {
    const activePlanId = safeRead(activePlanFile).trim();
    if (activePlanId && SLUG_RE.test(activePlanId)) {
      const candidate = path.join(planRoot, activePlanId);
      if (
        existsSync(path.join(candidate, 'task_plan.md')) &&
        isWithinRoot(cwd, candidate)
      ) {
        return makeScoped(cwd, candidate);
      }
    }
  }

  const newest = resolveNewestPlanDirectory(planRoot);
  if (newest && isWithinRoot(cwd, newest)) {
    return makeScoped(cwd, newest);
  }

  const rootPlan = makeRoot(cwd);
  return rootPlan.planPath && existsSync(rootPlan.planPath)
    ? rootPlan
    : makeNone(cwd);
}

export function resolvePlanPathsForTarget(
  sessionCwd: string,
  target: string,
): PlanPaths | undefined {
  const rootResult = resolveProjectRoot(sessionCwd);
  if (rootResult.error) return undefined;
  const cwd = rootResult.cwd;

  if (!target || target === 'root') return makeRoot(cwd);
  if (!SLUG_RE.test(target)) return undefined;

  const candidate = path.join(cwd, '.planning', target);
  return existsSync(path.join(candidate, 'task_plan.md')) &&
    isWithinRoot(cwd, candidate)
    ? makeScoped(cwd, candidate)
    : undefined;
}

export function readPlanStatus(
  cwd: string,
  pathsOverride?: PlanPaths,
): PlanStatus {
  const paths = pathsOverride ?? resolvePlanPaths(cwd);
  const planPath = paths.planPath;

  if (!planPath) {
    return {
      ...paths,
      exists: false,
      isClosed: false,
      totalPhases: 0,
      completePhases: 0,
      inProgressPhases: 0,
      pendingPhases: 0,
      firstLines50: '',
      headLines30: '',
      progressTail20: '',
    };
  }

  const attestationPath = selectAttestationPath(paths.attestationCandidates);
  let planBytes: Buffer | undefined;
  try {
    planBytes = readFileSync(planPath);
  } catch {
    // Keep the selected path and attestation, but no digest.
    planBytes = undefined;
  }

  const planSha256 =
    planBytes === undefined
      ? undefined
      : createHash('sha256').update(planBytes).digest('hex');
  const planContent =
    planBytes === undefined
      ? ''
      : planBytes.toString('utf8').replaceAll('\r\n', '\n');
  const isClosed = /<!--\s*pwf:\s*closed\s*-->/i.test(planContent);
  const lines = planContent.split('\n');

  const phaseRegex = /^###\s+Phase\b/i;
  const statusComplete = /\*\*Status:\*\*\s*complete\b/i;
  const statusInProgress = /\*\*Status:\*\*\s*in_progress\b/i;
  const statusPending = /\*\*Status:\*\*\s*pending\b/i;

  let totalPhases = 0;
  let completePhases = 0;
  let inProgressPhases = 0;
  let pendingPhases = 0;

  for (const line of lines) {
    if (phaseRegex.test(line)) totalPhases += 1;
    if (statusComplete.test(line)) completePhases += 1;
    else if (statusInProgress.test(line)) inProgressPhases += 1;
    else if (statusPending.test(line)) pendingPhases += 1;
  }

  if (completePhases + inProgressPhases + pendingPhases === 0) {
    completePhases = (planContent.match(/\[complete\]/gi) || []).length;
    inProgressPhases = (planContent.match(/\[in_progress\]/gi) || []).length;
    pendingPhases = (planContent.match(/\[pending\]/gi) || []).length;
  }

  let progressTail20 = '';
  if (paths.progressPath && existsSync(paths.progressPath)) {
    const progressLines = safeRead(paths.progressPath)
      .replaceAll('\r\n', '\n')
      .split('\n');
    progressTail20 = normalizeWallClock(progressLines.slice(-20).join('\n'));
  }

  return {
    ...paths,
    exists: true,
    planSha256,
    attestationPath,
    isClosed,
    totalPhases,
    completePhases,
    inProgressPhases,
    pendingPhases,
    firstLines50: lines.slice(0, 50).join('\n'),
    headLines30: lines.slice(0, 30).join('\n'),
    progressTail20,
  };
}

export function isAllPhasesComplete(status: PlanStatus): boolean {
  return (
    status.exists &&
    status.totalPhases > 0 &&
    status.completePhases >= status.totalPhases
  );
}

export function isPlanIncomplete(status: PlanStatus): boolean {
  return (
    status.exists &&
    status.totalPhases > 0 &&
    status.completePhases < status.totalPhases
  );
}

export function isSessionAttached(
  cwd: string,
  sessionId: string | undefined,
): boolean {
  const sessionsDirectory = path.join(cwd, '.planning', 'sessions');
  if (sessionIsolationState(cwd) === 'absent') return true;
  if (!sessionId || !isSessionIsolationArmed(cwd)) return false;
  return existsSync(path.join(sessionsDirectory, `${sessionId}.attached`));
}
