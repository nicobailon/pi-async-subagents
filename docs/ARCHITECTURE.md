# Subagent Extension Architecture

A deep dive into how the subagent system works, from execution modes to real-time steering.

---

## Overview

The subagent extension enables a parent agent to spawn child agents that execute tasks independently. Each subagent runs in its own session with configurable tools, extensions, skills, and context.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Parent Agent Session                         │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                      subagent tool call                        │ │
│  │                                                                │ │
│  │   { agent: "worker", task: "implement feature X" }             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                │                                     │
│                                ▼                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                     Subagent Extension                         │ │
│  │                                                                │ │
│  │  • Resolves agent config from ~/.pi/agent/agents/              │ │
│  │  • Creates SDK session with agent-scoped config                │ │
│  │  • Tracks execution for overlay                                │ │
│  │  • Returns result to parent                                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                │                                     │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │
                                 ▼
              ┌─────────────────────────────────────┐
              │         Child Agent Session         │
              │                                     │
              │  Model: claude-sonnet-4             │
              │  Tools: [read, write, bash, ...]    │
              │  Extensions: [custom-ext]           │
              │  Skills: [planning, review]         │
              │                                     │
              │  ┌───────────────────────────────┐  │
              │  │   Task: implement feature X   │  │
              │  └───────────────────────────────┘  │
              └─────────────────────────────────────┘
```

---

## Execution Modes

### Single Mode

The simplest mode—one agent, one task.

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│    Parent    │────────▶│   Subagent   │────────▶│    Result    │
│              │         │   (worker)   │         │              │
└──────────────┘         └──────────────┘         └──────────────┘

Parameters:
  agent: "worker"
  task: "implement the login feature"
```

### Chain Mode

Sequential execution where each step can reference the previous output via `{previous}`.

```
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│  Step 1 │─────▶│  Step 2 │─────▶│  Step 3 │─────▶│  Result │
│ worker  │      │reviewer │      │ worker  │      │         │
└─────────┘      └─────────┘      └─────────┘      └─────────┘
     │                │                │
     │                │                │
     ▼                ▼                ▼
 "implement"    "review code"    "apply fixes"
                {previous} ◀─────────┘
                     │
                     └──────▶ {previous}

Parameters:
  chain: [
    { agent: "worker",   task: "implement feature" },
    { agent: "reviewer", task: "review: {previous}" },
    { agent: "worker",   task: "apply feedback: {previous}" }
  ]
```

**Chain Flow Detail:**

```
                    ┌─────────────────────────────────────┐
                    │           Chain Execution           │
                    └─────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  Step 1: worker                     │
                    │  Task: "implement feature"          │
                    │                                     │
                    │  Output: "Created login.ts with..." │
                    └─────────────────────────────────────┘
                                      │
                            prev = output
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  Step 2: reviewer                   │
                    │  Task: "review: Created login.ts.." │
                    │         └──── {previous} replaced   │
                    │                                     │
                    │  Output: "Issues found: 1. Missing" │
                    └─────────────────────────────────────┘
                                      │
                            prev = output
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  Step 3: worker                     │
                    │  Task: "apply: Issues found: 1..."  │
                    │         └──── {previous} replaced   │
                    │                                     │
                    │  Output: "Fixed all issues..."      │
                    └─────────────────────────────────────┘
                                      │
                                      ▼
                              Final Result
```

### Parallel Mode

Concurrent execution of multiple independent tasks.

```
                         ┌─────────────┐
                         │   Parent    │
                         └──────┬──────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │   Task 1   │   │   Task 2   │   │   Task 3   │
       │  (scout)   │   │  (scout)   │   │  (scout)   │
       └────────────┘   └────────────┘   └────────────┘
              │                 │                 │
              │    Concurrent   │    Execution    │
              │                 │                 │
              ▼                 ▼                 ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │  Result 1  │   │  Result 2  │   │  Result 3  │
       └────────────┘   └────────────┘   └────────────┘
              │                 │                 │
              └─────────────────┼─────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Aggregated Result   │
                    │   "2/3 succeeded"     │
                    └───────────────────────┘

Parameters:
  tasks: [
    { agent: "scout", task: "investigate auth system" },
    { agent: "scout", task: "investigate database schema" },
    { agent: "scout", task: "investigate API endpoints" }
  ]
```

**Concurrency Control:**

```
MAX_PARALLEL = 8        (max tasks allowed)
MAX_CONCURRENCY = 4     (max running simultaneously)

Tasks: [T1, T2, T3, T4, T5, T6]

Timeline:
─────────────────────────────────────────────────────▶ time

Slot 1: ████ T1 ████                 ████ T5 ████
Slot 2: ████████ T2 ████████         ████ T6 ████
Slot 3: ████ T3 ████
Slot 4: ████████████ T4 ████████████
        │           │               │
        Start       T1,T3 done      T4 done
                    T5,T6 start     All complete
```

