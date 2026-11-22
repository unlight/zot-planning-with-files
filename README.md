# planning-with-files for zot

A zot extension for the `planning-with-files` workflow. It keeps the
three-file workflow (`task_plan.md`, `findings.md`, `progress.md`) on disk and
adds plan status, attestation, execution approval, goal, and loop commands. A
trimmed zot-specific skill is bundled with the extension.

- Repository: <https://github.com/unlight/zot-planning-with-files>
- Upstream project: <https://github.com/OthmanAdi/planning-with-files>
- zot extension protocol: <https://github.com/patriceckhart/zot/blob/main/docs/extensions.md>

## Quick start

1. Install the extension from GitHub:

   ```bash
   zot ext install https://github.com/unlight/zot-planning-with-files.git
   ```

   Or clone and install locally:

   ```bash
   git clone https://github.com/unlight/zot-planning-with-files.git
   zot ext install ./zot-planning-with-files
   ```

   Or load a working copy for one session:

   ```bash
   zot --ext /path/to/zot-planning-with-files
   ```

2. The extension bundles the zot-specific skill
   `pwf:planning`. No separate skill install is required. `/pwf` loads it
   automatically.

   If an older upstream `planning-with-files` skill is still installed, remove
   it to avoid two conflicting instruction sets. The bundled skill includes the
   three file templates.

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

## Typical workflow

A small feature is enough to show the full loop. The extension supplies the
bundled skill and hooks. The example keeps the three files under
`.planning/<slug>/`.

### 1. Start the plan

```text
/pwf Build a Python CLI todo app with add, list, and delete commands.
```

The extension loads the bundled `pwf:planning` skill and passes
the task to it. The model creates:

```text
task_plan.md
findings.md
progress.md
```

Review `.planning/<slug>/task_plan.md` before approving it. Edit the phases,
scope, and completion criteria now. The plan stays passive and is not injected
into model context until `/plan-execute`.

### 2. Inspect and lock the plan

```text
/plan-status
/plan-attest
```

`/plan-status` shows the selected plan, scope, phase counts, attestation state,
and whether execution is active. `/plan-attest` records the SHA-256 of the
current `task_plan.md`. If you edit the plan afterwards, run `/plan-attest`
again; a changed plan is refused at injection and by `/plan-execute`.

### 3. Approve execution

```text
/plan-execute
```

This activates plan injection, post-write reminders, and auto-continue for the
current session. Approval is session-scoped and is cleared when the session
ends.

### 4. Work the plan

Ask the model to execute the current phase, or tell it to continue. The model
updates `progress.md`, marks phase status in `task_plan.md`, and proceeds. After
a terminal turn, the extension submits a continuation prompt only while a phase
is `in_progress`, up to three times per user prompt. If the next phase is
`pending` or `blocked`, the session stops at a checkpoint. Mark the next phase
`in_progress` when you want the agent to continue.

Optional goal text appended to auto-continue prompts:

```text
/plan-goal all tests pass and the CLI handles add, list, and delete
```

Optional periodic tick for a long run:

```text
/plan-loop
```

Stop the tick with:

```text
/plan-loop stop
```

### 5. Check progress

```text
/pwf-status
```

`/pwf-status` prints a compact block with the plan, scope, mode, attestation,
execution state, current phase, and phase counts. `/plan-status` prints the same
information with more detail.

### 6. Finish and reset

When every phase has `**Status:** complete`, the extension stops auto-continue
and reports:

```text
[planning-with-files] ALL PHASES COMPLETE
```

Close the plan with:

```text
/plan-close
```

This appends `<!-- pwf: closed -->`, clears execution approval, and clears the
attestation because the marker changes the plan bytes. Use `/plan-execute reset`
when you only want to stop hooks without closing the plan.

To reopen a closed plan:

```text
/plan-close clear
/plan-attest
/plan-execute
```

### 7. Resume after a restart

Execution approval does not survive a restart. On a new session, inspect the
plan and approve it again:

```text
/plan-status
/plan-execute
```

The three files on disk are the source of truth. The model re-reads them and
continues from the current phase.

