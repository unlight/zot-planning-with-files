import {
  isAllPhasesComplete,
  isPlanIncomplete,
  isSessionAttached,
  readPlanStatus,
} from "./plan.mjs";
import { checkPlanAttestation } from "./attestation.mjs";
import {
  AUTO_CONTINUE_LIMIT,
  CACHE_SAFE_REMINDER,
  POST_WRITE_REMINDER,
} from "./constants.mjs";
import { selectionErrorNotice } from "./commands.mjs";
import {
  buildParityPlanInjection,
  buildTamperMessage,
  deriveEffectiveMode,
  resolveConfiguredMode,
  summarizePlan,
} from "./runtime.mjs";
import {
  clearSessionApprovals,
  clearSessionAutoContinue,
  clearSessionLoop,
  isExecutionApproved,
  planSessionKey,
} from "./state.mjs";

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\bsudo\b/i,
  /\bchmod\s+(0?777|a\+rwx)\b/i,
  /\bgit\s+push\s+.*(--force|-f\b|--mirror|\+)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fdx]/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/,
  /\bdd\s+.*of=\/dev\/[sh]d[a-z]/i,
];

function isDangerousBashCommand(command) {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function isToolUseStop(stop) {
  return /tool/i.test(stop || "");
}

function isFailedTurn(frame) {
  const stop = (frame.stop || "").toLowerCase();
  return Boolean(frame.error) || stop === "error" || stop === "aborted";
}

function appendBlock(prompt, block) {
  if (typeof prompt !== "string" || prompt.length === 0) return block;
  return `${prompt}\n\n${block}`;
}

function syncContext(frame, ctx) {
  if (frame.cwd) ctx.state.cwd = frame.cwd;
  if (frame.session_id) ctx.state.sessionId = frame.session_id;
}

function debug(ctx, message) {
  if (process.env.PWF_DEBUG) ctx.log(message);
}

export function handleEvent(frame, ctx) {
  syncContext(frame, ctx);

  switch (frame.event) {
    case "session_start":
      onSessionStart(ctx);
      break;
    case "session_end":
      onSessionEnd(ctx);
      break;
    case "user_prompt_submit":
      onUserPromptSubmit(frame, ctx);
      break;
    case "turn_end":
      onTurnEnd(frame, ctx);
      break;
    case "tool_call":
      onToolCall(frame, ctx);
      break;
    case "tool_result":
      onToolResult(frame, ctx);
      break;
    case "pre_compact":
      onPreCompact(ctx);
      break;
    case "post_compact":
      onPostCompact(ctx);
      break;
    default:
      break;
  }
}

function onSessionStart(ctx) {
  const state = ctx.state;
  clearSessionAutoContinue(state, state.sessionId);
  clearSessionApprovals(state, state.sessionId);
  clearSessionLoop(state, state.sessionId);

  const status = readPlanStatus(state.cwd);
  const notice = selectionErrorNotice(status);
  if (notice) {
    ctx.notify("warning", notice, true);
    return;
  }
  if (!status.exists) return;
  if (!isSessionAttached(status.cwd, state.sessionId)) {
    ctx.notify(
      "warning",
      "[planning-with-files] session not attached to planning context",
      true,
    );
    return;
  }
  ctx.notify(
    "info",
    `${summarizePlan(status)} - run /plan-execute to activate hooks`,
    true,
  );
}

function onSessionEnd(ctx) {
  const state = ctx.state;
  clearSessionAutoContinue(state, state.sessionId);
  clearSessionApprovals(state, state.sessionId);
  clearSessionLoop(state, state.sessionId);
}

function onUserPromptSubmit(frame, ctx) {
  const state = ctx.state;
  const text = typeof frame.text === "string" ? frame.text : "";

  // Our own submit calls are not user input; do not reset the retry budget.
  const pending = state.extensionSubmits.get(text);
  if (pending) {
    if (pending <= 1) state.extensionSubmits.delete(text);
    else state.extensionSubmits.set(text, pending - 1);
    return;
  }
  clearSessionAutoContinue(state, state.sessionId);
}

function onTurnEnd(frame, ctx) {
  const state = ctx.state;
  // turn_end also fires for tool-use steps; only a terminal turn can continue.
  if (isToolUseStop(frame.stop)) return;

  const status = readPlanStatus(state.cwd);
  if (!status.exists) return;

  const sessionId = state.sessionId;
  const planKey = planSessionKey(sessionId, status);

  if (status.closed) {
    state.autoContinueBySessionPlan.set(planKey, 0);
    return;
  }

  if (isAllPhasesComplete(status)) {
    state.autoContinueBySessionPlan.set(planKey, 0);
    ctx.notify(
      "info",
      `[planning-with-files] ALL PHASES COMPLETE (${status.completePhases}/${status.totalPhases}).`,
    );
    return;
  }

  if (isFailedTurn(frame)) return;
  if (!isPlanIncomplete(status)) return;

  if (!isExecutionApproved(state, sessionId, status)) {
    ctx.notify(
      "warning",
      `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases}). Run /plan-execute to activate hooks.`,
    );
    return;
  }

  const mode = deriveEffectiveMode(resolveConfiguredMode(status.cwd), state.host);
  if (mode === "notify") {
    ctx.notify(
      "warning",
      `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases}). Continue manually.`,
    );
    return;
  }

  const current = state.autoContinueBySessionPlan.get(planKey) ?? 0;
  if (current >= AUTO_CONTINUE_LIMIT) {
    ctx.notify(
      "warning",
      `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases}). Auto-continue limit reached.`,
    );
    return;
  }

  state.autoContinueBySessionPlan.set(planKey, current + 1);
  debug(
    ctx,
    `auto-continue ${current + 1}/${AUTO_CONTINUE_LIMIT} for ${sessionId} (${status.completePhases}/${status.totalPhases} phases)`,
  );
  const goal = state.goalBySession.get(sessionId);
  const message =
    `[planning-with-files] Task incomplete (${status.completePhases}/${status.totalPhases} phases done). ` +
    "Update progress.md with what was done, then read task_plan.md and continue remaining phases." +
    (goal ? ` Goal: ${goal}` : "");

  ctx.submit(message);
}

function onToolCall(frame, ctx) {
  const status = readPlanStatus(ctx.state.cwd);
  const toolName = frame.tool_name || "";

  if (!status.exists && !status.selectionError && (toolName === "write" || toolName === "edit")) {
    ctx.notify(
      "warning",
      "[planning-with-files] No task_plan.md found. Create planning files first.",
    );
  }

  if (toolName === "bash") {
    const args = frame.tool_args && typeof frame.tool_args === "object" ? frame.tool_args : {};
    const command = typeof args.command === "string" ? args.command : "";
    if (isDangerousBashCommand(command)) {
      ctx.notify(
        "warning",
        "[planning-with-files] Dangerous command detected. Review current phase in task_plan.md before approval.",
      );
    }
  }
}

function onToolResult(frame, ctx) {
  if (frame.tool_name !== "write" && frame.tool_name !== "edit") return;

  const status = readPlanStatus(ctx.state.cwd);
  if (!status.exists) return;
  if (!isExecutionApproved(ctx.state, ctx.state.sessionId, status)) return;

  ctx.notify("info", POST_WRITE_REMINDER);
}

function onPreCompact(ctx) {
  const status = readPlanStatus(ctx.state.cwd);
  if (!status.exists) return;

  const attestation = checkPlanAttestation(status);
  const reminder = [
    "[planning-with-files] PreCompact: context compaction is about to occur.",
    "Before compaction completes: ensure progress.md captures recent actions and task_plan.md status reflects current phase.",
    attestation.enabled && attestation.expected
      ? `Plan-SHA256 at compaction: ${attestation.expected}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  ctx.notify("info", reminder);
}

function onPostCompact(_ctx) {
  // No delivery cache survives compaction, so there is nothing to clear here.
}

export function handleBeforeAgentStart(frame, ctx) {
  const state = ctx.state;
  syncContext(frame, ctx);
  if (frame.provider) state.host.provider = frame.provider;
  if (frame.model) state.host.model = frame.model;

  // A missing prompt means the host did not include one; never replace it.
  if (typeof frame.system_prompt !== "string") return null;

  const status = readPlanStatus(state.cwd);
  const notice = selectionErrorNotice(status);
  if (notice) return appendBlock(frame.system_prompt, notice);
  if (!status.exists) return null;
  if (!isSessionAttached(status.cwd, state.sessionId)) return null;
  if (!isExecutionApproved(state, state.sessionId, status)) return null;

  const attestation = checkPlanAttestation(status);
  if (attestation.tampered) {
    return appendBlock(frame.system_prompt, buildTamperMessage(status));
  }

  const mode = deriveEffectiveMode(resolveConfiguredMode(status.cwd), state.host);
  if (mode === "notify") return null;

  debug(ctx, `injecting ${mode} plan context for ${status.planPath}`);
  const block = mode === "parity" ? buildParityPlanInjection(status) : CACHE_SAFE_REMINDER;
  return appendBlock(frame.system_prompt, block);
}
