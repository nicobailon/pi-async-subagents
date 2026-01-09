/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true }
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type AuthStorage,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
	type ToolDefinition,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Input, Markdown, matchesKey, Spacer, Text, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	appendJsonl,
	cleanupOldArtifacts,
	ensureArtifactsDir,
	getArtifactPaths,
	getArtifactsDir,
	writeArtifact,
	writeMetadata,
} from "./artifacts.js";
import { getFinalOutput, runAgentSDK } from "./sdk-runner.js";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	DEFAULT_ARTIFACT_CONFIG,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	type ProgressSummary,
	type TruncationResult,
	truncateOutput,
} from "./types.js";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEMS = 8;

// ============================================================================
// Active Execution Tracking (for Ctrl+O overlay)
// ============================================================================

interface ActiveExecution {
	id: string; // Unique ID to prevent race conditions
	agent: string;
	task: string;
	mode: "single" | "chain" | "parallel";
	chainStep?: number;
	chainTotal?: number;
	progress: AgentProgress;
	allOutput: string[]; // Accumulates ALL output lines for scrolling
	isComplete: boolean;
	error?: string;
	startTime: number;
}

let activeExecution: ActiveExecution | null = null;
let overlayUpdateCallback: (() => void) | null = null;

function setActiveExecution(exec: ActiveExecution | null): void {
	activeExecution = exec;
	overlayUpdateCallback?.();
}

function updateActiveExecution(id: string, updates: Partial<ActiveExecution>): void {
	// Only update if the ID matches (prevents race conditions)
	if (activeExecution && activeExecution.id === id) {
		Object.assign(activeExecution, updates);
		overlayUpdateCallback?.();
	}
}

function appendOutputLines(id: string, lines: string[]): void {
	// Only append if the ID matches
	if (activeExecution && activeExecution.id === id) {
		activeExecution.allOutput.push(...lines);
		// Keep a reasonable limit to prevent memory issues
		if (activeExecution.allOutput.length > 1000) {
			activeExecution.allOutput = activeExecution.allOutput.slice(-1000);
		}
		overlayUpdateCallback?.();
	}
}

/**
 * Overlay component for observing subagent execution in real-time.
 * Full-screen overlay with streaming output, tool calls, progress, and optional input.
 */
class SubagentOverlay implements Component {
	private updateInterval: ReturnType<typeof setInterval> | null = null;
	private done: () => void;
	private tui: TUI;
	private scrollOffset = 0; // 0 = showing most recent, positive = scrolled up into history
	private inputMode = false; // Whether the input field is focused
	private input: Input;
	private cachedLines: string[] | null = null;

	// Width property tells TUI how wide to make the overlay
	public width: number;

	constructor(tui: TUI, done: () => void) {
		this.tui = tui;
		this.done = done;
		// Full width minus small margin
		this.width = Math.max(60, (process.stdout.columns || 120) - 4);
		
		// Create input component for optional user prompts
		this.input = new Input();
		this.input.onSubmit = (value) => {
			if (value.trim() && activeExecution && !activeExecution.isComplete) {
				// TODO: Send prompt to subagent (requires SDK support)
				// For now, just show that input was received
				activeExecution.allOutput.push(`> ${value}`);
				this.input.setValue("");
				this.inputMode = false; // Exit input mode after submit
				this.cachedLines = null;
				this.tui.requestRender();
			}
		};
		this.input.onEscape = () => {
			this.inputMode = false;
			this.cachedLines = null;
			this.tui.requestRender();
		};

		// Periodically refresh to show updated progress
		this.updateInterval = setInterval(() => {
			this.cachedLines = null;
			this.tui.requestRender();
		}, 100);

		// Register for updates from active execution
		overlayUpdateCallback = () => {
			this.cachedLines = null;
			this.tui.requestRender();
		};
	}

	invalidate(): void {
		this.cachedLines = null;
		this.input.invalidate?.();
	}

