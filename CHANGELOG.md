# Changelog

## [Unreleased]

### Added
- **Multi-agent overlay support**: Parallel subagents now tracked in overlay with tab switching
  - Tab/Shift+Tab to cycle between agents, 1-9 to select specific agent
  - Each agent shows status icon (running/success/failed) in tab bar
  - Scroll position resets when switching agents
- **Subagent steering**: Can now send messages to running subagents via overlay input
  - Press 'i' to enter input mode, type message, press Enter to send
  - Uses SDK's `session.steer()` to inject messages into running session
  - Proper error handling for both sync and async steer errors
  - Shows `[steering not available yet]` if session still initializing
- **Animated spinner**: Shows `⠋ Working...` with cycling braille animation when waiting for LLM response
- **Tool call transparency**: Logs `▶ toolName: args` to overlay output when each tool starts
- **Chain handoff observability**: Shows preview of `{previous}` content when chain steps transition
  - Displays "Received from step N" header with first 10 lines of output
  - Helps understand what data flows between chain steps
- **Streaming bash output**: Real-time preview of bash command output in overlay
  - Shows last 5 lines of streaming output, updates as new data arrives
  - Lines prefixed with `  ` to distinguish from other output
  - Preview replaced (not accumulated) on each update for compact display
- **Interrupt subagent** (`[x]`): Abort current tool, auto-opens input for steering
  - Sends heartbeat message telling agent to wait for instructions (if steer available)
  - Shows "[interrupted - agent paused...]" with steer, or "[interrupted - tool aborted]" without
  - Input mode auto-enabled so user can immediately type steering message
  - Properly chains interrupt → steer with success/error feedback
- **Abort subagent** (`[X]`): Kill entire subagent session, return to parent
- **Architecture documentation**: Added `docs/ARCHITECTURE.md` with ASCII diagrams
- **README improvements**: Added experimental prototype warning banner and screenshot

### Changed
- Overlay width reduced to max 100 columns (75% of terminal width) as workaround for pi-mono compositing edge cases
- Token display now shows input + output only (excludes cached tokens which inflate the numbers)
- Overlay output area capped at 20 lines to prevent excessive height
- Tool/status line always shown for consistent overlay height (shows "Working..." or "Completed")
- Scroll indicator section always present for consistent height
- Dynamic overlay controls: `[↑/↓] Scroll` only shown when content is scrollable
- Input mode controls: Shows `[Esc] Exit input  [Enter] Send` instead of normal controls
- Auto-exit input mode when execution completes

### Fixed
- **Overlay text overflow**: All content now properly truncated with `fitContent()` helper
  - Header, task, tool, error, controls, input all use truncate-then-pad
  - Prevents text from extending outside box borders
- **Chain failure observability**: Collapsed view now shows error details when chains fail
  - Shows which agent failed
  - Shows error message preview (80 chars)
  - Shows last 2 lines of output for context
- **Chain/parallel cleanup**: Added try-catch wrappers to ensure `clearCompletedExecutions()` runs
  - On success, failure, or unexpected exceptions
  - Prevents stale execution state from lingering
- **Overlay flickering**: Fixed by ensuring consistent height across all render states
- **Chain execution tracking**: Fixed "No active subagent execution" appearing mid-chain
  - Now keeps `lastCompletedExecution` for seamless overlay transitions
  - Overlay shows last execution instead of "no active" during brief gaps
- **Chain step transition UI**: Added `onUpdate` call after each step completes
  - Main chat's collapsed view now shows accurate completion status between steps
  - Prevents "running" icon showing for already-completed steps
- **Chain step counter mismatch**: Collapsed view now shows correct total steps
  - Added `stepsTotal` to Details interface to track actual chain/parallel length
  - Previously showed `1/1` for step 1 of a 2-step chain
- **Elapsed time for completed executions**: Now uses final `durationMs` instead of `Date.now() - startTime`
  - Previously kept incrementing after completion
- **Token count display**: Changed to show only input + output tokens
  - Cache tokens (cacheRead/cacheWrite) excluded as they inflate displayed numbers
  - Cache values still tracked separately in progress for detailed inspection
