#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";

import { handleCommand } from "./lib/commands.ts";
import { handleBeforeAgentStart, handleEvent } from "./lib/hooks.ts";
import { createState } from "./lib/state.ts";
import type {
  CommandInvokedFrame,
  EventFrame,
  Frame,
  HelloAckFrame,
  InterceptFrame,
  NotifyLevel,
  ProtocolContext,
} from "./lib/types.ts";

const NAME = "planning-with-files";
const VERSION = "0.1.0";

const COMMANDS: Array<{ name: string; description: string }> = [
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

const EVENTS: string[] = [
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

function send(frame: Frame): void {
  try {
    stdout.write(`${JSON.stringify(frame)}\n`);
  } catch (error) {
    log(`write failed: ${(error as Error).message}`);
  }
}

function log(message: string): void {
  try {
    stderr.write(`[${NAME}] ${message}\n`);
  } catch {
    // stderr is best-effort; never let logging crash the extension.
  }
}

function notify(level: NotifyLevel, message: string, startup = false): void {
  const frame: Frame = { type: "notify", level, message };
  if (startup) frame.startup = true;
  send(frame);
}

function submit(text: string): void {
  // Remember our own prompts so user_prompt_submit does not reset the budget.
  state.extensionSubmits.set(text, (state.extensionSubmits.get(text) ?? 0) + 1);
  send({ type: "submit", text });
}

const ctx: ProtocolContext = { state, send, log, notify, submit };

send({
  type: "hello",
  name: NAME,
  version: VERSION,
  capabilities: ["commands", "events"],
});

const rl = createInterface({ input: stdin, crlfDelay: Infinity });

rl.on("line", (line: string) => {
  let frame: Frame;
  try {
    frame = JSON.parse(line) as Frame;
  } catch (error) {
    log(`malformed frame: ${(error as Error).message}`);
    return;
  }

  switch (frame.type) {
    case "hello_ack":
      onHelloAck(frame as HelloAckFrame);
      break;
    case "command_invoked":
      onCommandInvoked(frame as CommandInvokedFrame);
      break;
    case "event":
      try {
        handleEvent(frame as EventFrame, ctx);
      } catch (error) {
        log(`event handler failed: ${(error as Error)?.stack || error}`);
      }
      break;
    case "event_intercept":
      onEventIntercept(frame as InterceptFrame);
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

function onHelloAck(ack: HelloAckFrame): void {
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

  log(
    `connected to zot ${state.host.zotVersion} (${state.host.provider}/${state.host.model}, cwd=${state.cwd})`,
  );
}

function onCommandInvoked(frame: CommandInvokedFrame): void {
  const args = typeof frame.args === "string" ? frame.args : "";
  let response;

  try {
    response = handleCommand(frame.name, args, ctx);
  } catch (error) {
    log(`command /${frame.name} failed: ${(error as Error)?.stack || error}`);
    response = {
      action: "noop" as const,
      error: `/${frame.name} failed: ${(error as Error).message}`,
    };
  }

  send({ type: "command_response", id: frame.id, ...response });
}

function onEventIntercept(frame: InterceptFrame): void {
  const response: Frame = { type: "event_intercept_response", id: frame.id };

  try {
    if (frame.event === "before_agent_start") {
      const replacement = handleBeforeAgentStart(frame, ctx);
      if (replacement !== null && replacement !== undefined) {
        response.system_prompt = replacement;
      }
    }
  } catch (error) {
    log(`intercept ${frame.event} failed: ${(error as Error)?.stack || error}`);
  }

  send(response);
}

function cleanup(): void {
  for (const timer of state.loopTimersBySession.values()) clearInterval(timer);
  state.loopTimersBySession.clear();
}

function onShutdown(): void {
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