	render(width: number): string[] {
		// Use cached lines if available
		if (this.cachedLines && this.cachedLines.length > 0) {
			return this.cachedLines;
		}

		const termHeight = process.stdout.rows || 40;
		const maxOutputLines = Math.max(1, termHeight - 12); // Reserve space for header, footer, input
		const lines: string[] = [];
		
		// ANSI color helpers
		const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		
		// Helper to pad string to visible width (accounts for ANSI codes)
		const padVisible = (s: string, targetWidth: number) => {
			const visible = visibleWidth(s);
			const padding = Math.max(0, targetWidth - visible);
			return s + " ".repeat(padding);
		};

		// Ensure minimum width for rendering
		const safeWidth = Math.max(20, width);
		
		// Top border
		const horizLine = "─".repeat(safeWidth - 2);
		lines.push(dim(`┌${horizLine}┐`));

		if (!activeExecution) {
			lines.push(dim("│") + " No active subagent execution.".padEnd(safeWidth - 2) + dim("│"));
			lines.push(dim(`└${horizLine}┘`));
			this.cachedLines = lines;
			return lines;
		}

		const exec = activeExecution;
		const elapsed = Date.now() - exec.startTime;
		const elapsedStr = formatDuration(elapsed);

		// Header with status
		const modeLabel = exec.mode === "chain" && exec.chainStep !== undefined
			? `chain ${exec.chainStep + 1}/${exec.chainTotal}`
			: exec.mode;
		const statusIcon = exec.isComplete
			? (exec.error ? red("✗") : green("✓"))
			: yellow("◐");
		const headerText = ` ${statusIcon} ${bold(exec.agent)} ${dim(`(${modeLabel})`)} │ ${exec.progress.toolCount} tools │ ${formatTokens(exec.progress.tokens)} tok │ ${elapsedStr} `;
		lines.push(dim("│") + padVisible(headerText, safeWidth - 2) + dim("│"));

		// Separator
		lines.push(dim(`├${horizLine}┤`));

		// Task (truncated if needed)
		const taskMaxLen = Math.max(10, safeWidth - 10);
		const taskText = exec.task.length > taskMaxLen ? exec.task.slice(0, Math.max(0, taskMaxLen - 3)) + "..." : exec.task;
		lines.push(dim("│") + padVisible(` ${dim("Task:")} ${taskText}`, safeWidth - 2) + dim("│"));

		// Current tool (if running)
		if (exec.progress.currentTool && !exec.isComplete) {
			const toolMaxLen = Math.max(20, safeWidth - 12);
			const toolArgs = exec.progress.currentToolArgs || "";
			const argsSpace = Math.max(0, toolMaxLen - exec.progress.currentTool.length - 5);
			const toolText = toolArgs.length > argsSpace
				? `${exec.progress.currentTool}: ${toolArgs.slice(0, argsSpace)}...`
				: `${exec.progress.currentTool}: ${toolArgs}`;
			lines.push(dim("│") + padVisible(` ${cyan("▶")} ${toolText}`, safeWidth - 2) + dim("│"));
		}

		// Output section header
		lines.push(dim(`├${horizLine}┤`));
		const outputLabel = ` Output ${dim(`(${exec.allOutput.length} lines)`)} `;
		lines.push(dim("│") + padVisible(outputLabel, safeWidth - 2) + dim("│"));
		lines.push(dim(`├${horizLine}┤`));

		// Output lines (scrollable)
		const totalLines = exec.allOutput.length;
		if (totalLines > 0) {
			const endIdx = Math.max(0, totalLines - this.scrollOffset);
			const startIdx = Math.max(0, endIdx - maxOutputLines);
			const outputLines = exec.allOutput.slice(startIdx, endIdx);
			
			for (const line of outputLines) {
				// Use truncateToWidth for proper ANSI-aware truncation
				const maxLineWidth = Math.max(1, safeWidth - 4);
				const truncatedLine = truncateToWidth(line, maxLineWidth);
				lines.push(dim("│") + padVisible(` ${truncatedLine}`, safeWidth - 2) + dim("│"));
			}
			
			// Pad with empty lines if needed
			for (let i = outputLines.length; i < maxOutputLines; i++) {
				lines.push(dim("│") + " ".repeat(safeWidth - 2) + dim("│"));
			}

			// Scroll indicator
			if (this.scrollOffset > 0 || startIdx > 0) {
				const upArrow = startIdx > 0 ? `↑${startIdx}` : "";
				const downArrow = this.scrollOffset > 0 ? `↓${this.scrollOffset}` : "";
				const scrollText = [upArrow, downArrow].filter(Boolean).join(" │ ");
				lines.push(dim(`├${horizLine}┤`));
				lines.push(dim("│") + padVisible(` ${dim(scrollText)}`, safeWidth - 2) + dim("│"));
			}
		} else {
			lines.push(dim("│") + padVisible(dim(" (waiting for output...)"), safeWidth - 2) + dim("│"));
			for (let i = 1; i < maxOutputLines; i++) {
				lines.push(dim("│") + " ".repeat(safeWidth - 2) + dim("│"));
			}
		}

		// Error if any
		if (exec.error) {
			lines.push(dim(`├${horizLine}┤`));
			const errMaxLen = Math.max(10, safeWidth - 15);
			const errText = ` ${red("Error:")} ${exec.error.slice(0, errMaxLen)}`;
			lines.push(dim("│") + padVisible(errText, safeWidth - 2) + dim("│"));
		}

		// Footer with controls
		lines.push(dim(`├${horizLine}┤`));
		const controls = exec.isComplete
			? `${dim("[q/Esc]")} Close`
			: `${dim("[q/Esc]")} Close  ${dim("[↑/↓]")} Scroll  ${dim("[i]")} Input`;
		lines.push(dim("│") + padVisible(` ${controls}`, safeWidth - 2) + dim("│"));

		// Input area (if in input mode)
		if (this.inputMode && !exec.isComplete) {
			lines.push(dim(`├${horizLine}┤`));
			// Input component already renders with "> " prompt and cursor
			const inputLines = this.input.render(Math.max(10, safeWidth - 4));
			const inputText = inputLines[0] || "> ";
			// Use padVisible since input may have ANSI codes for cursor
			lines.push(dim("│") + " " + padVisible(inputText, safeWidth - 4) + dim("│"));
		}

		// Bottom border
		lines.push(dim(`└${horizLine}┘`));

		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		// If in input mode, forward to input component (except escape)
		if (this.inputMode) {
			if (matchesKey(data, "escape")) {
				this.inputMode = false;
				this.cachedLines = null;
				this.tui.requestRender();
				return;
			}
			this.input.handleInput(data);
			this.cachedLines = null;
			this.tui.requestRender();
			return;
		}

		// Close overlay
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}

		// Enter input mode
		if (matchesKey(data, "i") && activeExecution && !activeExecution.isComplete) {
			this.inputMode = true;
			this.cachedLines = null;
			this.tui.requestRender();
			return;
		}

		const totalLines = activeExecution?.allOutput.length ?? 0;
		const termHeight = process.stdout.rows || 40;
		const maxOutputLines = Math.max(1, termHeight - 12); // Same calculation as render()
		const maxScroll = Math.max(0, totalLines - maxOutputLines);

		// Scrolling - line by line
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.cachedLines = null;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.cachedLines = null;
			this.tui.requestRender();
		}
		// Page up/down (raw escape sequences - not in KeyId type)
		// Format: \x1b[5~ (Page Up), \x1b[6~ (Page Down)
		// With modifiers: \x1b[5;1~ (no mod), \x1b[5;1:1~ (Kitty with event type)
		else if (data.startsWith("\x1b[5") && data.endsWith("~")) { // Page Up
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 10);
			this.cachedLines = null;
			this.tui.requestRender();
		} else if (data.startsWith("\x1b[6") && data.endsWith("~")) { // Page Down
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
			this.cachedLines = null;
			this.tui.requestRender();
		}
		// Jump to beginning/end
		else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.scrollOffset = maxScroll; // Go to beginning
			this.cachedLines = null;
			this.tui.requestRender();
		} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.scrollOffset = 0; // Go to end (most recent)
			this.cachedLines = null;
			this.tui.requestRender();
		}
	}

	dispose(): void {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
		overlayUpdateCallback = null;
	}
}

// Helper type for Component interface
interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
}

const RESULTS_DIR = "/tmp/pi-async-subagent-results";
const ASYNC_DIR = "/tmp/pi-async-subagent-runs";
const WIDGET_KEY = "subagent-async";
const POLL_INTERVAL_MS = 1000;
const MAX_WIDGET_JOBS = 4;

const require = createRequire(import.meta.url);
const jitiCliPath: string | undefined = (() => {
	try {
		return path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs");
	} catch {
		return undefined;
	}
})();

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
}

interface Details {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "tool"; name: string; args: Record<string, unknown> };

interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

interface AsyncStatus {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	currentStep?: number;
	steps?: Array<{ agent: string; status: string; durationMs?: number; tokens?: TokenUsage }>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	shareUrl?: string;
	shareError?: string;
}

interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed";
	mode?: "single" | "chain";
	agents?: string[];
	currentStep?: number;
	stepsTotal?: number;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	shareUrl?: string;
}

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function readStatus(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	if (!fs.existsSync(statusPath)) return null;
	try {
		const content = fs.readFileSync(statusPath, "utf-8");
		return JSON.parse(content) as AsyncStatus;
	} catch {
		return null;
	}
}

function getOutputTail(outputFile: string | undefined, maxLines: number = 3): string[] {
	if (!outputFile || !fs.existsSync(outputFile)) return [];
	let fd: number | null = null;
	try {
		const stat = fs.statSync(outputFile);
		if (stat.size === 0) return [];
		const tailBytes = 4096;
		const start = Math.max(0, stat.size - tailBytes);
		fd = fs.openSync(outputFile, "r");
		const buffer = Buffer.alloc(Math.min(tailBytes, stat.size));
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const content = buffer.toString("utf-8");
		const lines = content.split("\n").filter((l) => l.trim());
		return lines.slice(-maxLines).map((l) => l.slice(0, 80) + (l.length > 80 ? "..." : ""));
	} catch {
		return [];
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

function getLastActivity(outputFile: string | undefined): string {
	if (!outputFile || !fs.existsSync(outputFile)) return "";
	try {
		const stat = fs.statSync(outputFile);
		const ago = Date.now() - stat.mtimeMs;
		if (ago < 1000) return "active now";
		if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
		return `active ${Math.floor(ago / 60000)}m ago`;
	} catch {
		return "";
	}
}

function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (!ctx.hasUI) return;
	if (jobs.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const lines: string[] = [];
	lines.push(theme.fg("accent", "Async subagents"));

	for (const job of jobs.slice(0, MAX_WIDGET_JOBS)) {
		const id = job.asyncId.slice(0, 6);
		const status =
			job.status === "complete"
				? theme.fg("success", "complete")
				: job.status === "failed"
					? theme.fg("error", "failed")
					: theme.fg("warning", "running");

		const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
		const stepIndex = job.currentStep !== undefined ? job.currentStep + 1 : undefined;
		const stepText = stepIndex !== undefined ? `step ${stepIndex}/${stepsTotal}` : `steps ${stepsTotal}`;
		const endTime = (job.status === "complete" || job.status === "failed") ? (job.updatedAt ?? Date.now()) : Date.now();
		const elapsed = job.startedAt ? formatDuration(endTime - job.startedAt) : "";
		const agentLabel = job.agents ? job.agents.join(" -> ") : (job.mode ?? "single");

		const tokenText = job.totalTokens ? ` | ${formatTokens(job.totalTokens.total)} tok` : "";
		const activityText = job.status === "running" ? getLastActivity(job.outputFile) : "";
		const activitySuffix = activityText ? ` | ${theme.fg("dim", activityText)}` : "";

		lines.push(`- ${id} ${status} | ${agentLabel} | ${stepText}${elapsed ? ` | ${elapsed}` : ""}${tokenText}${activitySuffix}`);

		if (job.status === "running" && job.outputFile) {
			const tail = getOutputTail(job.outputFile, 3);
			for (const line of tail) {
				lines.push(theme.fg("dim", `  > ${line}`));
			}
		}
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
}

function findByPrefix(dir: string, prefix: string, suffix?: string): string | null {
	if (!fs.existsSync(dir)) return null;
	const entries = fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix));
	if (suffix) {
		const withSuffix = entries.filter((entry) => entry.endsWith(suffix));
		if (withSuffix.length > 0) return path.join(dir, withSuffix.sort()[0]);
	}
	if (entries.length === 0) return null;
	return path.join(dir, entries.sort()[0]);
}

interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

function detectSubagentError(messages: Message[]): ErrorInfo {
	for (const msg of messages) {
		if (msg.role === "toolResult" && (msg as any).isError) {
			const text = msg.content.find((c) => c.type === "text");
			const details = text && "text" in text ? text.text : undefined;
			const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
			return {
				hasError: true,
				exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
				errorType: (msg as any).toolName || "tool",
				details: details?.slice(0, 200),
			};
		}
	}

	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const toolName = (msg as any).toolName;
		if (toolName !== "bash") continue;

		const text = msg.content.find((c) => c.type === "text");
		if (!text || !("text" in text)) continue;
		const output = text.text;

		const exitMatch = output.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		if (exitMatch) {
			const code = parseInt(exitMatch[1], 10);
			if (code !== 0) {
				return { hasError: true, exitCode: code, errorType: "bash", details: output.slice(0, 200) };
			}
		}

		const errorPatterns = [
			/command not found/i,
			/permission denied/i,
			/no such file or directory/i,
			/segmentation fault/i,
			/killed|terminated/i,
			/out of memory/i,
			/connection refused/i,
			/timeout/i,
		];
		for (const pattern of errorPatterns) {
			if (pattern.test(output)) {
				return { hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) };
			}
		}
	}

	return { hasError: false };
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "tool", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return `$ ${((args.command as string) || "").slice(0, 60)}${(args.command as string)?.length > 60 ? "..." : ""}`;
		case "read":
			return `read ${shortenPath((args.path || args.file_path || "") as string)}`;
		case "write":
			return `write ${shortenPath((args.path || args.file_path || "") as string)}`;
		case "edit":
			return `edit ${shortenPath((args.path || args.file_path || "") as string)}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 40)}${s.length > 40 ? "..." : ""}`;
		}
	}
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}
	return "";
}

function extractTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			return String(part.text);
		}
	}
	return "";
}

