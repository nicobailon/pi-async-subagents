/**
 * Subagent settings, chain behavior, and template management
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const CHAIN_RUNS_DIR = "/tmp/pi-chain-runs";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// Settings Types
// =============================================================================

export interface ChainTemplates {
	[chainKey: string]: {
		[agentName: string]: string;
	};
}

export interface SubagentSettings {
	chains?: ChainTemplates;
}

// =============================================================================
// Behavior Resolution Types
// =============================================================================

export interface ResolvedStepBehavior {
	output: string | false;
	reads: string[] | false;
	progress: boolean;
}

export interface StepOverrides {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
}

// =============================================================================
// Settings Management
// =============================================================================

export function loadSubagentSettings(): SubagentSettings {
	try {
		const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
		return (data.subagent as SubagentSettings) ?? {};
	} catch {
		return {};
	}
}

export function saveChainTemplate(chainKey: string, templates: Record<string, string>): void {
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
	} catch {}

	if (!settings.subagent) settings.subagent = {};
	const subagent = settings.subagent as Record<string, unknown>;
	if (!subagent.chains) subagent.chains = {};
	const chains = subagent.chains as Record<string, unknown>;

	chains[chainKey] = templates;

	const dir = path.dirname(SETTINGS_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export function getChainKey(agents: string[]): string {
	return agents.join("->");
}

// =============================================================================
// Chain Directory Management
// =============================================================================

export function createChainDir(runId: string): string {
	const chainDir = path.join(CHAIN_RUNS_DIR, runId);
	fs.mkdirSync(chainDir, { recursive: true });
	return chainDir;
}

export function removeChainDir(chainDir: string): void {
	try {
		fs.rmSync(chainDir, { recursive: true });
	} catch {}
}

export function cleanupOldChainDirs(): void {
	if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
	const now = Date.now();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(CHAIN_RUNS_DIR);
	} catch {
		return;
	}

	for (const dir of dirs) {
		try {
			const dirPath = path.join(CHAIN_RUNS_DIR, dir);
			const stat = fs.statSync(dirPath);
			if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
				fs.rmSync(dirPath, { recursive: true });
			}
		} catch {
			// Skip directories that can't be processed; continue with others
		}
	}
}

// =============================================================================
// Template Resolution
// =============================================================================

/**
 * Resolve templates for each step in a chain.
 * Priority: inline task > saved template > default
 * Default for step 0: "{task}", for others: "{previous}"
 */
export function resolveChainTemplates(
	agentNames: string[],
	inlineTasks: (string | undefined)[],
	settings: SubagentSettings,
): string[] {
	const chainKey = getChainKey(agentNames);
	const savedTemplates = settings.chains?.[chainKey] ?? {};

	return agentNames.map((agent, i) => {
		// Priority: inline > saved > default
		const inline = inlineTasks[i];
		if (inline) return inline;

		const saved = savedTemplates[agent];
		if (saved) return saved;

		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
): ResolvedStepBehavior {
	// Output: step override > frontmatter > false (no output)
	const output =
		stepOverrides.output !== undefined
			? stepOverrides.output
			: agentConfig.output ?? false;

	// Reads: step override > frontmatter defaultReads > false (no reads)
	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	// Progress: step override > frontmatter defaultProgress > false
	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: agentConfig.defaultProgress ?? false;

	return { output, reads, progress };
}

/**
 * Find index of first agent in chain that has progress enabled
 */
export function findFirstProgressAgentIndex(
	agentConfigs: AgentConfig[],
	stepOverrides: StepOverrides[],
): number {
	return agentConfigs.findIndex((config, i) => {
		const override = stepOverrides[i];
		if (override?.progress !== undefined) return override.progress;
		return config.defaultProgress ?? false;
	});
}

// =============================================================================
// Chain Instruction Injection
// =============================================================================

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
): string {
	const instructions: string[] = [];

	// Reads
	if (behavior.reads && behavior.reads.length > 0) {
		const files = behavior.reads.map((f) => `${chainDir}/${f}`).join(", ");
		instructions.push(`Read from chain directory: ${files}`);
	}

	// Output
	if (behavior.output) {
		instructions.push(`Write your output to: ${chainDir}/${behavior.output}`);
	}

	// Progress
	if (behavior.progress) {
		const progressPath = `${chainDir}/progress.md`;
		if (isFirstProgressAgent) {
			instructions.push(`Create and maintain: ${progressPath}`);
			instructions.push("Format: Status, Tasks (checkboxes), Files Changed, Notes");
		} else {
			instructions.push(`Read and update: ${progressPath}`);
		}
	}

	if (instructions.length === 0) return "";

	return (
		"\n\n---\n**Chain Instructions:**\n" + instructions.map((i) => `- ${i}`).join("\n")
	);
}
