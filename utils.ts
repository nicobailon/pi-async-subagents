/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AsyncStatus, DisplayItem, ErrorInfo } from "./types.js";

// ============================================================================
// File System Utilities
// ============================================================================

// Cache for status file reads - avoid re-reading unchanged files
const statusCache = new Map<string, { mtime: number; status: AsyncStatus }>();

/**
 * Read async job status from disk (with mtime-based caching)
 */
export function readStatus(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	try {
		const stat = fs.statSync(statusPath);
		const cached = statusCache.get(statusPath);
		if (cached && cached.mtime === stat.mtimeMs) {
			return cached.status;
		}
		const content = fs.readFileSync(statusPath, "utf-8");
		const status = JSON.parse(content) as AsyncStatus;
		statusCache.set(statusPath, { mtime: stat.mtimeMs, status });
		// Limit cache size to prevent memory leaks
		if (statusCache.size > 50) {
			const firstKey = statusCache.keys().next().value;
			if (firstKey) statusCache.delete(firstKey);
		}
		return status;
	} catch {
		return null;
	}
}

// Cache for output tail reads - avoid re-reading unchanged files
const outputTailCache = new Map<string, { mtime: number; size: number; lines: string[] }>();

/**
 * Get the last N lines from an output file (with mtime/size-based caching)
 */
export function getOutputTail(outputFile: string | undefined, maxLines: number = 3): string[] {
	if (!outputFile) return [];
	let fd: number | null = null;
	try {
		const stat = fs.statSync(outputFile);
		if (stat.size === 0) return [];

		// Check cache using both mtime and size (size changes more frequently during writes)
		const cached = outputTailCache.get(outputFile);
		if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
			return cached.lines;
		}

		const tailBytes = 4096;
		const start = Math.max(0, stat.size - tailBytes);
		fd = fs.openSync(outputFile, "r");
		const buffer = Buffer.alloc(Math.min(tailBytes, stat.size));
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const content = buffer.toString("utf-8");
		const allLines = content.split("\n").filter((l) => l.trim());
		const lines = allLines.slice(-maxLines).map((l) => l.slice(0, 120) + (l.length > 120 ? "..." : ""));

		// Cache the result
		outputTailCache.set(outputFile, { mtime: stat.mtimeMs, size: stat.size, lines });
		// Limit cache size
		if (outputTailCache.size > 20) {
			const firstKey = outputTailCache.keys().next().value;
			if (firstKey) outputTailCache.delete(firstKey);
		}

		return lines;
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

/**
 * Get human-readable last activity time for a file
 */
export function getLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	try {
		// Single stat call - throws if file doesn't exist
		const stat = fs.statSync(outputFile);
		const ago = Date.now() - stat.mtimeMs;
		if (ago < 1000) return "active now";
		if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
		return `active ${Math.floor(ago / 60000)}m ago`;
	} catch {
		return "";
	}
}

/**
 * Find a file/directory by prefix in a directory
 */
export function findByPrefix(dir: string, prefix: string, suffix?: string): string | null {
	if (!fs.existsSync(dir)) return null;
	const entries = fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix));
	if (suffix) {
		const withSuffix = entries.filter((entry) => entry.endsWith(suffix));
		if (withSuffix.length > 0) return path.join(dir, withSuffix.sort()[0]);
	}
	if (entries.length === 0) return null;
	return path.join(dir, entries.sort()[0]);
}

/**
 * Find the latest session file in a directory
 */
export function findLatestSessionFile(sessionDir: string): string | null {
	if (!fs.existsSync(sessionDir)) return null;
	const files = fs.readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const filePath = path.join(sessionDir, f);
			return {
				name: f,
				path: filePath,
				mtime: fs.statSync(filePath).mtimeMs,
			};
		})
		.sort((a, b) => b.mtime - a.mtime);
	return files.length > 0 ? files[0].path : null;
}

/**
 * Write a prompt to a temporary file
 */
