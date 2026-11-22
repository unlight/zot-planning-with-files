import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolvePlanPaths } from './plan-select.ts';
import type { PlanPaths, PlanStatus } from './types.ts';

export { SLUG_RE } from './plan-paths.ts';
export { resolveAnchor } from './plan-paths.ts';
export { resolvePlanPaths, resolvePlanPathsForTarget } from './plan-select.ts';
export {
  bindPlanToBranch,
  listPlanCandidates,
  setActivePlan,
} from './plan-paths.ts';
export type { PlanCandidate } from './types.ts';

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
      blockedPhases: 0,
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
  const statusBlocked = /\*\*Status:\*\*\s*blocked\b/i;
  let totalPhases = 0;
  let completePhases = 0;
  let inProgressPhases = 0;
  let pendingPhases = 0;
  let blockedPhases = 0;
  for (const line of lines) {
    if (phaseRegex.test(line)) totalPhases += 1;
    if (statusComplete.test(line)) completePhases += 1;
    else if (statusInProgress.test(line)) inProgressPhases += 1;
    else if (statusPending.test(line)) pendingPhases += 1;
    else if (statusBlocked.test(line)) blockedPhases += 1;
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
    exists: planBytes !== undefined,
    planSha256,
    attestationPath,
    isClosed,
    totalPhases,
    completePhases,
    inProgressPhases,
    pendingPhases,
    blockedPhases,
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

export function shouldAutoContinue(status: PlanStatus): boolean {
  return (
    status.exists &&
    !status.isClosed &&
    status.totalPhases > 0 &&
    status.inProgressPhases > 0
  );
}