---

## SDK-Based Execution

Subagents run via the SDK directly (no subprocess spawning), enabling:
- Agent-scoped extensions, skills, and context
- ~500ms faster execution
- Direct access to session events

```
┌────────────────────────────────────────────────────────────────────┐
│                          runAgentSDK()                             │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Agent Config Resolution                        │
│                                                                     │
│  ~/.pi/agent/agents/worker.md                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ ---                                                        │    │
│  │ model: claude-sonnet-4                                     │    │
│  │ tools: [read, write, bash, edit]                           │    │
│  │ extensions: [./custom-ext]                                 │    │
│  │ skills: [planning]                                         │    │
│  │ thinking: medium                                           │    │
│  │ ---                                                        │    │
│  │ You are a skilled developer...                             │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                     createAgentSession()                           │
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐    │
│  │  Model Config   │  │  Tool Registry  │  │   Extensions    │    │
│  │                 │  │                 │  │                 │    │
│  │ claude-sonnet-4 │  │ read, write,    │  │ ./custom-ext    │    │
│  │ thinking:medium │  │ bash, edit      │  │                 │    │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘    │
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐    │
│  │     Skills      │  │  Context Files  │  │  System Prompt  │    │
│  │                 │  │                 │  │                 │    │
│  │ planning.md     │  │ (agent-scoped)  │  │ "You are a      │    │
│  │                 │  │                 │  │  skilled dev.." │    │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Session Execution                            │
│                                                                     │
│   session.prompt("Task: implement feature X")                       │
│                                                                     │
│   Events:                                                           │
│   ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐   │
│   │ tool_exec_start  │  │  tool_exec_end   │  │  message_end   │   │
│   │                  │  │                  │  │                │   │
│   │ toolName: "read" │  │                  │  │ role:assistant │   │
│   │ args: {path:..}  │  │                  │  │ usage: {...}   │   │
│   └──────────────────┘  └──────────────────┘  └────────────────┘   │
│            │                     │                    │             │
│            └─────────────────────┴────────────────────┘             │
│                                  │                                  │
│                                  ▼                                  │
│                         Progress Callbacks                          │
│                     onProgress(), onMessage()                       │
└────────────────────────────────────────────────────────────────────┘
```

---

## Execution Tracking & Overlay

The overlay provides real-time visibility into running subagents.

### Tracking Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Global Execution State                           │
│                                                                     │
│  activeExecutions: Map<string, ActiveExecution>                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                                                             │   │
│  │  "exec-001" ──▶ { agent: "worker", task: "...", ... }       │   │
│  │  "exec-002" ──▶ { agent: "scout",  task: "...", ... }       │   │
│  │  "exec-003" ──▶ { agent: "scout",  task: "...", ... }       │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  selectedExecutionId: "exec-001"                                    │
│  overlayUpdateCallback: () => void                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ Updates trigger
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SubagentOverlay Component                      │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ ┌─────────────────────────────────────────────────────────┐   │ │
│  │ │ [1] ◐ worker  [2] ◐ scout  [3] ✓ scout                  │   │ │
│  │ ├─────────────────────────────────────────────────────────┤   │ │
│  │ │ ◐ worker (chain 2/3) │ 15 tools │ 8.2k tok │ 1m23s      │   │ │
│  │ ├─────────────────────────────────────────────────────────┤   │ │
│  │ │ Task: implement the authentication feature              │   │ │
│  │ │ ▶ edit: src/auth/login.ts                               │   │ │
│  │ ├─────────────────────────────────────────────────────────┤   │ │
│  │ │ Output (42 lines)                                       │   │ │
│  │ ├─────────────────────────────────────────────────────────┤   │ │
│  │ │ Now implementing the login function...                  │   │ │
│  │ │ Adding password validation...                           │   │ │
│  │ │ Creating session token...                               │   │ │
│  │ │                                                         │   │ │
│  │ ├─────────────────────────────────────────────────────────┤   │ │
│  │ │ ↑35                                                     │   │ │
│  │ ├─────────────────────────────────────────────────────────┤   │ │
│  │ │ [q/Esc] Close  [↑/↓] Scroll  [i] Input  [Tab] Switch    │   │ │
│  │ └─────────────────────────────────────────────────────────┘   │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Overlay Controls

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Keyboard Controls                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Navigation                                                         │
│  ──────────                                                         │
│  q / Esc      Close overlay                                         │
│  ↑ / k        Scroll up one line                                    │
│  ↓ / j        Scroll down one line                                  │
│  PgUp         Scroll up 10 lines                                    │
│  PgDn         Scroll down 10 lines                                  │
│  Home / g     Jump to beginning                                     │
│  End / G      Jump to end (most recent)                             │
│                                                                     │
│  Multi-Agent (when multiple agents running)                         │
│  ───────────                                                        │
│  Tab          Switch to next agent                                  │
│  Shift+Tab    Switch to previous agent                              │
│  1-9          Jump to agent by number                               │
│                                                                     │
│  Steering                                                           │
│  ────────                                                           │
│  i            Enter input mode                                      │
│  Enter        Send message (in input mode)                          │
│  Esc          Exit input mode                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Steering

