# pi-async-subagents

Pi extension for delegating tasks to subagents with SDK-based execution, agent-scoped extensions/skills/context, async support, output truncation, debug artifacts, and progress tracking.

## 🔓 What This Unlocks

**Define entire agents in markdown files.**

This extension introduces a powerful agent definition system. Drop a `.md` file in `~/.pi/agent/agents/` or `.pi/agents/` and you have a reusable agent with:

- **Custom system prompts** — the markdown body becomes the agent's instructions
- **Model selection** — choose which model powers this agent
- **Tool restrictions** — limit which tools the agent can access
- **`extensions`** — load custom hooks per-agent: validate outputs, block dangerous commands, enforce formats, auto-retry on failure
- **`skills`** — inject skill directories scoped to specific agents
- **`contextFiles`** — provide AGENTS.md-style context only this agent sees

Build **specialized agents with their own behaviors** — a read-only scout that blocks writes, a reviewer that enforces JSON output, a security auditor with its own guidelines — all defined in simple markdown files.

## Features

- **SDK-Based Execution**: Runs agents via `createAgentSession()` instead of subprocess - faster, better integration
- **Agent-Scoped Extensions**: Load extensions only for specific agents via frontmatter
- **Agent-Scoped Skills**: Inject skills only for specific agents
- **Agent-Scoped Context**: Provide AGENTS.md-style context files per agent
- **Live Progress Display**: Real-time visibility during sync execution showing current tool, recent output, tokens, and duration
- **Output Truncation**: Configurable byte/line limits via `maxOutput`
- **Debug Artifacts**: Input/output/metadata files per task
- **Async Status Files**: Durable `status.json`, `events.jsonl`, and markdown logs for async runs
- **Async Widget**: Lightweight TUI widget shows background run progress

## Agent Frontmatter Reference

Define agents in markdown files at `~/.pi/agent/agents/` (user scope) or `.pi/agents/` (project scope):

```markdown
---
name: my-agent
description: Short description for agent listing
model: claude-sonnet-4-20250514
tools: read, bash, grep, find, ls
extensions: ./hooks/enforce-json.ts, ./hooks/block-writes.ts
skills: ./skills/security-checklist
contextFiles: ./REVIEW_GUIDELINES.md
---

Your agent's system prompt goes here...
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | **Required.** Agent identifier |
| `description` | string | **Required.** Short description shown in agent listings |
| `model` | string | Model to use (e.g., `claude-sonnet-4-20250514`). Default: parent's model |
| `tools` | string | Comma-separated list of tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `extensions` | string | **NEW.** Comma-separated paths to extension files (agent-scoped) |
| `skills` | string | **NEW.** Comma-separated paths to skill directories (agent-scoped) |
| `contextFiles` | string | **NEW.** Comma-separated paths to context files like AGENTS.md (agent-scoped) |

### Path Resolution

Paths in `extensions`, `skills`, and `contextFiles` are resolved relative to the agent file's directory:

```
~/.pi/agent/agents/
├── code-reviewer.md        # Agent definition
├── hooks/
│   ├── enforce-json.ts     # Referenced as ./hooks/enforce-json.ts
│   └── block-writes.ts
├── skills/
│   └── security-checklist/
│       └── SKILL.md
└── REVIEW_GUIDELINES.md    # Referenced as ./REVIEW_GUIDELINES.md
```

### Bundled Example Hooks

This extension includes example hooks you can use directly or copy:

```
~/.pi/agent/extensions/subagent/hooks/
├── enforce-json.ts         # Validates output is valid JSON, retries if not
└── read-only-bash.ts       # Blocks write commands in bash
```

Reference them from your agents using absolute paths:
```yaml
extensions: ~/.pi/agent/extensions/subagent/hooks/read-only-bash.ts
```

## Agent-Scoped Extensions

When an agent specifies `extensions`, only those extensions are loaded for that agent. Global extensions from `~/.pi/agent/extensions/` are NOT loaded.

### Example: JSON Output Enforcement

```markdown
---
name: reviewer
description: Code review specialist that outputs JSON
tools: read, grep, find, ls
extensions: ./hooks/enforce-json.ts
---

