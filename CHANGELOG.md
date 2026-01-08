# Changelog

## [Unreleased]

### Added
- **SDK-based execution**: Sync mode now uses `createAgentSession()` directly instead of spawning subprocesses
- **Agent-scoped extensions**: New `extensions` frontmatter field to load extensions only for specific agents
- **Agent-scoped skills**: New `skills` frontmatter field to inject skills only for specific agents
- **Agent-scoped context**: New `contextFiles` frontmatter field for per-agent AGENTS.md-style context
- New `sdk-runner.ts` module for SDK-based agent execution
- New `tool-resolver.ts` module for mapping tool names to tool instances
- New `loaders.ts` module for loading skills and context files from paths
- Live progress display for sync subagents (single and chain modes)
- Shows current tool, recent output lines, token count, and duration during execution
- Ctrl+O hint during sync execution to expand full streaming view
- Throttled updates (150ms) for smoother progress display
- Updates on tool_execution_start/end events for more responsive feedback
- Extension API support (registerTool) with `subagent` tool name
- Session logs (JSONL + HTML export) and optional share links via GitHub Gist
- `share` and `sessionDir` parameters for session retention control
- Async events: `subagent:started`/`subagent:complete` (legacy events still emitted)
- Share info surfaced in TUI and async notifications
- Async observability folder with `status.json`, `events.jsonl`, and `subagent-log-*.md`
- `subagent_status` tool for inspecting async run state
- Async TUI widget for background runs

### Changed
- Sync mode now uses SDK directly for ~500ms faster execution per agent
- Session sharing (`share: true`) only supported in async mode (sync uses in-memory sessions)
- Parallel mode auto-downgrades to sync when async:true is passed (with note in output)
- TUI now shows "parallel (no live progress)" label to set expectations
- Tools passed via agent config can include extension paths (forwarded via `--extension`)

### Fixed
- Async widget elapsed time now freezes when job completes instead of continuing to count up
- Progress data now correctly linked to results during execution (was showing "ok" instead of "...")
- Chain mode now sums step durations instead of taking max (was showing incorrect total time)
- Async notifications no longer leak across pi sessions in different directories
- Duplicate tool results no longer added to message array (was adding in both message_end and turn_end)
- Model resolution now works for models without provider prefix (e.g., `claude-sonnet-4`)
- Model resolution fallback now uses correct ID after splitting provider prefix
- Recent tools now properly track end times in progress display
- Session cleanup (unsubscribe, dispose) now always runs even if prompt() throws
- Type safety: only standard LLM messages (user/assistant/toolResult) collected, not custom agent messages
- Skills and context files discovery now respects undefined vs empty array (undefined = use defaults)
- Tool paths in agent frontmatter now resolved relative to agent file directory
- Agent-scoped extensions now properly loaded (was being ignored due to SDK API behavior)
- Tilde (`~`) now expanded to home directory in extension/skill/contextFile/tool paths

## [0.1.0] - 2026-01-03

Initial release forked from async-subagent example.

### Added
- Output truncation with configurable byte/line limits
- Real-time progress tracking (tools, tokens, duration)
- Debug artifacts (input, output, JSONL, metadata)
- Session-tied artifact storage for sync mode
- Per-step duration tracking for chains
