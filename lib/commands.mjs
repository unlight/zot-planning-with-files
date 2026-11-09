import { isAllPhasesComplete, readPlanStatus, resolvePlanPathsForTarget } from "./plan.mjs";
import {
  checkPlanAttestation,
  clearPlanAttestation,
  writePlanAttestation,
} from "./attestation.mjs";
import {
  DEFAULT_GOAL_CONDITION,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_LOOP_PROMPT,
  INVALID_PLAN_ROOT_NOTICE,
  PLAN_SELECTOR_REJECTED_NOTICE,
  SESSION_PLAN_AMBIGUOUS_NOTICE,
} from "./constants.mjs";
import { buildTamperMessage, summarizePlan } from "./runtime.mjs";
import {
  approveExecution,
  clearExecution,
  clearSessionLoop,
  isExecutionApproved,
} from "./state.mjs";

export function selectionErrorNotice(status) {
  switch (status.selectionError) {
    case "session-plan-ambiguous":
      return SESSION_PLAN_AMBIGUOUS_NOTICE;
    case "invalid-plan-root":
      return INVALID_PLAN_ROOT_NOTICE;
    case "plan-selector-rejected":
      return PLAN_SELECTOR_REJECTED_NOTICE;
    default:
      return "";
  }
}

function warnSelectionError(status, notify) {
  const notice = selectionErrorNotice(status);
  if (!notice) return false;
  notify("warning", notice);
  return true;
}

function parseIntervalSpec(raw) {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  const factors = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * factors[match[2].toLowerCase()];
}

function isStopWord(value) {
  return ["stop", "off", "clear", "disable"].includes(value);
}

export function handleCommand(name, args, ctx) {
  switch (name) {
    case "plan-status":
      return handlePlanStatus(args, ctx);
    case "plan-attest":
      return handlePlanAttest(args, ctx);
    case "plan-execute":
      return handlePlanExecute(args, ctx);
    case "plan-goal":
      return handlePlanGoal(args, ctx);
    case "plan-loop":
      return handlePlanLoop(args, ctx);
    default:
      return { action: "noop", error: `unknown command /${name}` };
  }
}

function handlePlanStatus(_args, ctx) {
  const status = readPlanStatus(ctx.state.cwd);
  if (warnSelectionError(status, ctx.notify)) return { action: "noop" };
  if (!status.exists) {
    ctx.notify("warning", "No active plan (task_plan.md not found)");
    return { action: "noop" };
  }

  const attestation = checkPlanAttestation(status);
  const approved = isExecutionApproved(ctx.state, ctx.state.sessionId, status);
  const lines = [
    `Plan path: ${status.planPath}`,
    `Scope: ${status.scope}`,
    ...(status.planId ? [`Plan ID: ${status.planId}`] : []),
    `Phases: ${status.totalPhases}`,
    `Complete: ${status.completePhases}`,
    `In progress: ${status.inProgressPhases}`,
    `Pending: ${status.pendingPhases}`,
    `Attestation: ${attestation.enabled ? (attestation.tampered ? "TAMPERED" : "valid") : "not recorded"}`,
    `Execution: ${approved ? "active" : "passive (run /plan-execute)"}`,
  ];
  return { action: "display", display: lines.join("\n") };
}

function handlePlanAttest(args, ctx) {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  let mode = "attest";
  let target;

  if (parts.length === 0) {
    mode = "attest";
  } else if (parts.length === 1 && (parts[0] === "--show" || parts[0] === "-Show")) {
    mode = "show";
  } else if (parts.length === 1 && (parts[0] === "--clear" || parts[0] === "-Clear")) {
    mode = "clear";
  } else if (parts.length === 2 && (parts[0] === "--target" || parts[0] === "-Target")) {
    mode = "attest";
    target = parts[1];
  } else {
    return {
      action: "noop",
      error: "usage: /plan-attest [--show|--clear|--target root|<plan-id>]",
    };
  }

  let status;
  if (target) {
    const paths = resolvePlanPathsForTarget(ctx.state.cwd, target);
    if (!paths) {
      return {
        action: "noop",
        error: `[plan-attest] --target ${target} did not resolve to a plan. An explicit target is a binding: nothing was attested and no other plan was substituted.`,
      };
    }
    status = readPlanStatus(ctx.state.cwd, paths);
  } else {
    status = readPlanStatus(ctx.state.cwd);
    if (warnSelectionError(status, ctx.notify)) return { action: "noop" };
  }

  if (!status.exists || !status.planPath) {
    return { action: "noop", error: "[plan-attest] No task_plan.md found. Create a plan first." };
  }

  if (mode === "show") {
    const attestation = checkPlanAttestation(status);
    if (!attestation.enabled) {
      return {
        action: "display",
        display: `[plan-attest] No attestation set for ${status.planPath}.`,
      };
    }
    return {
      action: "display",
      display: [
        `Plan: ${status.planPath}`,
        `Attestation: ${attestation.attestationPath}`,
        `SHA-256: ${attestation.expected ?? "<unreadable or invalid>"}`,
        `Actual: ${attestation.actual ?? "<unreadable>"}`,
        `Status: ${attestation.tampered ? "TAMPERED" : "valid"}`,
      ].join("\n"),
    };
  }

  if (mode === "clear") {
    const removed = clearPlanAttestation(status);
    if (removed.length === 0) {
      return { action: "display", display: "[plan-attest] No attestation to clear." };
    }
    return {
      action: "display",
      display: `[plan-attest] Cleared attestation for ${status.planPath}.\nRemoved: ${removed.join(", ")}`,
    };
  }

  if (!status.planSha256) {
    return { action: "noop", error: `[plan-attest] Cannot read ${status.planPath}.` };
  }

  const path = writePlanAttestation(status, status.planSha256);
  return {
    action: "display",
    display: [
      `Plan: ${status.planPath}`,
      `Attestation: ${path}`,
      `SHA-256: ${status.planSha256}`,
      "Plan attested.",
    ].join("\n"),
  };
}