You are a code reviewer. Output your review in valid JSON format...
```

`hooks/enforce-json.ts`:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    const lastMsg = event.messages?.filter(m => m.role === "assistant").pop();
    if (!lastMsg) return;
    
    const text = lastMsg.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("\n")
      .trim();
    
    try {
      JSON.parse(text);
    } catch {
      // Trigger retry for invalid JSON
      pi.sendMessage({
        customType: "json-retry",
        content: "Output is not valid JSON. Please output ONLY valid JSON, no prose.",
        display: true,
      }, { triggerTurn: true });
    }
  });
}
```

### Example: Read-Only Bash

```markdown
---
name: scout
description: Codebase exploration agent
tools: read, bash, grep, find, ls
extensions: ./hooks/read-only-bash.ts
---

You explore codebases to gather context...
```

`hooks/read-only-bash.ts`:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    
    const cmd = event.input.command as string;
    const writePatterns = /\b(rm|mv|cp|mkdir|touch|chmod|chown|>|>>|tee|sed -i|git commit|git push)\b/;
    
    if (writePatterns.test(cmd)) {
      return { block: true, reason: "This agent is read-only. Write commands are blocked." };
    }
  });
}
```

## Modes

| Mode | Async Support | Notes |
|------|---------------|-------|
| Single | Yes | `{ agent, task }` |
| Chain | Yes | `{ chain: [{agent, task}...] }` with `{previous}` placeholder |
| Parallel | Sync only | `{ tasks: [{agent, task}...] }` - auto-downgrades if async requested |

## Usage

**subagent tool:**
```typescript
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }
{ chain: [{ agent: "scout", task: "find" }, { agent: "worker", task: "fix {previous}" }] }
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
| `tasks` | `{agent, task, cwd?}[]` | - | Parallel tasks (sync only) |
| `chain` | `{agent, task, cwd?}[]` | - | Sequential steps; use `{previous}` |
| `agentScope` | `"user" \| "project" \| "both"` | `user` | Agent discovery scope |
| `async` | boolean | false | Background execution (single/chain only) |
| `cwd` | string | - | Override working directory |
| `maxOutput` | `{bytes?, lines?}` | 200KB, 5000 lines | Truncation limits |
| `artifacts` | boolean | true | Write debug artifacts |
| `includeProgress` | boolean | false | Include full progress in result |
| `share` | boolean | true | Create shareable session log (async mode only) |
| `sessionDir` | string | temp | Directory to store session logs |

## Artifacts

Location: `{sessionDir}/subagent-artifacts/` or `/tmp/pi-subagent-artifacts/`

Files per task:
- `{runId}_{agent}_input.md` - Task prompt
- `{runId}_{agent}_output.md` - Full output (untruncated)
- `{runId}_{agent}_meta.json` - Timing, usage, exit code

## Live Progress (Sync Mode)

During sync execution, the collapsed view shows:
- Current step (for chains): `... chain 2/3 | 8 tools, 1.4k tok, 38s`
- Current agent and tool: `scout: > read: packages/tui/src/...`
- Recent output lines (last 2-3 lines)
- Hint: `(ctrl+o to expand)`

Press **Ctrl+O** to expand the full streaming view with complete output.

## SDK-Based Execution

The subagent tool uses the Pi SDK (`createAgentSession()`) directly instead of spawning subprocess. This provides:

1. **Faster execution**: No process spawn overhead (~500ms saved per agent)
2. **Agent-scoped configuration**: Extensions, skills, and context files only load for the specific agent
3. **Better integration**: Direct access to session events without JSON parsing
4. **Shared model registry**: API keys and model configuration from parent process

### Migration Notes

**Backwards Compatible**: Existing agents without `extensions`, `skills`, or `contextFiles` work unchanged.

**Session Sharing**: Session sharing (`share: true`) is only supported in async mode. Sync mode uses in-memory sessions for performance.

## Events

Emitted events:
- `subagent:started` - When async run starts
- `subagent:complete` - When async run completes

## Files

```
├── index.ts           # Main extension (subagent + subagent_status tools)
├── sdk-runner.ts      # SDK-based agent execution
├── tool-resolver.ts   # Tool name → tool instance resolution
├── loaders.ts         # Skills and context file loaders
├── notify.ts          # Async completion notifications
├── subagent-runner.ts # Async subprocess runner (for async mode)
├── agents.ts          # Agent discovery and config parsing
├── artifacts.ts       # Artifact management
├── types.ts           # Shared types
└── hooks/             # Example agent-scoped extensions
    ├── enforce-json.ts    # JSON output validation with retry
    └── read-only-bash.ts  # Block write commands in bash
```
