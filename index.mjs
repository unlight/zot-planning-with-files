#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";

import { handleCommand } from "./lib/commands.mjs";
import { handleBeforeAgentStart, handleEvent } from "./lib/hooks.mjs";
import { createState } from "./lib/state.mjs";

const NAME = "planning-with-files";
const VERSION = "0.1.0";

const COMMANDS = [
  {
    name: "plan-status",
    description: "show the active planning-with-files plan status",
  },
  {
    name: "plan-attest",
    description: "manage the plan SHA-256 attestation (--show / --clear / --target)",
  },
  {
    name: "plan-execute",
    description: "approve the active plan and activate hooks (reset to clear)",
  },
  {
    name: "plan-goal",
    description: "set or clear the continuation goal text",
  },
  {
    name: "plan-loop",
    description: "start or stop planning-loop ticks (default 10m)",
  },
];

const EVENTS = [
  "session_start",
  "session_end",
  "user_prompt_submit",
  "turn_end",
  "tool_call",
  "tool_result",
  "pre_compact",
  "post_compact",
];

const state = createState();
let shuttingDown = false;

function send(frame) {
  try {
    stdout.write(`${JSON.stringify(frame)}\n`);
  } catch (error) {
    log(`write failed: ${error.message}`);
  }
}

function log(message) {
  try {
    stderr.write(`[${NAME}] ${message}\n`);
  } catch {
    // stderr is best-effort; never let logging crash the extension.
  }
}

function notify(level, message, startup = false) {
  const frame = { type: "notify", level, message };
  if (startup) frame.startup = true;
  send(frame);
}

function submit(text) {
  // Remember our own prompts so user_prompt_submit does not reset the budget.
  state.extensionSubmits.set(text, (state.extensionSubmits.get(text) ?? 0) + 1);
  send({ type: "submit", text });
}

const ctx = { state, send, log, notify, submit };

send({
  type: "hello",
  name: NAME,
  version: VERSION,
  capabilities: ["commands", "events"],
});

const rl = createInterface({ input: stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    log(`malformed frame: ${error.message}`);
    return;
  }

  switch (frame.type) {
    case "hello_ack":
      onHelloAck(frame);
      break;
    case "command_invoked":
      onCommandInvoked(frame);
      break;
    case "event":
      try {
        handleEvent(frame, ctx);
      } catch (error) {
        log(`event handler failed: ${error?.stack || error}`);
      }
      break;
    case "event_intercept":
      onEventIntercept(frame);
      break;
    case "shutdown":
      onShutdown();
      break;
    default:
      log(`unknown frame type: ${frame.type}`);
  }
});

rl.on("close", () => {
  onShutdown();
  process.exit(0);
});

function onHelloAck(ack) {
  state.host.protocolVersion = ack.protocol_version ?? 0;
  state.host.zotVersion = ack.zot_version ?? "";
  state.host.provider = ack.provider ?? "";
  state.host.model = ack.model ?? "";
  state.host.cwd = ack.cwd ?? "";
  state.host.extensionDir = ack.extension_dir ?? "";
  state.host.dataDir = ack.data_dir ?? "";
  if (ack.cwd) state.cwd = ack.cwd;

  for (const command of COMMANDS) {
    send({
      type: "register_command",
      name: command.name,
      description: command.description,
    });
  }

  send({ type: "subscribe", events: EVENTS, intercept: ["before_agent_start"] });
  send({ type: "ready" });

  log(`connected to zot ${state.host.zotVersion} (${state.host.provider}/${state.host.model}, cwd=${state.cwd})`);
}

function onCommandInvoked(frame) {
  const args = typeof frame.args === "string" ? frame.args : "";
  let response;

  try {
    response = handleCommand(frame.name, args, ctx);
  } catch (error) {
    log(`command /${frame.name} failed: ${error?.stack || error}`);
    response = { action: "noop", error: `/${frame.name} failed: ${error.message}` };
  }

  send({ type: "command_response", id: frame.id, ...response });
}

function onEventIntercept(frame) {
  const response = { type: "event_intercept_response", id: frame.id };

  try {
    if (frame.event === "before_agent_start") {
      const replacement = handleBeforeAgentStart(frame, ctx);
      if (replacement !== null && replacement !== undefined) {
        response.system_prompt = replacement;
      }
    }
  } catch (error) {
    log(`intercept ${frame.event} failed: ${error?.stack || error}`);
  }

  send(response);
}

function cleanup() {
  for (const timer of state.loopTimersBySession.values()) clearInterval(timer);
  state.loopTimersBySession.clear();
}

function onShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  cleanup();
  send({ type: "shutdown_ack" });
  rl.close();
  // Give the ack a tick to flush before the process exits.
  setTimeout(() => process.exit(0), 20).unref();
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
