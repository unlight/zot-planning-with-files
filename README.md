# planning-with-files for zot

A zot extension for the `planning-with-files` workflow. It keeps the
three-file workflow (`task_plan.md`, `findings.md`, `progress.md`) on disk and
adds plan status, attestation, execution approval, goal, and loop commands.

- Upstream project: <https://github.com/OthmanAdi/planning-with-files>
- zot extension protocol: <https://github.com/patriceckhart/zot/blob/main/docs/extensions.md>

## Quick start

1. Install the extension:

   ```bash
   zot ext install /path/to/zot-planning-with-files
   ```

   Or load a working copy for one session:

   ```bash
   zot --ext /path/to/zot-planning-with-files
   ```

2. Install the upstream skill separately. The extension does not bundle it:

   ```bash
   npx skills add OthmanAdi/planning-with-files --skill planning-with-files -g
   ```

   Then invoke it in zot:

   ```text
   /skill:planning-with-files
   ```

   If you prefer manual files, create `task_plan.md`, `findings.md`, and
   `progress.md` in the project root or in `.planning/<slug>/` using the
   upstream templates.

3. Inspect the selected plan:

   ```text
   /plan-status
   ```

4. Lock the current plan bytes:

   ```text
   /plan-attest
   ```

5. Approve the plan and activate hooks for this session:

   ```text
   /plan-execute
   ```

The plan stays passive until `/plan-execute`. Passive means no plan text is
injected into model context. Review and edit the plan before approving it.

## Commands

| Command                             | Arguments           | Behavior                                                                                           |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `/pwf [task]`                       | optional task       | Load the upstream `planning-with-files` skill and start the workflow.                              |
| `/pwf-status`                       | none                | Show a compact status block: plan, scope, mode, attestation, current phase, and phase counts.      |
| `/plan-status`                      | none                | Show the selected plan path, scope, plan ID, phase counts, attestation state, and execution state. |
| `/plan-attest`                      | none                | Record the SHA-256 of `task_plan.md` in `.planning/<id>/.attestation` or `./.plan-attestation`.    |
| `/plan-attest --show`               | none                | Print the stored hash, the current hash, and whether they match.                                   |
| `/plan-attest --clear`              | none                | Remove the attestation and reopen the plan for editing.                                            |
| `/plan-attest --target root`        | none                | Attest the legacy root `task_plan.md` explicitly.                                                  |
| `/plan-attest --target <plan-id>`   | plan ID             | Attest one named plan explicitly.                                                                  |
| `/plan-execute`                     | none                | Approve the selected plan for this session and activate hooks. Refuses a tampered plan.            |
| `/plan-execute reset`               | none                | Return the selected plan to passive review mode.                                                   |
| `/plan-goal <text>`                 | goal text           | Set the continuation goal appended to auto-continue prompts.                                       |
| `/plan-goal default`                | none                | Use `all phases in task_plan.md report Status: complete`.                                          |
| `/plan-goal clear`                  | none                | Clear the session goal.                                                                            |
| `/plan-loop`                        | none                | Start the default 10 minute planning tick.                                                         |
| `/plan-loop <interval>`             | `^\d+[smhd]$`       | Start a tick with a custom interval, for example `5m` or `1h`.                                     |
| `/plan-loop <interval> <prompt...>` | interval and prompt | Start a tick with a custom prompt.                                                                 |
| `/plan-loop stop`                   | none                | Stop the session loop.                                                                             |

The `/plan-*` names and argument forms follow the upstream `planning-with-files`
command set. `/pwf` and `/pwf-status` are host-style aliases.

## Plan selection

The extension starts from `hello_ack.cwd` and walks up to the nearest directory
with `.planning/` or `task_plan.md`. The walk stops at `.git` or the filesystem
root.

Selection order:

1. `PWF_PLAN_ROOT`, when set. It must be an absolute existing directory. An
   invalid pin is refused. The extension does not fall back to another plan.
2. `PLAN_ID`, when set. It must name a contained
   `.planning/<slug>/task_plan.md`. An invalid selector is refused. The
   extension does not fall back to another plan.
3. `.planning/.active_plan`.
4. The newest `.planning/<slug>/task_plan.md`, ranked by plan file mtime.
5. The legacy project-root `task_plan.md`.

