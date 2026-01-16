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
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	loadSubagentSettings,
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	cleanupOldChainDirs,
	resolveStepBehavior,
	buildChainInstructions,
	findFirstProgressAgentIndex,
	type StepOverrides,
} from "./settings.js";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.js";
import {
	appendJsonl,
	cleanupOldArtifacts,
	ensureArtifactsDir,
	getArtifactPaths,
	getArtifactsDir,
	writeArtifact,
	writeMetadata,
} from "./artifacts.js";
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
	// Sharing disabled - module resolution issues
	// shareUrl?: string;
	// gistUrl?: string;
	// shareError?: string;
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
	// Sharing disabled
	// shareUrl?: string;
	// shareError?: string;
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
	// shareUrl?: string;
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

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
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

// HTML export and sharing removed - module resolution issues with global pi installation
// The session files are still available at the paths shown in the output

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
}

async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index } = options;
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

	const args = ["--mode", "json", "-p"];
	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionDir) || shareEnabled;
	if (!sessionEnabled) {
		args.push("--no-session");
	}
	if (options.sessionDir) {
		try {
			fs.mkdirSync(options.sessionDir, { recursive: true });
		} catch {}
		args.push("--session-dir", options.sessionDir);
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) {
		const builtinTools: string[] = [];
		const extensionPaths: string[] = [];
		for (const tool of agent.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				extensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
	}

	let tmpDir: string | null = null;
	if (agent.systemPrompt?.trim()) {
		const tmp = writePrompt(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmp.path);
	}
	args.push(`Task: ${task}`);

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
	const jsonlLines: string[] = [];

	let artifactPathsResult: ArtifactPaths | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agentName, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
	}

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd: cwd ?? runtimeCwd, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlLines.push(line);
			try {
				const evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
				const now = Date.now();
				progress.durationMs = now - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					if (onUpdate)
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.unshift({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
						if (progress.recentTools.length > 5) {
							progress.recentTools.pop();
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					if (onUpdate)
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
				}

				if (evt.type === "message_end" && evt.message) {
					result.messages.push(evt.message);
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (!result.model && evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) result.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							const lines = text
								.split("\n")
								.filter((l) => l.trim())
								.slice(-8);
							progress.recentOutput = lines;
						}
					}
					if (onUpdate)
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
				}
				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					if (onUpdate)
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
				}
			} catch {}
		};

		let stderrBuf = "";
		let lastUpdateTime = 0;
		const UPDATE_THROTTLE_MS = 150;

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);

			// Throttled periodic update for smoother progress display
			const now = Date.now();
			if (onUpdate && now - lastUpdateTime > UPDATE_THROTTLE_MS) {
				lastUpdateTime = now;
				progress.durationMs = now - startTime;
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			}
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code) => {
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !result.error) {
				result.error = stderrBuf.trim();
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	result.exitCode = exitCode;

	if (exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
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

	if (artifactPathsResult && artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		const fullOutput = getFinalOutput(result.messages);

		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		if (artifactConfig?.includeJsonl !== false) {
			for (const line of jsonlLines) {
				appendJsonl(artifactPathsResult.jsonlPath, line);
			}
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

	if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) {
			result.sessionFile = sessionFile;
			// HTML export disabled - module resolution issues with global pi installation
			// Users can still access the session file directly
		}
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
	task: Type.Optional(Type.String({ description: "Task template. Use {task}, {previous}, {chain_dir}. Required for first step." })),
	cwd: Type.Optional(Type.String()),
	// Chain behavior overrides
	output: Type.Optional(Type.Union([
		Type.String(),
		Type.Literal(false),
	], { description: "Override output filename, or false for text-only" })),
	reads: Type.Optional(Type.Union([
		Type.Array(Type.String()),
		Type.Literal(false),
	], { description: "Override files to read from {chain_dir}, or false to disable" })),
	progress: Type.Optional(Type.Boolean({ description: "Override progress tracking" })),
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
	// Chain clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to clarify chain templates (default: true for chains). Implies sync mode." })),
	// Solo agent output override
	output: Type.Optional(Type.Union([
		Type.String(),
		Type.Literal(false),
	], { description: "Override output file for single agent (uses agent default if omitted)" })),
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

	// Cleanup old chain directories on startup (after 24h)
	cleanupOldChainDirs();

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
					// job.shareUrl = status.shareUrl ?? job.shareUrl;
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
			// clarify implies sync mode (TUI is blocking)
			// If user requested async without explicit clarify: false, downgrade to sync for chains
			const effectiveAsync = requestedAsync && !hasTasks && (hasChain ? params.clarify === false : true);

			const artifactConfig: ArtifactConfig = {
				...DEFAULT_ARTIFACT_CONFIG,
				enabled: params.artifacts !== false,
			};

			const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
			const artifactsDir = effectiveAsync ? tempArtifactsDir : getArtifactsDir(sessionFile);

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

			// Validate chain early (before async/sync branching)
			if (hasChain && params.chain) {
				if (params.chain.length === 0) {
					return {
						content: [{ type: "text", text: "Chain must have at least one step" }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
				if (!params.chain[0]?.task) {
					return {
						content: [{ type: "text", text: "First step in chain must have a task" }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}

			if (effectiveAsync) {
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
					// Validate all agents exist before building steps
					for (const s of params.chain) {
						if (!agents.find((x) => x.name === s.agent)) {
							return {
								content: [{ type: "text", text: `Unknown agent: ${s.agent}` }],
								isError: true,
								details: { mode: "chain" as const, results: [] },
							};
						}
					}
					const steps = params.chain.map((s, i) => {
						const a = agents.find((x) => x.name === s.agent)!;
						return {
							agent: s.agent,
							// For async, use simple defaults: first step uses inline task, others use {previous}
							task: s.task ?? (i === 0 ? "{task}" : "{previous}"),
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

			if (hasChain && params.chain) {
				// Validation already done earlier (before async/sync branching)
				const originalTask = params.chain[0]!.task!;

				// Create chain directory
				const chainDir = createChainDir(runId);

				// Load agent configs (now includes chain behavior fields)
				// Validate all agents exist before starting
				const agentConfigs: AgentConfig[] = [];
				for (const step of params.chain) {
					const config = agents.find((a) => a.name === step.agent);
					if (!config) {
						removeChainDir(chainDir);
						return {
							content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
							isError: true,
							details: { mode: "chain" as const, results: [] },
						};
					}
					agentConfigs.push(config);
				}

				// Build step overrides from chain params
				const stepOverrides: StepOverrides[] = params.chain.map((step) => ({
					output: step.output,
					reads: step.reads,
					progress: step.progress,
				}));

				// Find first progress agent
				const firstProgressIdx = findFirstProgressAgentIndex(agentConfigs, stepOverrides);

				// Resolve templates (inline > saved > default)
				const settings = loadSubagentSettings();
				let templates = resolveChainTemplates(
					agentConfigs.map((c) => c.name),
					params.chain.map((s) => s.task),
					settings,
				);

				// Pre-resolve behaviors for TUI display
				const resolvedBehaviors = agentConfigs.map((config, i) =>
					resolveStepBehavior(config, stepOverrides[i]!),
				);

				// Show TUI if enabled (default: true for chains)
				const shouldClarify = params.clarify !== false && ctx.hasUI;
				if (shouldClarify) {
					const result = await ctx.ui.custom<ChainClarifyResult>(
						(_tui, theme, _kb, done) =>
							new ChainClarifyComponent(
								theme,
								agentConfigs,
								templates,
								originalTask,
								chainDir,
								resolvedBehaviors,
								done,
							),
						{
							overlay: true,
							overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
						},
					);

					if (!result || !result.confirmed) {
						removeChainDir(chainDir);
						return {
							content: [{ type: "text", text: "Chain cancelled" }],
							details: { mode: "chain", results: [] },
						};
					}
					templates = result.templates;
				}

				// Execute chain
				const results: SingleResult[] = [];
				let prev = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i]!;
					const behavior = resolvedBehaviors[i]!;

					// Build task: template + variable substitution + chain instructions
					let stepTask = templates[i]!;
					stepTask = stepTask.replace(/\{task\}/g, originalTask);
					stepTask = stepTask.replace(/\{previous\}/g, prev);
					stepTask = stepTask.replace(/\{chain_dir\}/g, chainDir);

					// Append chain instructions from behavior
					const isFirstProgress = i === firstProgressIdx;
					stepTask += buildChainInstructions(behavior, chainDir, isFirstProgress);

					// Run step
					const r = await runSync(ctx.cwd, agents, step.agent, stepTask, {
						cwd: step.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
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

					// On failure, leave chain_dir for debugging (don't clean up)
					if (r.exitCode !== 0) {
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
					}

					prev = getFinalOutput(r.messages);
				}

				// Chain complete - return final output
				// Chain dir left for inspection (cleaned up after 24h)
				let finalOutput = prev;
				let truncationInfo: Details["truncation"];
				if (params.maxOutput) {
					const maxOutputConfig = { ...DEFAULT_MAX_OUTPUT, ...params.maxOutput };
					const outputPath = allArtifactPaths[allArtifactPaths.length - 1]?.outputPath;
					const truncResult = truncateOutput(prev, maxOutputConfig, outputPath);
					if (truncResult.truncated) {
						finalOutput = truncResult.text;
						truncationInfo = truncResult;
					}
				}

				// Append chain dir info to output
				finalOutput += `\n\n📁 Chain artifacts: ${chainDir}`;

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
						maxOutput: params.maxOutput,
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
				// Look up agent config for output handling
				const agentConfig = agents.find((a) => a.name === params.agent);
				// Note: runSync already handles unknown agent, but we need config for output

				let task = params.task!;
				let outputPath: string | undefined;

				// Check if agent has output and it's not disabled
				if (agentConfig) {
					const effectiveOutput =
						params.output !== undefined ? params.output : agentConfig.output;

					if (effectiveOutput && effectiveOutput !== false) {
						const outputDir = `/tmp/pi-${agentConfig.name}-${runId}`;
						fs.mkdirSync(outputDir, { recursive: true });
						outputPath = `${outputDir}/${effectiveOutput}`;

						// Inject output instruction into task
						task += `\n\n---\n**Output:** Write your findings to: ${outputPath}`;
					}
				}

				const r = await runSync(ctx.cwd, agents, params.agent!, task, {
					cwd: params.cwd,
					signal,
					runId,
					sessionDir: sessionDirForIndex(0),
					share: shareEnabled,
					artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
					artifactConfig,
					maxOutput: params.maxOutput,
					onUpdate,
				});

				if (r.progress) allProgress.push(r.progress);
				if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

				// Get output and append file path if applicable
				let output = r.truncation?.text || getFinalOutput(r.messages);
				if (outputPath && r.exitCode === 0) {
					output += `\n\n📄 Output saved to: ${outputPath}`;
				}

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
					// Sharing disabled - session file path shown above

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
					lines.push(theme.fg("dim", "(ctrl+o to expand)"));
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
						// Sharing disabled - session file path shown above
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
				lines.push(theme.fg("dim", "(ctrl+o to expand)"));
			} else if (hasRunning) {
				// Fallback: we know something is running but can't find details
				lines.push(theme.fg("dim", "(ctrl+o to expand)"));
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
					// Sharing disabled - session file path shown above
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
