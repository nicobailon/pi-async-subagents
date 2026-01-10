# pi-async-subagents

> ⚠️ **Experimental Prototype** — This extension is under active development and not yet recommended for general use. APIs may change, bugs are expected, and features are incomplete. Stabilization coming soon.

Pi extension for delegating tasks to subagents with SDK-based execution, agent-scoped extensions/skills/context, async support, output truncation, debug artifacts, and progress tracking.

<img width="1257" alt="Subagent overlay showing real-time execution" src="https://github.com/user-attachments/assets/1dc51d03-cd0c-45b4-92aa-8021523460d1" />

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
- **Context Inheritance**: Subagents can inherit the parent session's conversation history
- **`/background` Slash Command**: Quick invocation with inherited context
- **Ctrl+Shift+O Overlay**: Full-screen interactive view with steering, interrupt, and multi-agent support
- **Subagent Steering**: Send messages to running subagents via overlay input mode
- **Interrupt/Abort**: Kill stuck operations or terminate sessions from the overlay
- **Streaming Bash Output**: Real-time preview of bash command output in overlay
- **Multi-Agent Tracking**: Tab between parallel agents, see status of each
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
thinking: high
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
| `thinking` | string | Extended thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`* |
| `tools` | string | Comma-separated list of tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `extensions` | string | Comma-separated paths to extension files (agent-scoped) |
| `skills` | string | Comma-separated paths to skill directories (agent-scoped) |
| `contextFiles` | string | Comma-separated paths to context files like AGENTS.md (agent-scoped) |

\* `xhigh` is only supported by certain models (e.g., `claude-sonnet-4-20250514`). Using it with unsupported models like `claude-opus-4-5-20250514` will cause an API error. Most models support up to `high`.

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
| `inheritContext` | boolean | false | Inherit parent session's conversation context |

## Context Inheritance

When `inheritContext: true`, the subagent receives the parent session's full conversation history before executing its task. This allows subagents to "see" what the user has been discussing and make decisions based on that context.

**Use cases:**
- Background research that needs to understand the current conversation topic
- Parallel workers that need shared context about the project state
- Specialist agents that need to understand prior decisions

**Example:**
```typescript
// Subagent inherits the full conversation and can reference prior discussion
{ agent: "researcher", task: "find relevant docs for what we discussed", inheritContext: true }
```

**Chain behavior:** For chains, only the **first step** inherits parent context. Subsequent steps receive their context via the `{previous}` placeholder from the prior step.

**Note:** Context inheritance requires sync mode. If `async: true` is also specified, it auto-downgrades to sync (the subprocess runner doesn't have access to parent session state).

## `/background` Slash Command

Quick way to run a subagent with inherited context directly from the chat:

```
/background <agent> <task>
```

**Examples:**
```
/background scout find all TODO comments in this codebase
/background researcher look up the API we discussed earlier
/background worker implement the changes we talked about
```

The command:
1. Inherits the full parent session context (the subagent sees your conversation history)
2. Runs synchronously (you see the result immediately)
3. Injects the result back into the session, triggering the main agent to respond

This is equivalent to calling the subagent tool with `inheritContext: true`, but faster to type.

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
- Hint: `(ctrl+shift+o for overlay)`

Press **Ctrl+Shift+O** to expand the full streaming view with:
- Complete scrollable output history
- Tool calls as they happen (`▶ toolName: args`)
- Streaming bash output (last 5 lines, live updates)
- Chain handoff previews showing `{previous}` content
- Steering input, interrupt, and abort controls

## Interactive Overlay (Ctrl+Shift+O)

During any sync subagent execution, press **Ctrl+Shift+O** to open a full-screen interactive overlay:

**What it shows:**
- Agent name, task, and execution mode (single/chain step N/M/parallel N/M)
- Real-time progress: tool count, tokens, elapsed time
- Current tool being executed with arguments
- Animated spinner (`⠋ Working...`) when waiting for LLM response
- Tool calls logged as they happen (`▶ read: src/file.ts`)
- Streaming bash output (last 5 lines, updates in real-time)
- Chain handoff preview showing what `{previous}` contains between steps
- Completion status (success/error)

**Controls:**
| Key | Action |
|-----|--------|
| **q** / **Esc** | Close overlay |
| **↑/↓** / **j/k** | Scroll output (when content is scrollable) |
| **PgUp/PgDn** | Scroll 10 lines |
| **Home/End** | Jump to start/end |
| **i** | Enter input mode (steer the subagent) |
| **x** | Interrupt - abort current tool, session ends |
| **X** | Abort - kill entire subagent session |
| **Tab** / **Shift+Tab** | Switch between parallel agents |
| **1-9** | Jump to specific agent (parallel mode) |

**Input Mode:**
Press `i` to send a steering message to the running subagent. Type your message and press Enter. The subagent will receive it after the current tool completes. Press Esc to cancel without sending.

**Interrupt vs Abort:**
- `[x]` Interrupt: Kills the current stuck operation (e.g., hanging bash command). The session ends.
- `[X]` Abort: Forcefully terminates the entire subagent session immediately.

**Multi-Agent Support:**
For parallel mode, the overlay tracks all running agents. Use Tab to cycle between them or press 1-9 to jump directly. Each agent shows a status icon: `◐` running, `✓` success, `✗` failed.

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