export function writePrompt(agent: string, prompt: string): { dir: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const p = path.join(dir, `${agent.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(p, prompt, { mode: 0o600 });
	return { dir, path: p };
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

/**
 * Get the final text output from a list of messages
 */
export function getFinalOutput(messages: Message[]): string {
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

/**
 * Extract display items (text and tool calls) from messages
 */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
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

/**
 * Check if an error is recoverable (agent can continue after it)
 * Recoverable errors include:
 * - Reading non-existent files (common read-before-write pattern)
 * - File not found errors that the agent might create later
 */
function isRecoverableError(toolName: string, details: string | undefined): boolean {
	if (!details) return false;
	
	// Read tool errors for non-existent files are recoverable
	// (agent often tries to read before writing)
	if (toolName === "read" && /ENOENT|no such file|does not exist/i.test(details)) {
		return true;
	}
	
	// Bash errors for file operations that might be preconditions
	if (toolName === "bash") {
		// "test -f" or "[ -f" checks are recoverable
		if (/test\s+-[fedrwx]|^\s*\[\s*-[fedrwx]/i.test(details)) {
			return true;
		}
		// cat/head/tail on non-existent file (might be checking if exists)
		if (/ENOENT|No such file|cannot open/i.test(details) && 
			/\b(cat|head|tail|less|more)\b/i.test(details)) {
			return true;
		}
	}
	
	return false;
}

/**
 * Detect errors in subagent execution from messages.
 * 
 * Only reports errors that appear to be "final" failures, not transient/recoverable ones.
 * This prevents false positives from:
 * - Read-before-write patterns (trying to read a file before creating it)
 * - Recoverable errors that the agent handled gracefully
 * 
 * Strategy:
 * 1. Only consider tool errors from the last N tool results (agent may have recovered)
 * 2. Ignore known recoverable error patterns (ENOENT on read, etc.)
 * 3. Check if subsequent successful actions suggest recovery
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
	// Collect all tool results with their indices for analysis
	const toolResults: Array<{ index: number; msg: Message; toolName: string; isError: boolean; details?: string }> = [];
	
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			const toolName = (msg as any).toolName || "unknown";
			const isError = (msg as any).isError === true;
			const textPart = msg.content.find((c) => c.type === "text");
			const details = textPart && "text" in textPart ? textPart.text : undefined;
			toolResults.push({ index: i, msg, toolName, isError, details });
		}
	}
	
	if (toolResults.length === 0) {
		return { hasError: false };
	}
	
	// Only check the last few tool results for errors (allow recovery from earlier failures)
	// Use last 3 results, or all if fewer than 3
	const recentCount = Math.min(3, toolResults.length);
	const recentResults = toolResults.slice(-recentCount);
	
	// Check for explicit tool errors (isError flag) in recent results only
	for (const { toolName, isError, details } of recentResults) {
		if (isError) {
			// Skip recoverable errors
			if (isRecoverableError(toolName, details)) {
				continue;
			}
			
			const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
			return {
				hasError: true,
				exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
				errorType: toolName,
				details: details?.slice(0, 200),
			};
		}
	}
	
	// Check for bash errors in recent results
	for (const { toolName, details } of recentResults) {
		if (toolName !== "bash" || !details) continue;
		
		// Skip recoverable patterns
		if (isRecoverableError(toolName, details)) {
			continue;
		}

		const exitMatch = details.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		if (exitMatch) {
			const code = parseInt(exitMatch[1], 10);
			if (code !== 0) {
				return { hasError: true, exitCode: code, errorType: "bash", details: details.slice(0, 200) };
			}
		}

		// Only check fatal error patterns (not recoverable file-not-found)
		const fatalPatterns = [
			/command not found/i,
			/permission denied/i,
			/segmentation fault/i,
			/killed|terminated/i,
			/out of memory/i,
			/connection refused/i,
			/timeout/i,
		];
		for (const pattern of fatalPatterns) {
			if (pattern.test(details)) {
				return { hasError: true, exitCode: 1, errorType: "bash", details: details.slice(0, 200) };
			}
		}
	}

	return { hasError: false };
}

/**
 * Extract a preview of tool arguments for display
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Handle MCP tool calls - show server/tool info
	if (args.tool && typeof args.tool === "string") {
		const server = args.server && typeof args.server === "string" ? `${args.server}/` : "";
		const toolArgs = args.args && typeof args.args === "string" ? ` ${args.args.slice(0, 40)}` : "";
		return `${server}${args.tool}${toolArgs}`;
	}
	
	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}
	
	// Fallback: show first string value found
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > 0) {
			const preview = value.length > 50 ? `${value.slice(0, 47)}...` : value;
			return `${key}=${preview}`;
		}
	}
	return "";
}

/**
 * Extract text content from various message content formats
 */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	// Handle string content directly
	if (typeof content === "string") return content;
	// Handle array content
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			// Handle { type: "text", text: "..." }
			if ("type" in part && part.type === "text" && "text" in part) {
				texts.push(String(part.text));
			}
			// Handle { type: "tool_result", content: "..." }
			else if ("type" in part && part.type === "tool_result" && "content" in part) {
				const inner = extractTextFromContent(part.content);
				if (inner) texts.push(inner);
			}
			// Handle { text: "..." } without type
			else if ("text" in part) {
				texts.push(String(part.text));
			}
		}
	}
	return texts.join("\n");
}

// ============================================================================
// Concurrency Utilities
// ============================================================================

/**
 * Map over items with limited concurrency
 */
export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(): Promise<void> {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}
