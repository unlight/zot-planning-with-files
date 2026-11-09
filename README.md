# planning-with-files for zot

A zot extension that ports the `planning-with-files` Pi Agent commands to
zot's extension protocol. It keeps the same three-file workflow
(`task_plan.md`, `findings.md`, `progress.md`) and the same command surface
as the Pi Agent extension.

Upstream project: <https://github.com/OthmanAdi/planning-with-files>

## What it does

- Resolves the active plan from `PLAN_ID`, `PWF_PLAN_ROOT`, `.planning/.active_plan`,
  the newest `.planning/<slug>/task_plan.md`, or the legacy root `task_plan.md`.
- Registers the Pi Agent commands on zot: `/plan-status`, `/plan-attest`,
  `/plan-execute`, `/plan-goal`, and `/plan-loop`.
- Injects the approved plan into the system prompt when zot starts a run,
  with tamper detection through a SHA-256 attestation.
- Auto-continues an incomplete approved plan after a terminal model turn,
  up to three times per session and plan.
- Sends a post-write reminder after `write` or `edit`, a pre-compaction
  reminder, and a warning for dangerous bash patterns.
- Ships the `planning-with-files` skill and its three templates. The skill is
  discovered as `planning-with-files:planning-with-files` because zot
  namespaces extension-provided skills.

## Requirements

- zot 0.4 or newer.
- Node.js 20 or newer. No npm dependencies.

## Install

From this directory:

```bash
zot ext install .
```

Or load the working copy for one session:

```bash
zot --ext /path/to/zot-planning-with-files
```

## Commands

```text
/plan-status
    Show the selected plan path, scope, phase counts, attestation state,
    and whether execution hooks are active.

/plan-attest
    Record the current task_plan.md SHA-256 in .planning/<id>/.attestation
    or ./.plan-attestation. Variants:
      /plan-attest --show
      /plan-attest --clear
      /plan-attest --target root
      /plan-attest --target <plan-id>

/plan-execute
    Approve the selected plan for this session and activate hooks.
    Refuses to approve a tampered plan.
      /plan-execute reset

/plan-goal <text|default|clear>
    Set or clear the continuation goal appended to auto-continue prompts.
    "default" uses "all phases in task_plan.md report Status: complete".

/plan-loop [10m] [prompt...]
    Submit a planning tick on an interval. The first argument matching
    ^\d+[smhd]$ is the interval; the rest is the tick prompt.
      /plan-loop stop
```

## Plan resolution

The extension reads `hello_ack.cwd` from zot and walks up to the nearest
directory with `.planning/` or `task_plan.md`. The walk stops at `.git` or the
filesystem root.

Selection order:

1. `PWF_PLAN_ROOT`, when set. It must be an absolute existing directory. An
   invalid pin is refused; the extension does not fall back.
2. `PLAN_ID`, when set. It must name a contained `.planning/<slug>/task_plan.md`.
   An invalid selector is refused; the extension does not fall back.
3. `.planning/.active_plan`.
4. The newest `.planning/<slug>/task_plan.md` by plan mtime.
5. The legacy project-root `task_plan.md`.

If `.planning/sessions/` exists and more than one live plan is present, the
extension refuses to pick one without `PLAN_ID`. A session counts as attached
only when `.planning/sessions/<session_id>.attached` exists. This matches the
upstream session-isolation behavior. zot does not create attachment markers
itself, so create them explicitly when you use session isolation.

## Modes

Mode resolution order:

1. `PWF_MODE` environment variable: `auto`, `parity`, `cache-safe`, or `notify`.
2. `<project>/.zot/planning-with-files.json`:
   ```json
   { "planningWithFiles": { "mode": "auto" } }
   ```
3. `<project>/.pi/settings.json` and `~/.pi/agent/settings.json` with the same
   `planningWithFiles.mode` key, for Pi compatibility.
4. Default: `auto`.

`auto` selects `cache-safe` for DeepSeek providers or models and `parity` for
everything else.

- `parity`: inject the first 50 plan lines, the attested hash when present, and
  the last 20 normalized `progress.md` lines.
- `cache-safe`: inject one stable reminder that points at the three files.
- `notify`: never inject plan text; only send notifications.

## Lifecycle mapping

zot exposes fewer context-injection points than Pi. The port uses what zot
provides:

| Pi behavior | zot implementation |
|---|---|
| Session catchup on `session_start` | Startup notification with the phase summary and the `/plan-execute` hint. No host session-store access. |
| Plan injection on `before_agent_start` | `before_agent_start` intercept appends to the complete system prompt. |
| Pre-tool plan recitation | Not available without starting a turn, so the injected prompt and auto-continue tell the model to re-read the plan. |
| Post-write reminder on `tool_result` | `notify` reminder after `write` or `edit`. zot cannot append text to a tool result. |
| Auto-continue on `agent_end` | `turn_end` with a terminal stop reason, then `submit` with the continuation prompt, limit 3. |
| Pre-compaction reminder | `pre_compact` notification, including the attested hash when present. |

zot keeps the system prompt stable across normal user messages, so the injected
plan text is a snapshot of the run start. The plan file on disk is the source of
truth. The auto-continue prompt and the skill both instruct the model to read
`task_plan.md` again.

`submit` is ignored in zot's print, JSON, and RPC modes. Auto-continue and
`/plan-loop` therefore work only in the interactive TUI.

## Skill bundle

The extension manifest declares `"skills": ["./skills"]`. zot discovers the
bundled skill as `planning-with-files:planning-with-files`. Invoke it with:

```text
/skill:planning-with-files:planning-with-files
```

The skill contains the workflow and the three templates under
`skills/planning-with-files/templates/`.

## Testing

```bash
npm test
```

The test suite drives the extension over its stdio protocol and covers command
registration, plan status, attestation, approval, injection, tamper blocking,
auto-continue limits, loop ticks, missing plans, selector rejection, invalid
root pins, and DeepSeek cache-safe mode.

## Security

- Plan content is wrapped in `===BEGIN PLAN DATA===` and `===END PLAN DATA===`
  and should be treated as data, not instructions.
- The attestation is an ordinary local SHA-256 value. It detects a plan change
  only while the saved digest remains trusted. It is not a keyed signature.
- The extension runs with the user's full filesystem permissions, like any zot
  extension.
- Only the approved plan is injected. A tampered plan produces a
  `[PLAN TAMPERED - injection blocked]` message instead of plan data.

## Differences from the Pi Agent extension

- zot has no extension status bar, so passive status is a startup notification.
- zot has no non-triggering "next turn" message, so pre-tool recitation is not
  reproduced and post-write reminders are notifications.
- zot's `submit` frame triggers a user prompt. Auto-continue and the planning
  loop therefore add real turns. The three-continue limit bounds the former;
  the loop interval bounds the latter.
- The default loop prompt counts phases in `task_plan.md` directly instead of
  running `scripts/check-complete.sh`, because this bundle does not vendor the
  upstream shell scripts.

## License

MIT. The planning-with-files workflow and templates come from
<https://github.com/OthmanAdi/planning-with-files> (MIT, Copyright (c) 2026
Ahmad Adi).