function handlePlanExecute(args, ctx) {
  const status = readPlanStatus(ctx.state.cwd);
  if (warnSelectionError(status, ctx.notify)) return { action: "noop" };
  if (!status.exists) {
    ctx.notify("warning", "No active plan (task_plan.md not found)");
    return { action: "noop" };
  }

  const normalized = args.trim().toLowerCase();
  if (["clear", "off", "reset", "disable"].includes(normalized)) {
    clearExecution(ctx.state, ctx.state.sessionId, status);
    ctx.notify("info", `Plan execution approval cleared: ${summarizePlan(status)}`);
    return { action: "noop" };
  }

  const attestation = checkPlanAttestation(status);
  if (attestation.tampered) {
    ctx.notify("error", buildTamperMessage(status));
    return { action: "noop" };
  }

  approveExecution(ctx.state, ctx.state.sessionId, status);
  ctx.notify(
    "info",
    [
      `Plan execution approved: ${summarizePlan(status)}`,
      `Plan path: ${status.planPath}`,
      "planning-with-files hooks are now active for this session and plan.",
    ].join("\n"),
  );
  return { action: "noop" };
}

function handlePlanGoal(args, ctx) {
  const sessionId = ctx.state.sessionId;
  const normalized = args.trim();

  if (!normalized || ["clear", "off", "disable"].includes(normalized.toLowerCase())) {
    ctx.state.goalBySession.delete(sessionId);
    ctx.notify("info", "Plan goal cleared");
    return { action: "noop" };
  }

  const goal = normalized === "default" ? DEFAULT_GOAL_CONDITION : normalized;
  ctx.state.goalBySession.set(sessionId, goal);
  ctx.notify("info", `Plan goal set: ${goal}`);
  return { action: "noop" };
}

function handlePlanLoop(args, ctx) {
  const sessionId = ctx.state.sessionId;
  const raw = args.trim();

  if (isStopWord(raw.toLowerCase())) {
    clearSessionLoop(ctx.state, sessionId);
    ctx.notify("info", "plan-loop stopped");
    return { action: "noop" };
  }

  const parts = raw ? raw.split(/\s+/) : [];
  const maybeInterval = parseIntervalSpec(parts[0]);
  const intervalMs = maybeInterval ?? DEFAULT_LOOP_INTERVAL_MS;
  const prompt = maybeInterval ? parts.slice(1).join(" ").trim() : parts.join(" ").trim();
  const tickPrompt = prompt || DEFAULT_LOOP_PROMPT;

  const initialStatus = readPlanStatus(ctx.state.cwd);
  if (warnSelectionError(initialStatus, ctx.notify)) return { action: "noop" };
  if (!initialStatus.exists) {
    ctx.notify("warning", "No active plan (task_plan.md not found)");
    return { action: "noop" };
  }

  clearSessionLoop(ctx.state, sessionId);

  const timer = setInterval(() => {
    try {
      const status = readPlanStatus(ctx.state.cwd);
      if (!status.exists) return;

      if (isAllPhasesComplete(status) || status.closed) {
        clearSessionLoop(ctx.state, sessionId);
        ctx.notify("info", `[planning-with-files] plan-loop stopped: ${summarizePlan(status)}.`);
        return;
      }

      ctx.submit(tickPrompt);
    } catch (error) {
      ctx.log(`plan-loop tick failed: ${error?.stack || error}`);
    }
  }, intervalMs);

  ctx.state.loopTimersBySession.set(sessionId, timer);
  ctx.notify("info", `plan-loop started (${Math.round(intervalMs / 1000)}s)`);
  return { action: "noop" };
}