Steering allows you to inject messages into a running subagent session.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Steering Flow                                │
└─────────────────────────────────────────────────────────────────────┘

  User Input                    Subagent Session
  ──────────                    ────────────────

  ┌──────────┐
  │ Press 'i'│
  └────┬─────┘
       │
       ▼
  ┌──────────────────┐
  │ > focus on tests │  ◀── User types message
  └────────┬─────────┘
           │
           │ Enter
           ▼
  ┌──────────────────┐         ┌─────────────────────────────────┐
  │  exec.steer()    │────────▶│  session.steer("focus on tests")│
  └──────────────────┘         └─────────────────────────────────┘
                                              │
                                              ▼
                               ┌─────────────────────────────────┐
                               │  Message queued for delivery    │
                               │  after current tool completes   │
                               └─────────────────────────────────┘
                                              │
                                              ▼
                               ┌─────────────────────────────────┐
                               │  Agent receives steering msg    │
                               │  and adjusts behavior           │
                               └─────────────────────────────────┘


Timeline:
─────────────────────────────────────────────────────────────────────▶

Agent working...   ████████████████
                                   │
                        steer("focus on tests")
                                   │
                                   ▼
Current tool finishes              │
                                   ▼
                   ┌───────────────────────────────┐
                   │ Agent: "Got it! I'll focus    │
                   │ on writing tests now..."      │
                   └───────────────────────────────┘
                                   │
                                   ▼
Agent continues...                 ████████████████████████
```

### Steering Implementation

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SDK Runner Setup                                │
│                                                                     │
│  const { session } = await createAgentSession({ ... });             │
│                                                                     │
│  // Expose steer function to overlay                                │
│  if (onSessionReady) {                                              │
│      onSessionReady(session.steer.bind(session));                   │
│  }                    ▲                                             │
│                       │                                             │
└───────────────────────┼─────────────────────────────────────────────┘
                        │
                        │ Stored in ActiveExecution
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Execution Tracking                              │
│                                                                     │
│  updateActiveExecution(executionId, { steer });                     │
│                                                                     │
│  activeExecutions.get(id) = {                                       │
│      id: "exec-001",                                                │
│      agent: "worker",                                               │
│      steer: (msg) => Promise<void>,  ◀── Function reference        │
│      ...                                                            │
│  }                                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                        │
                        │ Called from overlay
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Overlay Input Handler                           │
│                                                                     │
│  this.input.onSubmit = (value) => {                                 │
│      const exec = getSelectedExecution();                           │
│      if (exec.steer) {                                              │
│          exec.steer(value).catch(handleError);                      │
│      }                                                              │
│  };                                                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Context Inheritance

Subagents can inherit the parent session's conversation history.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      subagent tool call                             │
│                                                                     │
│   {                                                                 │
│     agent: "worker",                                                │
│     task: "implement the add todo feature",                         │
│     inheritContext: true    ◀── Passes parent conversation          │
│   }                                                                 │
└─────────────────────────────────────────────────────────────────────┘

Or via the /background slash command (inherits automatically):

  /background worker implement the add todo feature
```

**How it works:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Parent Session                                  │
│                                                                     │
│  Messages:                                                          │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ [user]      "Let's build a todo app"                       │    │
│  │ [assistant] "I'll help you build that..."                  │    │
│  │ [user]      "Use React and TypeScript"                     │    │
│  │ [assistant] "Great choices! Let me start..."               │    │
│  │ [toolResult] { read: "package.json" ... }                  │    │
│  │ [assistant] "I see the project structure..."               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                │                                    │
│                                │ inheritContext: true               │
│                                ▼                                    │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Subagent Session                                │
│                                                                     │
│  Pre-loaded Messages (from parent):                                 │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ [user]      "Let's build a todo app"                       │    │
│  │ [assistant] "I'll help you build that..."                  │    │
│  │ [user]      "Use React and TypeScript"                     │    │
│  │ [assistant] "Great choices! Let me start..."               │    │
│  │ [toolResult] { read: "package.json" ... }                  │    │
│  │ [assistant] "I see the project structure..."               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  + New Task:                                                        │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ [user]      "Task: implement the add todo feature"         │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  The subagent now has full context of the conversation!             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Error Handling & Cleanup

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Chain Execution with Cleanup                      │
└─────────────────────────────────────────────────────────────────────┘