function writePrompt(agent: string, prompt: string): { dir: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const p = path.join(dir, `${agent.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(p, prompt, { mode: 0o600 });
	return { dir, path: p };
}

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		return null;
	}
}

async function exportSessionHtml(sessionFile: string, outputDir: string): Promise<string> {
	const pkgRoot = path.dirname(require.resolve("@mariozechner/pi-coding-agent/package.json"));
	const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
	const moduleUrl = pathToFileURL(exportModulePath).href;
	const mod = await import(moduleUrl);
	const exportFromFile = (mod as { exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => string })
		.exportFromFile;
	if (typeof exportFromFile !== "function") {
		throw new Error("exportFromFile not available");
	}
	const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
	return exportFromFile(sessionFile, { outputPath });
}

function createShareLink(htmlPath: string): { shareUrl: string; gistUrl: string } | { error: string } {
	try {
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (auth.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed." };
	}

	try {
		const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
		if (result.status !== 0) {
			const err = (result.stderr || "").trim() || "Failed to create gist.";
			return { error: err };
		}
		const gistUrl = (result.stdout || "").trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) return { error: "Failed to parse gist ID." };
		const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
		return { shareUrl, gistUrl };
	} catch (err) {
		return { error: String(err) };
	}
}

interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	share?: boolean;
	// SDK dependencies (required for SDK-based execution)
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	// Optional: inherit parent session context
	inheritMessages?: AgentMessage[];
	// For overlay tracking
	mode?: "single" | "chain" | "parallel";
	chainStep?: number;
	chainTotal?: number;
}

async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index, authStorage, modelRegistry, inheritMessages, mode, chainStep, chainTotal } = options;
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			error: `Unknown agent: ${agentName}`,
		};
	}

	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agentName,
		status: "running",
		task,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
	};
	result.progress = progress;

	const startTime = Date.now();

	// Generate unique execution ID for tracking (prevents race conditions in chains)
	const executionId = `${runId}-${index ?? 0}-${Date.now()}`;

	// Set active execution for overlay tracking (only if not parallel mode - parallel updates separately)
	if (mode !== "parallel") {
		setActiveExecution({
			id: executionId,
			agent: agentName,
			task,
			mode: mode ?? "single",
			chainStep,
			chainTotal,
			progress,
			allOutput: [],
			isComplete: false,
			startTime,
		});
	}

	// Setup artifacts
	let artifactPathsResult: ArtifactPaths | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agentName, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
	}

	// Run via SDK
	const sdkResult = await runAgentSDK({
		agent,
		task,
		cwd: cwd ?? runtimeCwd,
		authStorage,
		modelRegistry,
		signal,
		inheritMessages,
		onProgress: (sdkProgress) => {
			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.toolCount = sdkProgress.toolCount;
			progress.tokens = sdkProgress.tokens;

			// Track tool start/end for recentTools
			if (sdkProgress.currentTool) {
				// Tool started - add to recent tools if not already there
				progress.currentTool = sdkProgress.currentTool;
				progress.currentToolArgs = sdkProgress.currentToolArgs;
				
				if (!progress.recentTools.find((t) => t.tool === sdkProgress.currentTool && t.endMs === 0)) {
					progress.recentTools.unshift({
						tool: sdkProgress.currentTool,
						args: sdkProgress.currentToolArgs || "",
						endMs: 0,
					});
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
			} else if (progress.currentTool) {
				// Tool ended - update endMs for the current tool
				const currentToolEntry = progress.recentTools.find((t) => t.tool === progress.currentTool && t.endMs === 0);
				if (currentToolEntry) {
					currentToolEntry.endMs = now;
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
			}

			// Update active execution for overlay
			if (mode !== "parallel") {
				updateActiveExecution(executionId, { progress });
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			}
		},
		onMessage: (message) => {
			result.messages.push(message);

			// Update recent output from assistant messages
			if (message.role === "assistant") {
				const text = extractTextFromContent(message.content);
				if (text) {
					const lines = text
						.split("\n")
						.filter((l) => l.trim());
					// Keep last 8 lines in progress for the collapsed view
					progress.recentOutput = lines.slice(-8);

					// Append ALL lines to overlay's scrollable history
					if (mode !== "parallel") {
						appendOutputLines(executionId, lines);
					}
				}
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			}
		},
	});

	// Map SDK result to SingleResult
	result.messages = sdkResult.messages;
	result.usage = sdkResult.usage;
	result.model = sdkResult.model;
	result.exitCode = sdkResult.exitCode;
	result.error = sdkResult.error;

	// Check for tool errors in messages
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	// Finalize progress
	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	// toolCount is already tracked via onProgress callbacks, don't reset it
	progress.tokens = sdkResult.usage.input + sdkResult.usage.output;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progress = progress;
	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	// Handle artifacts
	if (artifactPathsResult && artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		const fullOutput = getFinalOutput(result.messages);

		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		if (artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				durationMs: progress.durationMs,
				toolCount: progress.toolCount,
				error: result.error,
				timestamp: Date.now(),
			});
		}

		if (maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
			const truncationResult = truncateOutput(fullOutput, config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) {
				result.truncation = truncationResult;
			}
		}
	} else if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const fullOutput = getFinalOutput(result.messages);
		const truncationResult = truncateOutput(fullOutput, config);
		if (truncationResult.truncated) {
			result.truncation = truncationResult;
		}
	}

	// Note: Session sharing is not supported with SDK mode (uses in-memory sessions)
	// If session sharing is needed, the async subprocess runner can still be used
	if (options.share === true) {
		result.shareError = "Session sharing not supported with SDK mode. Use async mode for session sharing.";
	}

	// Mark execution complete (for overlay) but don't clear yet - let overlay show final state
	if (mode !== "parallel") {
		updateActiveExecution(executionId, {
			isComplete: true,
			error: result.error,
			progress,
		});
		// Clear after a short delay to allow overlay to show completion
		// Use execution ID to ensure we only clear THIS execution, not a subsequent one
		setTimeout(() => {
			if (activeExecution?.id === executionId && activeExecution?.isComplete) {
				setActiveExecution(null);
			}
		}, 100);
	}

	return result;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array(Math.min(limit, items.length))
			.fill(0)
			.map(async () => {
				while (next < items.length) {
					const i = next++;
					results[i] = await fn(items[i], i);
				}
			}),
	);
	return results;
}

const TaskItem = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()) });
const ChainItem = Type.Object({
	agent: Type.String(),
	task: Type.String({ description: "Use {previous} for prior output" }),
	cwd: Type.Optional(Type.String()),
});

const MaxOutputSchema = Type.Optional(
	Type.Object({
		bytes: Type.Optional(Type.Number({ description: "Max bytes (default: 204800)" })),
		lines: Type.Optional(Type.Number({ description: "Max lines (default: 5000)" })),
	}),
);

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false, or per config)" })),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })),
	cwd: Type.Optional(Type.String()),
	maxOutput: MaxOutputSchema,
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Create shareable session log (default: true)", default: true })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	inheritContext: Type.Optional(
		Type.Boolean({ description: "Inherit parent session context (subagent sees parent's conversation history)" }),
	),
});

const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Async run id or prefix" })),
	dir: Type.Optional(Type.String({ description: "Async run directory (overrides id search)" })),
});

interface ExtensionConfig {
	asyncByDefault?: boolean;
}

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch {}
	return {};
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.mkdirSync(ASYNC_DIR, { recursive: true });

	const config = loadConfig();
	const asyncByDefault = config.asyncByDefault === true;

	const tempArtifactsDir = getArtifactsDir(null);
	cleanupOldArtifacts(tempArtifactsDir, DEFAULT_ARTIFACT_CONFIG.cleanupDays);
	let baseCwd = process.cwd();
	let currentSessionId: string | null = null;
	const asyncJobs = new Map<string, AsyncJobState>();
	let lastUiContext: ExtensionContext | null = null;
	let poller: NodeJS.Timeout | null = null;

	const ensurePoller = () => {
		if (poller) return;
		poller = setInterval(() => {
			if (!lastUiContext || !lastUiContext.hasUI) return;
			if (asyncJobs.size === 0) {
				renderWidget(lastUiContext, []);
				clearInterval(poller);
				poller = null;
				return;
			}

			for (const job of asyncJobs.values()) {
				const status = readStatus(job.asyncDir);
				if (status) {
					job.status = status.state;
					job.mode = status.mode;
					job.currentStep = status.currentStep ?? job.currentStep;
					job.stepsTotal = status.steps?.length ?? job.stepsTotal;
					job.startedAt = status.startedAt ?? job.startedAt;
					job.updatedAt = status.lastUpdate ?? Date.now();
					if (status.steps?.length) {
						job.agents = status.steps.map((step) => step.agent);
					}
					job.sessionDir = status.sessionDir ?? job.sessionDir;
					job.outputFile = status.outputFile ?? job.outputFile;
					job.totalTokens = status.totalTokens ?? job.totalTokens;
					job.sessionFile = status.sessionFile ?? job.sessionFile;
					job.shareUrl = status.shareUrl ?? job.shareUrl;
				} else {
					job.status = job.status === "queued" ? "running" : job.status;
					job.updatedAt = Date.now();
				}
			}

			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, POLL_INTERVAL_MS);
	};

	const handleResult = (file: string) => {
		const p = path.join(RESULTS_DIR, file);
		if (!fs.existsSync(p)) return;
		try {
			const data = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (data.sessionId && data.sessionId !== currentSessionId) return;
			if (!data.sessionId && data.cwd && data.cwd !== baseCwd) return;
			pi.events.emit("subagent:complete", data);
			pi.events.emit("subagent_enhanced:complete", data);
			fs.unlinkSync(p);
		} catch {}
	};

	const watcher = fs.watch(RESULTS_DIR, (ev, file) => {
		if (ev === "rename" && file?.toString().endsWith(".json")) setTimeout(() => handleResult(file.toString()), 50);
	});
	fs.readdirSync(RESULTS_DIR)
		.filter((f) => f.endsWith(".json"))
		.forEach(handleResult);

	const tool: ToolDefinition<typeof Params, Details> = {
		name: "subagent",
		label: "Subagent",
		description: "Delegate tasks to subagents (single, parallel, chain) with optional async mode, artifacts, and truncation.",
		parameters: Params,

		async execute(_id, params, onUpdate, ctx, signal) {
			const scope: AgentScope = params.agentScope ?? "user";
			baseCwd = ctx.cwd;
			currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const agents = discoverAgents(ctx.cwd, scope).agents;

			// Extract SDK dependencies from context for SDK-based execution
			const { modelRegistry } = ctx;
			const authStorage = modelRegistry.authStorage;
			const runId = randomUUID().slice(0, 8);
			const shareEnabled = params.share !== false;
			const sessionEnabled = shareEnabled || Boolean(params.sessionDir);
			const sessionRoot = sessionEnabled
				? params.sessionDir
					? path.resolve(params.sessionDir)
					: fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"))
				: undefined;
			if (sessionRoot) {
				try {
					fs.mkdirSync(sessionRoot, { recursive: true });
				} catch {}
			}
			const sessionDirForIndex = (idx?: number) =>
				sessionRoot ? path.join(sessionRoot, `run-${idx ?? 0}`) : undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			const requestedAsync = params.async ?? asyncByDefault;
			const parallelDowngraded = hasTasks && requestedAsync;
			// inheritContext forces sync mode (subprocess can't access parent session)
			const isAsync = requestedAsync && !hasTasks && !params.inheritContext;

			const artifactConfig: ArtifactConfig = {
				...DEFAULT_ARTIFACT_CONFIG,
				enabled: params.artifacts !== false,
			};

			const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
			const artifactsDir = isAsync ? tempArtifactsDir : getArtifactsDir(sessionFile);

			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
						},
					],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (isAsync) {
				if (!jitiCliPath)
					return {
						content: [{ type: "text", text: "jiti not found" }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				const id = randomUUID();
				const asyncDir = path.join(ASYNC_DIR, id);
				try {
					fs.mkdirSync(asyncDir, { recursive: true });
				} catch {}
				const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

				const spawnRunner = (cfg: object, suffix: string): number | undefined => {
					const cfgPath = path.join(os.tmpdir(), `pi-async-cfg-${suffix}.json`);
					fs.writeFileSync(cfgPath, JSON.stringify(cfg));
					const proc = spawn("node", [jitiCliPath!, runner, cfgPath], {
						cwd: (cfg as any).cwd ?? ctx.cwd,
						detached: true,
						stdio: "ignore",
					});
					proc.unref();
					return proc.pid;
				};

				if (hasChain && params.chain) {
					const steps = params.chain.map((s) => {
						const a = agents.find((x) => x.name === s.agent);
						if (!a) throw new Error(`Unknown: ${s.agent}`);
						return {
							agent: s.agent,
							task: s.task,
							cwd: s.cwd,
							model: a.model,
							tools: a.tools,
							systemPrompt: a.systemPrompt?.trim() || null,
						};
					});
					const pid = spawnRunner(
						{
							id,
							steps,
							resultPath: path.join(RESULTS_DIR, `${id}.json`),
							cwd: params.cwd ?? ctx.cwd,
							placeholder: "{previous}",
							maxOutput: params.maxOutput,
							artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
							artifactConfig,
							share: shareEnabled,
							sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
							asyncDir,
							sessionId: currentSessionId,
						},
						id,
					);
					if (pid) {
						pi.events.emit("subagent_enhanced:started", {
							id,
							pid,
							agent: params.chain[0].agent,
							task: params.chain[0].task?.slice(0, 50),
							chain: params.chain.map((s) => s.agent),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
						pi.events.emit("subagent:started", {
							id,
							pid,
							agent: params.chain[0].agent,
							task: params.chain[0].task?.slice(0, 50),
							chain: params.chain.map((s) => s.agent),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
					}
					return {
						content: [
							{ type: "text", text: `Async chain: ${params.chain.map((s) => s.agent).join(" -> ")} [${id}]` },
						],
						details: { mode: "chain", results: [], asyncId: id, asyncDir },
					};
				}

				if (hasSingle) {
					const a = agents.find((x) => x.name === params.agent);
					if (!a)
						return {
							content: [{ type: "text", text: `Unknown: ${params.agent}` }],
							isError: true,
							details: { mode: "single" as const, results: [] },
						};
					const pid = spawnRunner(
						{
							id,
							steps: [
								{
									agent: params.agent,
									task: params.task,
									cwd: params.cwd,
									model: a.model,
									tools: a.tools,
									systemPrompt: a.systemPrompt?.trim() || null,
								},
							],
							resultPath: path.join(RESULTS_DIR, `${id}.json`),
							cwd: params.cwd ?? ctx.cwd,
							placeholder: "{previous}",
							maxOutput: params.maxOutput,
							artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
							artifactConfig,
							share: shareEnabled,
							sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
							asyncDir,
							sessionId: currentSessionId,
						},
						id,
					);
					if (pid) {
						pi.events.emit("subagent_enhanced:started", {
							id,
							pid,
							agent: params.agent,
							task: params.task?.slice(0, 50),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
						pi.events.emit("subagent:started", {
							id,
							pid,
							agent: params.agent,
							task: params.task?.slice(0, 50),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
					}
					return {
						content: [{ type: "text", text: `Async: ${params.agent} [${id}]` }],
						details: { mode: "single", results: [], asyncId: id, asyncDir },
					};
				}
			}

			const allProgress: AgentProgress[] = [];
			const allArtifactPaths: ArtifactPaths[] = [];

			// Get inherited messages from parent session if requested
			// Note: buildSessionContext() is on full SessionManager but ExtensionContext exposes ReadonlySessionManager
			// The actual runtime object is the full SessionManager, so this works
			const inheritMessages: AgentMessage[] | undefined = params.inheritContext
				? (ctx.sessionManager as unknown as { buildSessionContext(): { messages: AgentMessage[] } }).buildSessionContext().messages
				: undefined;

			if (hasChain && params.chain) {
				const results: SingleResult[] = [];
				let prev = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithPrev = step.task.replace(/\{previous\}/g, prev);
					const r = await runSync(ctx.cwd, agents, step.agent, taskWithPrev, {
						cwd: step.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						authStorage,
						modelRegistry,
						// Only first step in chain inherits parent context; subsequent steps get {previous}
						inheritMessages: i === 0 ? inheritMessages : undefined,
						// For overlay tracking
						mode: "chain",
						chainStep: i,
						chainTotal: params.chain.length,
						onUpdate: onUpdate
							? (p) =>
									onUpdate({
										...p,
										details: {
											mode: "chain",
											results: [...results, ...(p.details?.results || [])],
											progress: [...allProgress, ...(p.details?.progress || [])],
										},
									})
							: undefined,
					});
					results.push(r);
					if (r.progress) allProgress.push(r.progress);
					if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
					if (r.exitCode !== 0)
						return {
							content: [{ type: "text", text: r.error || "Chain failed" }],
							details: {
								mode: "chain",
								results,
								progress: params.includeProgress ? allProgress : undefined,
								artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
							},
							isError: true,
						};
					prev = getFinalOutput(r.messages);
				}

				let finalOutput = prev;
				let truncationInfo: Details["truncation"];
				if (params.maxOutput) {
					const config = { ...DEFAULT_MAX_OUTPUT, ...params.maxOutput };
					const outputPath = allArtifactPaths[allArtifactPaths.length - 1]?.outputPath;
					const truncResult = truncateOutput(prev, config, outputPath);
					if (truncResult.truncated) {
						finalOutput = truncResult.text;
						truncationInfo = truncResult;
					}
				}

				return {
					content: [{ type: "text", text: finalOutput || "(no output)" }],
					details: {
						mode: "chain",
						results,
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						truncation: truncationInfo,
					},
				};
			}

			if (hasTasks && params.tasks) {
				if (params.tasks.length > MAX_PARALLEL)
					return {
						content: [{ type: "text", text: `Max ${MAX_PARALLEL} tasks` }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				const results = await mapConcurrent(params.tasks, MAX_CONCURRENCY, async (t, i) =>
					runSync(ctx.cwd, agents, t.agent, t.task, {
						cwd: t.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						authStorage,
						modelRegistry,
						maxOutput: params.maxOutput,
						inheritMessages,
						// Parallel mode doesn't track individual executions in overlay
						mode: "parallel",
					}),
				);

				for (const r of results) {
					if (r.progress) allProgress.push(r.progress);
					if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
				}

				const ok = results.filter((r) => r.exitCode === 0).length;
				const downgradeNote = parallelDowngraded ? " (async not supported for parallel)" : "";
				return {
					content: [{ type: "text", text: `${ok}/${results.length} succeeded${downgradeNote}` }],
					details: {
						mode: "parallel",
						results,
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
					},
				};
			}

			if (hasSingle) {
				const r = await runSync(ctx.cwd, agents, params.agent!, params.task!, {
					cwd: params.cwd,
					signal,
					runId,
					sessionDir: sessionDirForIndex(0),
					share: shareEnabled,
					artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
					artifactConfig,
					authStorage,
					modelRegistry,
					maxOutput: params.maxOutput,
					inheritMessages,
					mode: "single",
					onUpdate,
				});

				if (r.progress) allProgress.push(r.progress);
				if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

				const output = r.truncation?.text || getFinalOutput(r.messages);

				if (r.exitCode !== 0)
					return {
						content: [{ type: "text", text: r.error || "Failed" }],
						details: {
							mode: "single",
							results: [r],
							progress: params.includeProgress ? allProgress : undefined,
							artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
							truncation: r.truncation,
						},
						isError: true,
					};
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: {
						mode: "single",
						results: [r],
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						truncation: r.truncation,
					},
				};
			}

			return {
				content: [{ type: "text", text: "Invalid params" }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},

		renderCall(args, theme) {
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const asyncLabel = args.async === true && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${args.tasks!.length})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details;
			if (!d || !d.results.length) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			if (d.mode === "single" && d.results.length === 1) {
				const r = d.results[0];
				const isRunning = r.progress?.status === "running";
				const icon = isRunning
					? theme.fg("warning", "...")
					: r.exitCode === 0
						? theme.fg("success", "ok")
						: theme.fg("error", "X");
				const output = r.truncation?.text || getFinalOutput(r.messages);

				const progressInfo = isRunning && r.progress
					? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
					: r.progressSummary
						? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tokens, ${formatDuration(r.progressSummary.durationMs)}`
						: "";

				if (expanded) {
					const c = new Container();
					c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${progressInfo}`, 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(
						new Text(theme.fg("dim", `Task: ${r.task.slice(0, 100)}${r.task.length > 100 ? "..." : ""}`), 0, 0),
					);
					c.addChild(new Spacer(1));

					const items = getDisplayItems(r.messages);
					for (const item of items) {
						if (item.type === "tool")
							c.addChild(new Text(theme.fg("muted", formatToolCall(item.name, item.args)), 0, 0));
					}
					if (items.length) c.addChild(new Spacer(1));

					if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
					if (r.sessionFile) {
						c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
					}
					if (r.shareUrl) {
						c.addChild(new Text(theme.fg("dim", `Share: ${r.shareUrl}`), 0, 0));
					} else if (r.shareError) {
						c.addChild(new Text(theme.fg("warning", `Share error: ${r.shareError}`), 0, 0));
					}

					if (r.artifactPaths) {
						c.addChild(new Spacer(1));
						c.addChild(new Text(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
					}
					return c;
				}

				const lines = [`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${progressInfo}`];

				if (isRunning && r.progress) {
					if (r.progress.currentTool) {
						const toolLine = r.progress.currentToolArgs
							? `${r.progress.currentTool}: ${r.progress.currentToolArgs.slice(0, 60)}${r.progress.currentToolArgs.length > 60 ? "..." : ""}`
							: r.progress.currentTool;
						lines.push(theme.fg("warning", `> ${toolLine}`));
					}
					for (const line of r.progress.recentOutput.slice(-3)) {
						lines.push(theme.fg("dim", `  ${line.slice(0, 80)}${line.length > 80 ? "..." : ""}`));
					}
					lines.push(theme.fg("dim", "(ctrl+shift+o for overlay)"));
				} else {
					const items = getDisplayItems(r.messages).slice(-COLLAPSED_ITEMS);
					for (const item of items) {
						if (item.type === "tool") lines.push(theme.fg("muted", formatToolCall(item.name, item.args)));
						else lines.push(item.text.slice(0, 80) + (item.text.length > 80 ? "..." : ""));
					}
					lines.push(theme.fg("dim", formatUsage(r.usage, r.model)));
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			const hasRunning = d.progress?.some((p) => p.status === "running") 
				|| d.results.some((r) => r.progress?.status === "running");
			const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
			const icon = hasRunning
				? theme.fg("warning", "...")
				: ok === d.results.length
					? theme.fg("success", "ok")
					: theme.fg("error", "X");

			const totalSummary =
				d.progressSummary ||
				d.results.reduce(
					(acc, r) => {
						const prog = r.progress || r.progressSummary;
						if (prog) {
							acc.toolCount += prog.toolCount;
							acc.tokens += prog.tokens;
							acc.durationMs =
								d.mode === "chain"
									? acc.durationMs + prog.durationMs
									: Math.max(acc.durationMs, prog.durationMs);
						}
						return acc;
					},
					{ toolCount: 0, tokens: 0, durationMs: 0 },
				);

			const summaryStr =
				totalSummary.toolCount || totalSummary.tokens
					? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
					: "";

			const modeLabel = d.mode === "parallel" ? "parallel (no live progress)" : d.mode;
			const stepInfo = hasRunning ? ` ${ok + 1}/${d.results.length}` : ` ${ok}/${d.results.length}`;

			if (expanded) {
				const c = new Container();
				c.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${stepInfo}${summaryStr}`,
						0,
						0,
					),
				);
				for (let i = 0; i < d.results.length; i++) {
					const r = d.results[i];
					c.addChild(new Spacer(1));
					// Check both r.progress and d.progress array for running status
					const progressFromArray = d.progress?.find((p) => p.index === i);
					const rProg = r.progress || progressFromArray || r.progressSummary;
					const rRunning = rProg?.status === "running";
					const rIcon = rRunning
						? theme.fg("warning", "...")
						: r.exitCode === 0
							? theme.fg("success", "ok")
							: theme.fg("error", "X");
					const rProgress = rProg
						? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}`
						: "";
					c.addChild(new Text(`${rIcon} ${theme.bold(r.agent)}${rProgress}`, 0, 0));

					if (rRunning && rProg) {
						if (rProg.currentTool) {
							const toolLine = rProg.currentToolArgs
								? `${rProg.currentTool}: ${rProg.currentToolArgs.slice(0, 50)}${rProg.currentToolArgs.length > 50 ? "..." : ""}`
								: rProg.currentTool;
							c.addChild(new Text(theme.fg("warning", `  > ${toolLine}`), 0, 0));
						}
						for (const line of rProg.recentOutput.slice(-2)) {
							c.addChild(new Text(theme.fg("dim", `    ${line.slice(0, 70)}${line.length > 70 ? "..." : ""}`), 0, 0));
						}
					} else {
						const out = r.truncation?.text || getFinalOutput(r.messages);
						if (out) c.addChild(new Markdown(out, 0, 0, mdTheme));
						c.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
						if (r.sessionFile) {
							c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
						}
						if (r.shareUrl) {
							c.addChild(new Text(theme.fg("dim", `Share: ${r.shareUrl}`), 0, 0));
						} else if (r.shareError) {
							c.addChild(new Text(theme.fg("warning", `Share error: ${r.shareError}`), 0, 0));
						}
					}
				}

				if (d.artifacts) {
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), 0, 0));
				}
				return c;
			}

			const lines = [`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${stepInfo}${summaryStr}`];
			// Find running progress from d.progress array (more reliable) or d.results
			const runningProgress = d.progress?.find((p) => p.status === "running") 
				|| d.results.find((r) => r.progress?.status === "running")?.progress;
			if (runningProgress) {
				lines.push(theme.fg("dim", `  ${runningProgress.agent}:`));
				if (runningProgress.currentTool) {
					const toolLine = runningProgress.currentToolArgs
						? `${runningProgress.currentTool}: ${runningProgress.currentToolArgs.slice(0, 50)}${runningProgress.currentToolArgs.length > 50 ? "..." : ""}`
						: runningProgress.currentTool;
					lines.push(theme.fg("warning", `  > ${toolLine}`));
				}
				for (const line of runningProgress.recentOutput.slice(-2)) {
					lines.push(theme.fg("dim", `    ${line.slice(0, 70)}${line.length > 70 ? "..." : ""}`));
				}
				lines.push(theme.fg("dim", "(ctrl+shift+o for overlay)"));
			} else if (hasRunning) {
				// Fallback: we know something is running but can't find details
				lines.push(theme.fg("dim", "(ctrl+shift+o for overlay)"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

	};

	const statusTool: ToolDefinition<typeof StatusParams, Details> = {
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect async subagent run status and artifacts",
		parameters: StatusParams,

		async execute(_id, params) {
			let asyncDir: string | null = null;
			let resolvedId = params.id;

			if (params.dir) {
				asyncDir = path.resolve(params.dir);
			} else if (params.id) {
				const direct = path.join(ASYNC_DIR, params.id);
				if (fs.existsSync(direct)) {
					asyncDir = direct;
				} else {
					const match = findByPrefix(ASYNC_DIR, params.id);
					if (match) {
						asyncDir = match;
						resolvedId = path.basename(match);
					}
				}
			}

			const resultPath =
				params.id && !asyncDir ? findByPrefix(RESULTS_DIR, params.id, ".json") : null;

			if (!asyncDir && !resultPath) {
				return {
					content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (asyncDir) {
				const status = readStatus(asyncDir);
				const logPath = path.join(asyncDir, `subagent-log-${resolvedId ?? "unknown"}.md`);
				const eventsPath = path.join(asyncDir, "events.jsonl");
				if (status) {
					const stepsTotal = status.steps?.length ?? 1;
					const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
					const stepLine =
						current !== undefined ? `Step: ${current}/${stepsTotal}` : `Steps: ${stepsTotal}`;
					const started = new Date(status.startedAt).toISOString();
					const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";

					const lines = [
						`Run: ${status.runId}`,
						`State: ${status.state}`,
						`Mode: ${status.mode}`,
						stepLine,
						`Started: ${started}`,
						`Updated: ${updated}`,
						`Dir: ${asyncDir}`,
					];
					if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
					if (status.shareUrl) lines.push(`Share: ${status.shareUrl}`);
					if (status.shareError) lines.push(`Share error: ${status.shareError}`);
					if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
					if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				}
			}

			if (resultPath) {
				try {
					const raw = fs.readFileSync(resultPath, "utf-8");
					const data = JSON.parse(raw) as { id?: string; success?: boolean; summary?: string };
					const status = data.success ? "complete" : "failed";
					const lines = [`Run: ${data.id ?? params.id}`, `State: ${status}`, `Result: ${resultPath}`];
					if (data.summary) lines.push("", data.summary);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				} catch {}
			}

			return {
				content: [{ type: "text", text: "Status file not found." }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},
	};

	pi.registerTool(tool);
	pi.registerTool(statusTool);

	pi.events.on("subagent:started", (data) => {
		const info = data as {
			id?: string;
			asyncDir?: string;
			agent?: string;
			chain?: string[];
		};
		if (!info.id) return;
		const asyncDir = info.asyncDir ?? path.join(ASYNC_DIR, info.id);
		const agents = info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const now = Date.now();
		asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: agents?.length,
			startedAt: now,
			updatedAt: now,
		});
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
			ensurePoller();
		}
	});

	pi.events.on("subagent:complete", (data) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}
		setTimeout(() => {
			asyncJobs.delete(asyncId);
			if (lastUiContext) renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, 10000);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		lastUiContext = ctx;
		if (asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(asyncJobs.values()));
			ensurePoller();
		}
	});

	// Register Ctrl+Shift+O shortcut to show subagent overlay during execution
	// Note: We use Ctrl+Shift+O instead of Ctrl+O because the extension shortcut system
	// always consumes matched keys. Using plain Ctrl+O would break the default "expand
	// tool result" behavior when no subagent is running.
	pi.registerShortcut("ctrl+shift+o", {
		description: "Open subagent execution overlay",
		async handler(ctx) {
			if (!activeExecution) {
				if (ctx.hasUI) {
					ctx.ui.notify("No active subagent execution", "info");
				}
				return;
			}
			if (!ctx.hasUI) {
				return;
			}

			// Show the overlay
			await ctx.ui.custom(
				(tui, _theme, _kb, done) => {
					const overlay = new SubagentOverlay(tui, () => {
						overlay.dispose(); // Clean up interval before closing
						done(undefined);
					});
					return overlay;
				},
				{ overlay: true }
			);
		},
	});

	// Register /background slash command for quick subagent invocation with inherited context
	pi.registerCommand("background", {
		description: "Run a subagent with inherited session context: /background <agent> <task>",
		async handler(args, ctx) {
			// Parse args: first word is agent name, rest is task
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /background <agent> <task>", "error");
				return;
			}

			const spaceIndex = trimmed.indexOf(" ");
			if (spaceIndex === -1) {
				ctx.ui.notify("Usage: /background <agent> <task>", "error");
				return;
			}

			const agentName = trimmed.slice(0, spaceIndex);
			const task = trimmed.slice(spaceIndex + 1).trim();

			if (!task) {
				ctx.ui.notify("Usage: /background <agent> <task>", "error");
				return;
			}

			// Discover agents
			const agents = discoverAgents(ctx.cwd, "both").agents;
			const agent = agents.find((a) => a.name === agentName);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				ctx.ui.notify(`Unknown agent: ${agentName}. Available: ${available}`, "error");
				return;
			}

			// Get inherited messages from parent session
			const inheritMessages = (ctx.sessionManager as unknown as { buildSessionContext(): { messages: AgentMessage[] } }).buildSessionContext().messages;

			ctx.ui.notify(`Running ${agentName} with inherited context...`, "info");

			try {
				// Run the subagent with inherited context
				const result = await runAgentSDK({
					agent,
					task,
					cwd: ctx.cwd,
					authStorage: ctx.modelRegistry.authStorage,
					modelRegistry: ctx.modelRegistry,
					inheritMessages,
				});

				if (result.exitCode !== 0) {
					// Provide more context in error message
					const errorDetail = result.error 
						|| getFinalOutput(result.messages)?.slice(0, 200) 
						|| "Unknown error";
					ctx.ui.notify(`${agentName} failed: ${errorDetail}`, "error");
					return;
				}

				// Get the final output
				const output = getFinalOutput(result.messages);

				// Send the result back to the session, triggering a turn so the main agent can respond
				pi.sendMessage({
					customType: "background-result",
					content: `## Background task completed: ${agentName}\n\n**Task:** ${task}\n\n**Result:**\n${output || "(no output)"}`,
					display: true,
				}, { triggerTurn: true });

			} catch (err) {
				ctx.ui.notify(`${agentName} error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		asyncJobs.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		asyncJobs.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_branch", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		asyncJobs.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_shutdown", () => {
		watcher.close();
		if (poller) clearInterval(poller);
		poller = null;
		asyncJobs.clear();
		if (lastUiContext?.hasUI) {
			lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