- **Overlay scrolling with fallback execution**: `handleInput` now uses same fallback as `render()`
  - Previously couldn't scroll when viewing `lastCompletedExecution`
- **Bash tool name check**: Fixed lowercase "bash" check in sdk-runner (was also checking "Bash")
- **Race condition in interrupt handler**: Captures execution ID to ensure errors go to correct execution
- Removed dead code: unused `getActiveExecution()` function
- Fixed chain code indentation for readability

---

## Previous Changes

### Added
- **Context inheritance**: New `inheritContext` parameter allows subagents to inherit the parent session's conversation history
  - Subagent sees all prior messages from the parent session before executing its task
  - For chains, only the first step inherits context (subsequent steps use `{previous}`)
  - Auto-downgrades to sync mode if `async: true` is also specified (similar to parallel mode)
- **`/background` slash command**: Quick invocation with inherited context
  - Usage: `/background <agent> <task>`
  - Automatically inherits parent session context
  - Result is injected back into session, triggering main agent to respond
- **Ctrl+Shift+O interactive overlay**: Full-screen view during sync subagent execution
  - Beautiful box-drawing UI with borders and colors
  - Shows real-time progress: agent, task, tools, tokens, elapsed time
  - Streams output as it's generated
  - Scrollable output with ↑/↓/j/k, PgUp/PgDn, Home/End/g/G navigation
  - Input mode (press 'i') for sending prompts to subagent (placeholder for future)
  - Works for single and chain modes (not parallel)
  - Uses Ctrl+Shift+O to avoid conflicting with default Ctrl+O (expand tool result)
- **SDK-based execution**: Sync mode now uses `createAgentSession()` directly instead of spawning subprocesses
- **Agent-scoped extensions**: New `extensions` frontmatter field to load extensions only for specific agents
- **Agent-scoped skills**: New `skills` frontmatter field to inject skills only for specific agents
- **Agent-scoped context**: New `contextFiles` frontmatter field for per-agent AGENTS.md-style context
- **Thinking level**: New `thinking` frontmatter field to set extended thinking level (off, minimal, low, medium, high, xhigh)
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
- Removed duplicate `getFinalOutput` function (now imported from sdk-runner.ts)
- Added proper type assertion for `buildSessionContext()` call on ReadonlySessionManager
- Overlay: Added missing `invalidate()` method required by Component interface
- Overlay: Fixed scroll logic - now correctly scrolls through output history with ↑/↓ keys
- Overlay: Accumulates ALL output lines for scrolling (was only keeping last 8 per message)
- Overlay: Race condition fix - uses unique execution IDs to prevent cleanup conflicts in chains
- Overlay: Shows scroll indicators when there's more content above/below visible area
- Overlay: Now uses `matchesKey` for proper Kitty keyboard protocol support (fixes unresponsive escape key)
- Overlay: Added 'q' as alternative close key
- `/background` command: Improved error messages to show more context instead of "Unknown error"
- Renamed `AgentProgress` to `SDKProgress` in sdk-runner.ts to avoid type confusion with types.ts
- Overlay: Use `visibleWidth` for proper ANSI-aware string padding (fixes alignment issues)
- Overlay: Use `truncateToWidth` for proper ANSI-aware line truncation
- Overlay: Remove invalid `matchesKey` calls for pageup/pagedown (not in KeyId type)
- Overlay: Fix memory leak - `dispose()` now called when overlay closes (clears interval)
- Overlay: Input escape callback now triggers re-render
- Overlay: Input submit now exits input mode and triggers re-render
- Overlay: `maxOutputLines` now has minimum of 1 for small terminals (consistent in render and handleInput)
- Overlay: Remove unused `Box` import
- Overlay: Fix Page Up/Down to handle all modifier variants with startsWith pattern
- Overlay: Fix potential crash with small terminal widths (String.repeat with negative value)
- Overlay: Add safeWidth guard and Math.max guards for all truncation operations
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
