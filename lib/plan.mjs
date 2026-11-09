import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const ANCHOR_WALK_CAP = 10;

function safeRead(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function selectAttestationPath(candidates) {
  for (const candidate of candidates) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      // Only absence allows a fallback; other lookup errors fail closed.
      if (error?.code !== "ENOENT") return candidate;
    }
  }
  return undefined;
}

// Flatten wall-clock times so identical plans produce identical bytes.
export function normalizeWallClock(text) {
  return text
    .replace(/T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z/g, "T00:00:00Z")
    .replace(
      /T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([+-][0-9]{2}:[0-9]{2})/g,
      "T00:00:00$2",
    );
}

function resolveNewestPlanDir(planRoot) {
  if (!existsSync(planRoot)) return undefined;

  const dirs = readdirSync(planRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && SLUG_RE.test(entry.name))
    .map((entry) => join(planRoot, entry.name))
    .filter((dir) => existsSync(join(dir, "task_plan.md")))
    .map((dir) => {
      let mtime = 0;
      try {
        // Rank by task_plan.md mtime: editing a plan does not bump the dir mtime.
        mtime = statSync(join(dir, "task_plan.md")).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return dirs[0]?.dir;
}

function sessionIsolationState(cwd) {
  try {
    const sessions = lstatSync(join(cwd, ".planning", "sessions"));
    return sessions.isDirectory() && !sessions.isSymbolicLink() ? "armed" : "invalid";
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "invalid";
  }
}

function isSessionIsolationArmed(cwd) {
  return sessionIsolationState(cwd) === "armed";
}

function hasMultipleLivePlans(cwd, planRoot) {
  let count = existsSync(join(cwd, "task_plan.md")) ? 1 : 0;

  try {
    for (const entry of readdirSync(planRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !SLUG_RE.test(entry.name)) continue;
      const candidate = join(planRoot, entry.name);
      if (!existsSync(join(candidate, "task_plan.md")) || !isWithinRoot(cwd, candidate)) continue;
      count += 1;
      if (count > 1) return true;
    }
  } catch {
    return true;
  }

  return false;
}

// Containment: a scoped candidate must canonicalize under the anchor.
function isWithinRoot(root, candidate) {
  let rootReal;
  let candReal;
  try {
    rootReal = realpathSync(root);
    candReal = realpathSync(candidate);
  } catch {
    return false;
  }
  if (candReal === rootReal) return true;
  return candReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

// Walk parents until a directory carries planning state. Stop at .git or the fs root.
export function resolveAnchor(cwd) {
  let dir = cwd;
  for (let depth = 0; depth < ANCHOR_WALK_CAP; depth++) {
    if (existsSync(join(dir, ".planning")) || existsSync(join(dir, "task_plan.md"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) {
      return cwd;
    }
    dir = parent;
  }
  return cwd;
}

function makeScoped(cwd, planDir) {
  return {
    cwd,
    scope: "scoped",
    planDir,
    planId: basename(planDir),
    planPath: join(planDir, "task_plan.md"),
    progressPath: join(planDir, "progress.md"),
    findingsPath: join(planDir, "findings.md"),
    attestationCandidates: [join(planDir, ".attestation"), join(cwd, ".plan-attestation")],
  };
}

function makeRoot(cwd) {
  return {
    cwd,
    scope: "root",
    planPath: join(cwd, "task_plan.md"),
    progressPath: join(cwd, "progress.md"),
    findingsPath: join(cwd, "findings.md"),
    attestationCandidates: [join(cwd, ".plan-attestation")],
  };
}

function makeNone(cwd, selectionError) {
  return {
    cwd,
    scope: "none",
    selectionError,
    attestationCandidates: [join(cwd, ".plan-attestation")],
  };
}

function resolveProjectRoot(sessionCwd) {
  const pinnedRoot = process.env.PWF_PLAN_ROOT?.trim();
  if (!pinnedRoot) return { cwd: resolveAnchor(sessionCwd) };

  // An explicit root pin is a binding: refuse it rather than fall back.
  if (!isAbsolute(pinnedRoot)) {
    return { error: "invalid-plan-root", cwd: resolve(sessionCwd) };
  }
  try {
    if (!statSync(pinnedRoot).isDirectory()) {
      return { error: "invalid-plan-root", cwd: resolve(sessionCwd) };
    }
  } catch {
    return { error: "invalid-plan-root", cwd: resolve(sessionCwd) };
  }
  return { cwd: pinnedRoot };
}

export function resolvePlanPaths(sessionCwd) {
  const rootResult = resolveProjectRoot(sessionCwd);
  const cwd = rootResult.cwd;
  if (rootResult.error) return makeNone(cwd, rootResult.error);

  const planRoot = join(cwd, ".planning");

  // A set PLAN_ID is a binding, not a hint.
  const planId = process.env.PLAN_ID?.trim();
  if (planId) {
    if (SLUG_RE.test(planId)) {
      const candidate = join(planRoot, planId);
      if (existsSync(join(candidate, "task_plan.md")) && isWithinRoot(cwd, candidate)) {
        return makeScoped(cwd, candidate);
      }
    }
    return makeNone(cwd, "plan-selector-rejected");
  }

  // With isolation armed, the shared pointer cannot select a plan.
  if (isSessionIsolationArmed(cwd) && hasMultipleLivePlans(cwd, planRoot)) {
    return makeNone(cwd, "session-plan-ambiguous");
  }

  const activePlanFile = join(planRoot, ".active_plan");
  if (existsSync(activePlanFile)) {
    const activePlanId = safeRead(activePlanFile).trim();
    if (activePlanId && SLUG_RE.test(activePlanId)) {
      const candidate = join(planRoot, activePlanId);
      if (existsSync(join(candidate, "task_plan.md")) && isWithinRoot(cwd, candidate)) {
        return makeScoped(cwd, candidate);
      }
    }
  }

  const newest = resolveNewestPlanDir(planRoot);
  if (newest && isWithinRoot(cwd, newest)) {
    return makeScoped(cwd, newest);
  }

  const rootPlan = makeRoot(cwd);
  if (existsSync(rootPlan.planPath)) return rootPlan;

  return makeNone(cwd);
}

export function resolvePlanPathsForTarget(sessionCwd, target) {
  const rootResult = resolveProjectRoot(sessionCwd);
  const cwd = rootResult.cwd;
  if (rootResult.error) return undefined;

  if (!target || target === "root") return makeRoot(cwd);
  if (!SLUG_RE.test(target)) return undefined;

  const candidate = join(cwd, ".planning", target);
  if (!existsSync(join(candidate, "task_plan.md")) || !isWithinRoot(cwd, candidate)) {
    return undefined;
  }
  return makeScoped(cwd, candidate);
}

export function readPlanStatus(cwd, pathsOverride) {
  const paths = pathsOverride ?? resolvePlanPaths(cwd);
  if (!paths.planPath) {
    return {
      ...paths,
      exists: false,
      closed: false,
      totalPhases: 0,
      completePhases: 0,
      inProgressPhases: 0,
      pendingPhases: 0,
      firstLines50: "",
      headLines30: "",
      progressTail20: "",
    };
  }

  const attestationPath = selectAttestationPath(paths.attestationCandidates);
  let planBytes;
  try {
    planBytes = readFileSync(paths.planPath);
  } catch {
    // Keep the selected path and attestation, but no digest.
    planBytes = undefined;
  }

  const planSha256 =
    planBytes === undefined ? undefined : createHash("sha256").update(planBytes).digest("hex");
  const planContent =
    planBytes === undefined ? "" : planBytes.toString("utf-8").replace(/\r\n/g, "\n");
  const closed = /<!--\s*pwf:\s*closed\s*-->/i.test(planContent);
  const lines = planContent.split("\n");

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

  let progressTail20 = "";
  if (paths.progressPath && existsSync(paths.progressPath)) {
    const progressLines = safeRead(paths.progressPath).replace(/\r\n/g, "\n").split("\n");
    progressTail20 = normalizeWallClock(progressLines.slice(-20).join("\n"));
  }

  return {
    ...paths,
    exists: true,
    planSha256,
    attestationPath,
    closed,
    totalPhases,
    completePhases,
    inProgressPhases,
    pendingPhases,
    firstLines50: lines.slice(0, 50).join("\n"),
    headLines30: lines.slice(0, 30).join("\n"),
    progressTail20,
  };
}

export function isAllPhasesComplete(status) {
  return status.exists && status.totalPhases > 0 && status.completePhases >= status.totalPhases;
}

export function isPlanIncomplete(status) {
  return status.exists && status.totalPhases > 0 && status.completePhases < status.totalPhases;
}

export function isSessionAttached(cwd, sessionId) {
  const sessionsDir = join(cwd, ".planning", "sessions");
  if (sessionIsolationState(cwd) === "absent") return true;
  if (!isSessionIsolationArmed(cwd)) return false;
  if (!sessionId) return false;
  return existsSync(join(sessionsDir, `${sessionId}.attached`));
}
