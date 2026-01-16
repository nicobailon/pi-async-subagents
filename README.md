# pi-async-subagents

Pi extension for delegating tasks to subagents with async support, chain clarification TUI, output truncation, debug artifacts, progress tracking, and optional session sharing.

## Features (beyond base)

- **Chain Clarification TUI**: Interactive preview/edit of chain templates and behaviors before execution
- **Agent Frontmatter Extensions**: Agents declare default chain behavior (`output`, `defaultReads`, `defaultProgress`)
- **Chain Artifacts**: Shared directory at `/tmp/pi-chain-runs/{runId}/` for inter-step files
- **Solo Agent Output**: Agents with `output` write to temp dir and return path to caller
- **Live Progress Display**: Real-time visibility during sync execution showing current tool, recent output, tokens, and duration
- **Output Truncation**: Configurable byte/line limits via `maxOutput`
- **Debug Artifacts**: Input/output/JSONL/metadata files per task
- **Session Logs**: JSONL session files with paths shown in output
- **Async Status Files**: Durable `status.json`, `events.jsonl`, and markdown logs for async runs
- **Async Widget**: Lightweight TUI widget shows background run progress
- **Session-scoped Notifications**: Async completions only notify the originating session

## Modes

| Mode | Async Support | Notes |
|------|---------------|-------|
| Single | Yes | `{ agent, task }` - agents with `output` write to temp dir |
| Chain | Yes* | `{ chain: [{agent, task}...] }` with `{task}`, `{previous}`, `{chain_dir}` variables |
| Parallel | Sync only | `{ tasks: [{agent, task}...] }` - auto-downgrades if async requested |

*Chain defaults to sync with TUI clarification. Use `clarify: false` to enable async.

## Usage

**subagent tool:**
```typescript
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "scout", task: "investigate", output: false }  // disable file output

// Parallel (sync only)
{ tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }

// Chain with TUI clarification (default)
{ chain: [
  { agent: "scout", task: "Gather context for auth refactor" },
  { agent: "planner" },  // task defaults to {previous}
  { agent: "worker" },   // uses agent defaults for reads/progress
  { agent: "reviewer" }
]}

// Chain without TUI (enables async)
{ chain: [...], clarify: false, async: true }

// Chain with behavior overrides
{ chain: [
  { agent: "scout", task: "find issues", output: false },  // text-only, no file
  { agent: "worker", progress: false }  // disable progress tracking
]}
```

**subagent_status tool:**
```typescript
{ id: "a53ebe46" }
{ dir: "/tmp/pi-async-subagent-runs/a53ebe46-..." }
```

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name (single mode) |
| `task` | string | - | Task string (single mode) |
| `output` | `string \| false` | agent default | Override output file for single agent |
| `tasks` | `{agent, task, cwd?}[]` | - | Parallel tasks (sync only) |
| `chain` | ChainItem[] | - | Sequential steps with behavior overrides (see below) |
| `clarify` | boolean | true (chains) | Show TUI to preview/edit chain; implies sync mode |
| `agentScope` | `"user" \| "project" \| "both"` | `user` | Agent discovery scope |
| `async` | boolean | false | Background execution (requires `clarify: false` for chains) |
| `cwd` | string | - | Override working directory |
| `maxOutput` | `{bytes?, lines?}` | 200KB, 5000 lines | Truncation limits for final output |
| `artifacts` | boolean | true | Write debug artifacts |
| `includeProgress` | boolean | false | Include full progress in result |
| `share` | boolean | true | Create shareable session log |
| `sessionDir` | string | temp | Directory to store session logs |

**ChainItem fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | required | Agent name |
| `task` | string | `{task}` or `{previous}` | Task template (required for first step) |
| `cwd` | string | - | Override working directory |
| `output` | `string \| false` | agent default | Override output filename or disable |
| `reads` | `string[] \| false` | agent default | Override files to read from chain dir |
| `progress` | boolean | agent default | Override progress.md tracking |

Status tool:

| Tool | Description |
|------|-------------|
| `subagent_status` | Inspect async run status by id or dir |

## Agent Frontmatter

Agents can declare default chain behavior in their frontmatter:

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
output: context.md           # writes to {chain_dir}/context.md
defaultReads: context.md     # comma-separated files to read
defaultProgress: true        # maintain progress.md
interactive: true            # (parsed but not enforced in v1)
---
```

**Resolution priority:** step override > agent frontmatter > disabled

## Chain Variables

Templates support three variables:

| Variable | Description |
|----------|-------------|
| `{task}` | Original task from first step (use in subsequent steps) |
| `{previous}` | Output from prior step |
| `{chain_dir}` | Path to chain artifacts directory |

## Chain Directory

Each chain run creates `/tmp/pi-chain-runs/{runId}/` containing:
- `context.md` - Scout/context-builder output
- `plan.md` - Planner output  
- `progress.md` - Worker/reviewer shared progress
- Additional files as written by agents

Directories older than 24 hours are cleaned up on extension startup.

## Artifacts

Location: `{sessionDir}/subagent-artifacts/` or `/tmp/pi-subagent-artifacts/`

Files per task:
- `{runId}_{agent}_input.md` - Task prompt
- `{runId}_{agent}_output.md` - Full output (untruncated)
- `{runId}_{agent}.jsonl` - Event stream (sync only)
- `{runId}_{agent}_meta.json` - Timing, usage, exit code

## Session Logs

Session files (JSONL) are stored under a per-run session dir (temp by default). The session file path is shown in output. Set `sessionDir` to keep session logs outside `/tmp`.

## Live progress (sync mode)

During sync execution, the collapsed view shows:
- Current step (for chains): `... chain 2/3 | 8 tools, 1.4k tok, 38s`
- Current agent and tool: `scout: > read: packages/tui/src/...`
- Recent output lines (last 2-3 lines)
- Hint: `(ctrl+o to expand)`

Press **Ctrl+O** to expand the full streaming view with complete output.

## Async observability

Async runs write a dedicated observability folder:

```
/tmp/pi-async-subagent-runs/<id>/
  status.json
  events.jsonl
  subagent-log-<id>.md
```

`status.json` is the source of truth for async progress and powers the TUI widget. If you already use
`/status <id>` you can keep doing that; otherwise use:

```typescript
subagent_status({ id: "<id>" })
subagent_status({ dir: "/tmp/pi-async-subagent-runs/<id>" })
```

## Events

Async events:
- `subagent:started`
- `subagent:complete`

Legacy events (still emitted):
- `subagent_enhanced:started`
- `subagent_enhanced:complete`

## Files

```
├── index.ts           # Main extension (registerTool)
├── agents.ts          # Agent discovery + frontmatter parsing
├── settings.ts        # Chain behavior resolution, templates, chain dir
├── chain-clarify.ts   # TUI component for chain clarification
├── artifacts.ts       # Artifact management
├── types.ts           # Shared types
├── subagent-runner.ts # Async runner
└── notify.ts          # Async completion notifications
```