try {
    for (step of chain) {
        ┌─────────────────────────────────────┐
        │           Execute Step              │
        │                                     │
        │  setActiveExecution(stepExec)       │──▶ Updates overlay
        │  result = await runSync(...)        │
        │                                     │
        └─────────────────────────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  exitCode !== 0 ?   │
              └─────────────────────┘
                    │         │
                   Yes        No
                    │         │
                    ▼         ▼
        ┌──────────────┐  Continue to
        │ CLEANUP      │  next step
        │              │      │
        │ clearCompleted│      │
        │ Executions() │      │
        │              │      │
        │ return error │      │
        └──────────────┘      │
                              ▼
                    ┌─────────────────────┐
                    │   All steps done    │
                    │                     │
                    │ clearCompleted      │
                    │ Executions()        │
                    │                     │
                    │ return success      │
                    └─────────────────────┘
}
catch (err) {
    ┌─────────────────────────────────────┐
    │           CLEANUP                   │
    │                                     │
    │  clearCompletedExecutions()         │
    │  throw err                          │
    │                                     │
    └─────────────────────────────────────┘
}
```

---

## File Structure

```
~/.pi/agent/extensions/subagent/
├── index.ts              Main extension entry point
│                         - Tool definitions (subagent, subagent_status)
│                         - Execution tracking (activeExecutions Map)
│                         - SubagentOverlay component
│                         - Chain/parallel/single execution logic
│
├── sdk-runner.ts         SDK-based agent execution
│                         - createAgentSession() wrapper
│                         - Progress tracking (tool events)
│                         - Steering support (onSessionReady)
│                         - Message collection
│
├── agents.ts             Agent discovery and config
│                         - Scans ~/.pi/agent/agents/
│                         - Parses frontmatter (model, tools, etc.)
│                         - Resolves agent-scoped paths
│
├── types.ts              Shared type definitions
│                         - AgentProgress, ArtifactConfig
│                         - MaxOutputConfig, TruncationResult
│
├── loaders.ts            Dynamic loading utilities
│                         - loadSkillsFromPaths()
│                         - loadContextFilesFromPaths()
│
├── tool-resolver.ts      Tool name to instance mapping
│                         - Maps "read" → Read tool instance
│                         - Handles extension tool paths
│
├── artifacts.ts          Debug artifact management
│                         - Input/output file writing
│                         - Metadata JSON
│                         - Cleanup of old artifacts
│
├── notify.ts             System notifications
│                         - macOS notification support
│                         - Async completion alerts
│
└── hooks/                Agent behavior hooks
    ├── read-only-bash.ts   Bash restrictions
    └── enforce-json.ts     JSON output enforcement
```

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   1. Tool Call                                                      │
│   ───────────                                                       │
│   Parent agent calls subagent tool with parameters                  │
│                                                                     │
│                              │                                      │
│                              ▼                                      │
│                                                                     │
│   2. Agent Resolution                                               │
│   ───────────────────                                               │
│   Load agent config from ~/.pi/agent/agents/{name}.md               │
│   Parse frontmatter: model, tools, extensions, skills, etc.         │
│                                                                     │
│                              │                                      │
│                              ▼                                      │
│                                                                     │
│   3. Session Creation                                               │
│   ───────────────────                                               │
│   createAgentSession() with agent-scoped config                     │
│   Register execution in activeExecutions Map                        │
│   Setup progress callbacks                                          │
│                                                                     │
│                              │                                      │
│                              ▼                                      │
│                                                                     │
│   4. Task Execution                                                 │
│   ─────────────────                                                 │
│   session.prompt("Task: ...")                                       │
│   Agent uses tools, generates output                                │
│   Progress updates flow to overlay                                  │
│                                                                     │
│                              │                                      │
│                              ▼                                      │
│                                                                     │
│   5. Completion                                                     │
│   ──────────────                                                    │
│   Mark execution complete                                           │
│   Cleanup session (dispose, unsubscribe)                            │
│   Return result to parent                                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Quick Reference

| Mode | Parameter | Use Case |
|------|-----------|----------|
| Single | `agent` + `task` | One agent, one task |
| Chain | `chain: [{agent, task}, ...]` | Sequential with `{previous}` |
| Parallel | `tasks: [{agent, task}, ...]` | Concurrent independent tasks |

| Feature | Parameter | Description |
|---------|-----------|-------------|
| Context Inheritance | `inheritContext: true` | Pass parent conversation to subagent |
| Async Execution | `async: true` | Run in background, return immediately |
| Output Truncation | `maxOutput: {lines, bytes}` | Limit returned output size |

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+O` | Open subagent overlay |
| `/background <agent> <task>` | Quick subagent with inherited context |