When `.planning/sessions/` exists and more than one live plan is present, the
extension refuses to choose one without `PLAN_ID`. A session counts as attached
only when `.planning/sessions/<session_id>.attached` exists. zot does not create
attachment markers itself. Create them explicitly when you use session
isolation.

## Context injection

zot keeps the system prompt stable across normal user messages. The extension
uses the `before_agent_start` intercept to append plan context when zot starts a
run or rebuilds the prompt. The plan file on disk remains the source of truth.

Modes:

- `parity`: inject the first 50 plan lines, the attested hash when present, and
  the last 20 normalized `progress.md` lines.
- `cache-safe`: inject one stable reminder that points at the three planning
  files. This is the default for DeepSeek providers and models.
- `notify`: never inject plan text. Send notifications only.
- `auto`: choose `cache-safe` for DeepSeek and `parity` for everything else.

Resolution order:

1. `PWF_MODE` environment variable.
2. `<project>/.zot/planning-with-files.json`:

   ```json
   {
     "planningWithFiles": {
       "mode": "auto"
     }
   }
   ```

3. Default: `auto`.

### Tamper protection

`/plan-attest` records the current SHA-256 of `task_plan.md`. Every injection
and `/plan-execute` compares the plan bytes against the recorded hash. On a
mismatch, the extension replaces plan data with:

```text
[planning-with-files] [PLAN TAMPERED - injection blocked]
expected=<hash>
actual=<hash>
Run /plan-attest to re-approve current contents, or restore the file from git.
```

The attestation is an ordinary local SHA-256 value. It detects a plan change
only while the saved digest remains trusted. It is not a keyed signature.

## Lifecycle behavior

The extension uses the lifecycle events and interception points zot provides:

| Behavior                               | zot implementation                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Session catchup on `session_start`     | Startup notification with the phase summary and the `/plan-execute` hint. No host session-store access.          |
| Plan injection on `before_agent_start` | `before_agent_start` intercept appends to the complete system prompt.                                            |
| Pre-tool plan recitation               | Not available without starting a turn. The injected prompt and auto-continue tell the model to re-read the plan. |
| Post-write reminder on `tool_result`   | `notify` reminder after `write` or `edit`. zot cannot append text to a tool result.                              |
| Auto-continue on `agent_end`           | `turn_end` with a terminal stop reason, then `submit` with the continuation prompt, limit 3.                     |
| Pre-compaction reminder                | `pre_compact` notification, including the attested hash when present.                                            |

The extension also:

- warns when `write` or `edit` runs without a `task_plan.md`;
- warns on dangerous bash patterns before approval;
- resets the auto-continue budget when the user submits a new prompt;
- clears execution approval on session start and session end.

## Upstream skill

The extension does not bundle the `planning-with-files` skill. Install it
separately so the model has the three-file workflow instructions. `/pwf` loads
this skill through zot's `tool_prompt` action:

```bash
npx skills add OthmanAdi/planning-with-files --skill planning-with-files -g
```

Invoke it in zot with:

```text
/skill:planning-with-files
```

The extension supplies the commands and lifecycle hooks. The skill supplies the
workflow and templates.

## Project layout

```text
extension.json                          zot manifest
dist/index.js                           committed build output
tsdown.config.ts                        bundle config
src/index.ts                            protocol loop and registration
src/lib/types.ts                        shared protocol and plan types
src/lib/constants.ts                    shared strings and limits
src/lib/plan.ts                         plan selection and status parsing
src/lib/attestation.ts                  SHA-256 attestation
src/lib/runtime.ts                      mode resolution and injection text
src/lib/state.ts                        per-session state
src/lib/commands.ts                     command handlers
src/lib/hooks.ts                        events and before_agent_start
src/lib/pwf.ts                          /pwf and /pwf-status handlers
test/extension.test.ts                  stdio protocol tests
tsconfig.json                           type-checking config
.github/workflows/ci.yml                lint, format, test, bundle check, release
```

## Development

Requirements:

- zot 0.4 or newer.
- Node.js 22.18 or newer. The test runner and `tsdown` use Node's native
  TypeScript type stripping.

Install the development dependencies:

```bash
npm install
```

Build the bundle, lint, format, and test:

