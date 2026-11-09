export const PKG_NAME = "planning-with-files";
export const PLAN_DATA_BEGIN = "===BEGIN PLAN DATA===";
export const PLAN_DATA_END = "===END PLAN DATA===";

// Keep this reminder stable so DeepSeek-style KV caches keep their prefix.
export const CACHE_SAFE_REMINDER =
  "[planning-with-files] Read task_plan.md for current phase and status. " +
  "Read findings.md for research context. Read progress.md for recent changes. " +
  "Continue from the current phase.";

export const POST_WRITE_REMINDER =
  "[planning-with-files] Update progress.md with what you just did. If a phase is now complete, update task_plan.md status.";

export const TAMPERED_PREFIX = "[planning-with-files] [PLAN TAMPERED - injection blocked]";

export const AUTO_CONTINUE_LIMIT = 3;

export const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_LOOP_PROMPT =
  "Read task_plan.md and progress.md. Count the phases whose Status is complete. " +
  "If no progress.md entry has been added since the last loop tick, write one summarizing the current state. " +
  "If a phase finished, update its Status: line in task_plan.md. Continue the next phase if work remains.";

export const DEFAULT_GOAL_CONDITION = "all phases in task_plan.md report Status: complete";

export const SESSION_PLAN_AMBIGUOUS_NOTICE =
  "[planning-with-files] Multiple plans are available while session isolation is armed. Set PLAN_ID=<slug> for this session; nothing injected.";

export const INVALID_PLAN_ROOT_NOTICE =
  "[planning-with-files] PWF_PLAN_ROOT does not resolve to an existing absolute directory; nothing injected.";

export const PLAN_SELECTOR_REJECTED_NOTICE =
  "[planning-with-files] PLAN_ID did not resolve to a plan under .planning; nothing injected.";