For upstream walkthroughs, see the
[upstream quickstart](https://github.com/OthmanAdi/planning-with-files/blob/master/docs/quickstart.md),
[workflow guide](https://github.com/OthmanAdi/planning-with-files/blob/master/docs/workflow.md),
and the
[todo-app example](https://github.com/OthmanAdi/planning-with-files/blob/master/examples/README.md).

## Commands

| Command                             | Arguments           | Behavior                                                                                            |
| ----------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `/pwf [task]`                       | optional task       | Load the bundled `pwf:planning` skill and start the workflow.                                       |
| `/pwf-status`                       | none                | Show a compact status block: plan, scope, mode, attestation, current phase, and phase counts.       |
| `/plan-status`                      | none                | Show the selected plan path, scope, plan ID, phase counts, attestation state, and execution state.  |
| `/plan-status <slug>`               | plan slug           | Show one plan read-only without changing `.active_plan` or execution approval.                      |
| `/plan-status --target <slug>`      | plan slug           | Same as `/plan-status <slug>`.                                                                      |
| `/plan-attest`                      | none                | Record the SHA-256 of `task_plan.md` in `.planning/<id>/.attestation` or `./.plan-attestation`.     |
| `/plan-attest --show`               | none                | Print the stored hash, the current hash, and whether they match.                                    |
| `/plan-attest --clear`              | none                | Remove the attestation and reopen the plan for editing.                                             |
| `/plan-attest --target <plan-id>`   | plan ID             | Attest one named plan explicitly.                                                                   |
| `/plan-list`                        | none                | List live and archived plans with branch, closed state, phase counts, modification time, and state. |
| `/plan-use <slug>`                  | plan slug           | Select a plan, bind it to the current branch, write `.active_plan`, and clear execution approval.   |
| `/plan-close`                       | none                | Close a completed plan: append `<!-- pwf: closed -->`, clear approval, stop auto-continue.          |
| `/plan-close --force`               | none                | Close an incomplete plan. Without it, an incomplete plan is refused.                                |
| `/plan-close clear`                 | none                | Remove the closed marker and reopen the plan for attestation and execution.                         |
| `/plan-execute`                     | none                | Approve the selected plan for this session and activate hooks. Refuses a tampered plan.             |
| `/plan-execute reset`               | none                | Return the selected plan to passive review mode.                                                    |
| `/plan-goal <text>`                 | goal text           | Set the continuation goal appended to auto-continue prompts.                                        |
| `/plan-goal default`                | none                | Use `all phases in task_plan.md report Status: complete`.                                           |
| `/plan-goal clear`                  | none                | Clear the session goal.                                                                             |
| `/plan-loop`                        | none                | Start the default 10 minute planning tick.                                                          |
| `/plan-loop <interval>`             | `^\d+[smhd]$`       | Start a tick with a custom interval, for example `5m` or `1h`.                                      |
| `/plan-loop <interval> <prompt...>` | interval and prompt | Start a tick with a custom prompt.                                                                  |
| `/plan-loop stop`                   | none                | Stop the session loop.                                                                              |

Most `/plan-*` names are compatible with upstream `planning-with-files`. `/plan-list` and `/plan-use` are zot-specific branch selection
commands. `/pwf` and `/pwf-status` are host-style aliases.

## Plan selection

The extension starts from `hello_ack.cwd` and walks up to the nearest directory
with `.planning/`. The walk stops at `.git` or the filesystem root.

Selection is branch-aware. The extension reads the current git branch from
`.git/HEAD`, including linked worktrees where `.git` is a file.

Selection order:

1. `PWF_PLAN_ROOT`, when set. It must be an absolute existing directory. An
   invalid pin is refused. The extension does not fall back to another plan.
2. `PLAN_ID`, when set. It must name a contained
   `.planning/<slug>/task_plan.md`. An invalid selector is refused. The
   extension does not fall back to another plan.
3. Plans whose `.planning/<slug>/.branch` matches the current branch.
4. `.planning/.active_plan`, but only when it points to a plan bound to the
   current branch.
5. If exactly one plan matches the current branch, use it.
6. If exactly one unbound plan exists and no plans belong to other branches,
   bind it to the current branch and use it.
7. If several plans match the branch, refuse. Run `/plan-list` and
   `/plan-use <slug>`.
8. If no plan matches the branch, refuse. Plans bound to other branches are
   never injected.
9. Plans under `.planning/.archive/<slug>/` are listed by `/plan-list` but are
   never selected. If archived plans exist and `.active_plan` is missing, the
   extension refuses selection until `/plan-use <slug>` writes a pointer.

The extension no longer chooses the newest plan by mtime when more than one plan
is available. That fallback caused plans, `progress.md`, and `findings.md` from
one branch to be injected into another branch.

`/plan-list` includes a `state` column with `live` or `archived`. Archived plans
are visible for reference but never injected.

A plan can be bound to a branch explicitly:

```text
/plan-use sposs-22191
```

This writes `.planning/sposs-22191/.branch`, writes
`.planning/.active_plan`, and clears execution approval for the current session.

The branch sidecar is separate from `task_plan.md`, so it does not change the
plan bytes or invalidate the attestation.

Keep planning state out of git when it is private:

```text
.planning/
.plan-attestation
```

### Parallel branches

The most robust isolation is a separate git worktree per branch:

```bash
git worktree add ../sposs-feature-a feature/a
git worktree add ../sposs-feature-b feature/b
```

Ignored files such as `.planning/` are per worktree, so plans cannot leak across
branches. Run zot inside the worktree you are working on.

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

## Phase statuses and auto-continue

The extension reads four phase statuses from `task_plan.md`:

```text
pending
in_progress
complete
blocked
```

Auto-continue runs only while at least one phase is `in_progress`. When the last
active phase becomes `complete`, `pending`, or `blocked`, the extension stops
submitting continuation prompts and waits for the next user message. This keeps
an approved plan from being pushed through phases that have not been started or
are waiting on a human decision.

`blocked` is a zot extension status. The upstream `check-complete.sh` validator
only accepts `pending`, `in_progress`, and `complete`.

### Closing a plan

`/plan-close` appends the closed marker to `task_plan.md`:

```markdown
<!-- pwf: closed -->
```

It also clears execution approval for every session and stops auto-continue.
Because the marker changes the plan bytes, the command clears the attestation as
well. Reopen the plan with `/plan-close clear`, then run `/plan-attest` and
`/plan-execute` again.

An incomplete plan is refused. Use `/plan-close --force` to close it anyway:

```text
[plan-close] Plan is incomplete (4/7).
Run /plan-close --force to close it anyway.
```

The plan write uses a temporary file and rename, so an interrupted close does
not leave a partially written `task_plan.md`.

When the last phase becomes `complete`, the extension stops auto-continue and
reports `ALL PHASES COMPLETE` once per session. Run `/plan-close` to stop
injection and later-session reminders. Closing is the explicit "work finished"
state; leaving a completed plan open keeps it active for future prompts.

Closing does not delete the planning files. Use a new plan for the next task
instead of reopening a completed plan.

## Lifecycle behavior

The extension uses the lifecycle events and interception points zot provides:

| Behavior                               | zot implementation                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session catchup on `session_start`     | Startup notification with the phase summary, plus `/plan-execute` or `/plan-close` when all phases are complete. No session-store access.                                       |
| Plan injection on `before_agent_start` | `before_agent_start` intercept appends to the complete system prompt.                                                                                                           |
| Pre-tool plan recitation               | Not available without starting a turn. The injected prompt and auto-continue tell the model to re-read the plan.                                                                |
| Post-write reminder on `tool_result`   | `notify` reminder after `write` or `edit`. zot cannot append text to a tool result.                                                                                             |
| Auto-continue on `agent_end`           | `turn_end` with a terminal stop reason, then `submit` with the continuation prompt, limit 3, only while a phase is `in_progress`. Reports all phases complete once per session. |
| Pre-compaction reminder                | `pre_compact` notification, including the attested hash when present.                                                                                                           |

The extension also:

- warns when `write` or `edit` runs without a `task_plan.md`;
- resets the auto-continue budget when the user submits a new prompt;
- reports all phases complete once per session and suggests `/plan-close`;
- clears execution approval on session start and session end.

## Bundled skill

The extension bundles a trimmed zot-specific skill derived from
[upstream planning-with-files](https://github.com/OthmanAdi/planning-with-files):

```text
skills/planning-with-files/SKILL.md
skills/planning-with-files/templates/task_plan.md
skills/planning-with-files/templates/findings.md
skills/planning-with-files/templates/progress.md
skills/planning-with-files/LICENSE
```

zot namespaces extension skills, so the canonical name is
`pwf:planning`. `/pwf` loads it through the `skill` tool.

The bundled skill covers the three files, phase format, budgets, branch-aware
selection, close marker, and archive behavior. It intentionally omits the
upstream Claude Code hooks and utility scripts. Upstream is MIT licensed; the
notice is kept in `skills/planning-with-files/LICENSE`.

If the external upstream skill is also installed, zot sees two separate names:
`planning-with-files` and `pwf:planning`. Remove the external
one unless you explicitly want both instruction sets.

## Project layout

```text
extension.json                          zot manifest
dist/index.js                           committed build output
tsdown.config.ts                        bundle config
src/index.ts                            protocol loop and registration
src/lib/types.ts                        shared protocol and plan types
src/lib/constants.ts                    shared strings and limits
src/lib/branch.ts                       git branch detection
src/lib/plan.ts                         status parsing and public plan API
src/lib/plan-paths.ts                   plan paths, candidates, and branch sidecars
src/lib/plan-select.ts                  branch-aware plan selection
src/lib/plan-commands.ts                /plan-list and /plan-use handlers
src/lib/attestation.ts                  SHA-256 attestation
src/lib/close.ts                        /plan-close handler
src/lib/runtime.ts                      mode resolution and injection text
src/lib/state.ts                        per-session state
src/lib/commands.ts                     command handlers
src/lib/hooks.ts                        events and before_agent_start
src/lib/pwf.ts                          /pwf and /pwf-status handlers
skills/planning-with-files/SKILL.md     bundled zot planning skill
skills/planning-with-files/templates/   plan, findings, and progress templates
skills/planning-with-files/LICENSE      upstream MIT notice
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

### Provenance

The lifecycle handlers in `src/lib/hooks.ts` are ported from the upstream
`planning-with-files` extension runtime (`runtime.ts`). The zot event mapping
and injection semantics follow zot's extension protocol.

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
   `package.json`, and `package-lock.json`;
3. rebuilds `dist/index.js`, which imports the manifest name and version;
4. commits `CHANGELOG.md` and the versioned files;
5. tags the release and publishes GitHub release notes.

Run the version sync manually when preparing a release by hand:

```bash
node src/sync-version.ts 0.1.1
npm run build
```

## Troubleshooting

**`No active plan (task_plan.md not found)`**

Create `.planning/<slug>/task_plan.md`. Run `/plan-status` to see the path the
extension resolved.

**`Multiple plans are available for branch <branch>`**

Several plans match the current branch. Run `/plan-list`, then
`/plan-use <slug>`. `PLAN_ID=<slug>` also works for automation. The extension
does not choose by mtime.

**`No plan is bound to branch <branch>`**

The only plans on disk belong to other branches. Run `/plan-list` to see them.
Use `/plan-use <slug>` to rebind one to the current branch, or create a new plan.

**`Archived plans exist and .active_plan is missing`**

Upstream `set-active-plan.sh --archive` removes `.active_plan`. Run `/plan-list`,
then `/plan-use <slug>` to choose a live plan. The extension will not fall back
to another live plan on its own.

**`Branch changed: <old> -> <new>`**

The branch changed during the session. Execution approval, auto-continue, and
the session loop were cleared. Run `/plan-status`, then `/plan-execute` for the
current branch.

**`PLAN_ID did not resolve to a plan under .planning`**

The selector is a binding. Check the slug and the `.planning/<slug>/task_plan.md`
path. The extension does not fall back to another plan.

**`PWF_PLAN_ROOT does not resolve to an existing absolute directory`**

Set `PWF_PLAN_ROOT` to an absolute existing project root, or unset it.

**`[PLAN TAMPERED - injection blocked]`**

The plan changed after attestation. Run `/plan-attest` to approve the current
bytes, or restore the file from git.

**The plan is not injected**

Check that `/plan-execute` was run in this session and that the mode is not
`notify`.

**Auto-continue or `/plan-loop` does nothing in print mode**

zot ignores the `submit` frame outside the interactive TUI. Use the interactive
TUI for auto-continue and planning loops.

## Logging

Plan selection and sent notifications are written to the extension log without
`PWF_DEBUG`:

```text
[planning-with-files] selection scope=scoped plan=sposs-22191 rule=single-branch branch=feature/a
[planning-with-files] notify info startup: 5/5 phases complete - run /plan-close when the task is done
```

`PWF_DEBUG=1` adds detailed injection messages. Selection logs are deduplicated
until the plan, rule, or branch changes.

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
- Identical consecutive notifications are dropped until the next real user
  prompt. zot adds the extension label itself, so notification text is sent
  without the internal `[planning-with-files]` prefix.
- The default loop prompt counts phases in `task_plan.md` directly instead of
  running `scripts/check-complete.sh`, because this extension does not vendor
  the upstream shell scripts.

## License

[MIT](https://opensource.org/licenses/MIT), Copyright (c) 2026

The planning-with-files workflow and command design come from
[OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files).