```bash
npm run build
npm run lint
npm run format:check
npm test
```

`npm run lint` runs ESLint and `tsc --noEmit`. `npm run format` rewrites the
workspace with Prettier; `npm run format:check` verifies it in CI. `npm test`
rebuilds `dist/index.js` before running the suite. The built bundle is
committed, and CI fails if the committed file differs from a fresh build.

The suite drives the extension over its stdio protocol and covers command
registration, plan status, attestation, approval, injection, tamper blocking,
auto-continue limits, loop ticks, `/pwf` aliases, missing plans, selector
rejection, invalid root pins, and DeepSeek cache-safe mode.

Drive the extension by hand:

```bash
{
  printf '%s\n' '{"type":"hello_ack","protocol_version":1,"zot_version":"test","provider":"anthropic","model":"claude","cwd":"/tmp/project","extension_dir":".","data_dir":"."}'
  sleep 0.2
  printf '%s\n' '{"type":"command_invoked","id":"1","name":"plan-status","args":""}'
  sleep 0.2
  printf '%s\n' '{"type":"shutdown"}'
} | node dist/index.js
```

Set `PWF_DEBUG=1` to log injection and auto-continue decisions to stderr. zot
captures stderr to `$ZOT_HOME/logs/ext-planning-with-files.log`.

## Release

Pushing conventional commits to `master` runs `semantic-release` from the CI
workflow. The release job:

1. derives the next version from the commit history;
2. runs `node src/sync-version.ts <version>` to update `extension.json`,
   `package.json`, `package-lock.json`, and `VERSION` in `src/index.ts`;
3. rebuilds `dist/index.js`;
4. commits `CHANGELOG.md` and the versioned files;
5. tags the release and publishes GitHub release notes.

Run the version sync manually when preparing a release by hand:

```bash
node src/sync-version.ts 0.1.1
npm run build
```

## Troubleshooting

**`No active plan (task_plan.md not found)`**

Create `task_plan.md` in the project root or in `.planning/<slug>/`. Run
`/plan-status` to see the path the extension resolved.

**`Multiple plans are available while session isolation is armed`**

Set `PLAN_ID=<slug>` for the session or remove `.planning/sessions/`. The
extension will not choose a plan for you in this state.

**`PLAN_ID did not resolve to a plan under .planning`**

The selector is a binding. Check the slug and the `.planning/<slug>/task_plan.md`
path. The extension does not fall back to another plan.

**`PWF_PLAN_ROOT does not resolve to an existing absolute directory`**

Set `PWF_PLAN_ROOT` to an absolute existing project root, or unset it.

**`[PLAN TAMPERED - injection blocked]`**

The plan changed after attestation. Run `/plan-attest` to approve the current
bytes, or restore the file from git.

**The plan is not injected**

Check that `/plan-execute` was run in this session, that the mode is not
`notify`, and that the session is attached when session isolation is armed.

**Auto-continue or `/plan-loop` does nothing in print mode**

zot ignores the `submit` frame outside the interactive TUI. Use the interactive
TUI for auto-continue and planning loops.

## Security

- Plan content is wrapped in `===BEGIN PLAN DATA===` and `===END PLAN DATA===`
  and should be treated as data, not instructions.
- Only the approved plan is injected. A tampered plan produces a tamper message
  instead of plan data.
- The attestation is a local hash, not a signature. A process that can replace
  both the plan and the attestation can make new content pass.
- The extension runs with the user's full filesystem permissions, like any zot
  extension.
- External research belongs in `findings.md`. Treat web pages, APIs, and tool
  output as untrusted.

## zot-specific behavior

- Passive status is a startup notification because zot has no extension status
  bar.
- Pre-tool recitation is not available because zot has no non-triggering
  next-turn message. Post-write reminders are notifications.
- The `submit` frame triggers a user prompt. Auto-continue and the planning loop
  therefore add real turns. The three-continue limit bounds the former; the
  loop interval bounds the latter.
- The default loop prompt counts phases in `task_plan.md` directly instead of
  running `scripts/check-complete.sh`, because this extension does not vendor
  the upstream shell scripts.

## License

[MIT](https://opensource.org/licenses/MIT), Copyright (c) 2026 Ahmad Adi.

The planning-with-files workflow and command design come from
[OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files).
