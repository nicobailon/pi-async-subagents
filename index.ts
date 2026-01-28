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

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { cleanupOldChainDirs, getStepAgents, isParallelStep, resolveStepBehavior, type ChainStep, type SequentialStep } from "./settings.js";
import { ChainClarifyComponent, type ChainClarifyResult, type ModelInfo } from "./chain-clarify.js";
import { cleanupOldArtifacts, getArtifactsDir } from "./artifacts.js";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncJobState,
	type Details,
	type ExtensionConfig,
	type SingleResult,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	DEFAULT_MAX_OUTPUT,
	MAX_CONCURRENCY,
	MAX_PARALLEL,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	WIDGET_KEY,
} from "./types.js";
import { formatDuration } from "./formatters.js";
import { readStatus, findByPrefix, getFinalOutput, mapConcurrent } from "./utils.js";
import { runSync } from "./execution.js";
import { renderWidget, renderSubagentResult } from "./render.js";
import { SubagentParams, StatusParams } from "./schemas.js";
import { executeChain } from "./chain-execution.js";
import { isAsyncAvailable, executeAsyncChain, executeAsyncSingle } from "./async-execution.js";
import { discoverAvailableSkills, normalizeSkillInput } from "./skills.js";

// ExtensionConfig is now imported from ./types.js

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
	const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>(); // Track cleanup timeouts
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
				// Skip status reads for finished jobs - they won't change
				if (job.status === "complete" || job.status === "failed") {
					continue;
				}
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
		poller.unref?.();
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
	watcher.unref?.();
	fs.readdirSync(RESULTS_DIR)
		.filter((f) => f.endsWith(".json"))
		.forEach(handleResult);

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: `Delegate to subagents. Use exactly ONE mode:
• SINGLE: { agent, task } - one task
• CHAIN: { chain: [{agent:"scout"}, {agent:"planner"}] } - sequential pipeline
• PARALLEL: { tasks: [{agent,task}, ...] } - concurrent execution

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., /tmp/pi-chain-runs/abc123/)

CHAIN DATA FLOW:
1. Each step's text response automatically becomes {previous} for the next step
2. Steps can also write files to {chain_dir} (via agent's "output" config)
3. Later steps can read those files (via agent's "reads" config)

Example: { chain: [{agent:"scout", task:"Analyze {task}"}, {agent:"planner", task:"Plan based on {previous}"}] }`,
		parameters: SubagentParams,

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
			// - Chains default to TUI (clarify: true), so async requires explicit clarify: false
			// - Single defaults to no TUI, so async is allowed unless clarify: true is passed
			const effectiveAsync = requestedAsync && !hasTasks && (
				hasChain 
					? params.clarify === false    // chains: only async if TUI explicitly disabled
					: params.clarify !== true     // single: async unless TUI explicitly enabled
			);

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
				// First step must have a task
				const firstStep = params.chain[0] as ChainStep;
				if (isParallelStep(firstStep)) {
					// All tasks in the first parallel step must have tasks (no {previous} to reference)
					const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
					if (missingTaskIndex !== -1) {
						return {
							content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
							isError: true,
							details: { mode: "chain" as const, results: [] },
						};
					}
				} else if (!(firstStep as SequentialStep).task) {
					return {
						content: [{ type: "text", text: "First step in chain must have a task" }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
				// Validate all agents exist
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i] as ChainStep;
					const stepAgents = getStepAgents(step);
					for (const agentName of stepAgents) {
						if (!agents.find((a) => a.name === agentName)) {
							return {
								content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
								isError: true,
								details: { mode: "chain" as const, results: [] },
							};
						}
					}
					// Validate parallel steps have at least one task
					if (isParallelStep(step) && step.parallel.length === 0) {
						return {
							content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
							isError: true,
							details: { mode: "chain" as const, results: [] },
						};
					}
				}
			}

			if (effectiveAsync) {
				if (!isAsyncAvailable()) {
					return {
						content: [{ type: "text", text: "jiti not found" }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				}
				const id = randomUUID();
				const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: currentSessionId! };

				if (hasChain && params.chain) {
					const normalized = normalizeSkillInput(params.skill);
					const chainSkills = normalized === false ? [] : (normalized ?? []);
					return executeAsyncChain(id, {
						chain: params.chain as ChainStep[],
						agents,
						ctx: asyncCtx,
						cwd: params.cwd,
						maxOutput: params.maxOutput,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						shareEnabled,
						sessionRoot,
						chainSkills,
					});
				}

				if (hasSingle) {
					const a = agents.find((x) => x.name === params.agent);
					if (!a) {
						return {
							content: [{ type: "text", text: `Unknown: ${params.agent}` }],
							isError: true,
							details: { mode: "single" as const, results: [] },
						};
					}
					return executeAsyncSingle(id, {
						agent: params.agent!,
						task: params.task!,
						agentConfig: a,
						ctx: asyncCtx,
						cwd: params.cwd,
						maxOutput: params.maxOutput,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						shareEnabled,
						sessionRoot,
						skills: (() => {
							const normalized = normalizeSkillInput(params.skill);
							if (normalized === false) return [];
							if (normalized === undefined) return undefined;
							return normalized;
						})(),
					});
				}
			}

			const allProgress: AgentProgress[] = [];
			const allArtifactPaths: ArtifactPaths[] = [];

			if (hasChain && params.chain) {
				const normalized = normalizeSkillInput(params.skill);
				const chainSkills = normalized === false ? [] : (normalized ?? []);
				// Use extracted chain execution module
				return executeChain({
					chain: params.chain as ChainStep[],
					agents,
					ctx,
					signal,
					runId,
					cwd: params.cwd,
					shareEnabled,
					sessionDirForIndex,
					artifactsDir,
					artifactConfig,
					includeProgress: params.includeProgress,
					clarify: params.clarify,
					onUpdate,
					chainSkills,
				});
			}

			if (hasTasks && params.tasks) {
				// MAX_PARALLEL check first (fail fast before TUI)
				if (params.tasks.length > MAX_PARALLEL)
					return {
						content: [{ type: "text", text: `Max ${MAX_PARALLEL} tasks` }],
						isError: true,
						details: { mode: "parallel" as const, results: [] },
					};

				// Validate all agents exist
				const agentConfigs: AgentConfig[] = [];
				for (const t of params.tasks) {
					const config = agents.find(a => a.name === t.agent);
					if (!config) {
						return {
							content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
							isError: true,
							details: { mode: "parallel" as const, results: [] },
						};
					}
					agentConfigs.push(config);
				}

				// Mutable copies for TUI modifications
				let tasks = params.tasks.map(t => t.task);
				const modelOverrides: (string | undefined)[] = new Array(params.tasks.length).fill(undefined);
				// Initialize skill overrides from task-level skill params (may be overridden by TUI)
				const skillOverrides: (string[] | false | undefined)[] = params.tasks.map(t => 
					normalizeSkillInput((t as { skill?: string | string[] | boolean }).skill)
				);

				// Show clarify TUI if requested
				if (params.clarify === true && ctx.hasUI) {
					// Get available models (same pattern as chain-execution.ts)
					const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
						provider: m.provider,
						id: m.id,
						fullId: `${m.provider}/${m.id}`,
					}));

					// Resolve behaviors with task-level skill overrides for TUI display
					const behaviors = agentConfigs.map((c, i) => 
						resolveStepBehavior(c, { skills: skillOverrides[i] })
					);
					const availableSkills = discoverAvailableSkills(ctx.cwd);

					const result = await ctx.ui.custom<ChainClarifyResult>(
						(tui, theme, _kb, done) =>
							new ChainClarifyComponent(
								tui, theme,
								agentConfigs,
								tasks,
								'',          // no originalTask for parallel (each task is independent)
								undefined,   // no chainDir for parallel
								behaviors,
								availableModels,
								availableSkills,
								done,
								'parallel',  // mode
							),
						{ overlay: true, overlayOptions: { anchor: 'center', width: 84, maxHeight: '80%' } },
					);

					if (!result || !result.confirmed) {
						return { content: [{ type: 'text', text: 'Cancelled' }], details: { mode: 'parallel', results: [] } };
					}

					// Apply TUI overrides
					tasks = result.templates;
					for (let i = 0; i < result.behaviorOverrides.length; i++) {
						const override = result.behaviorOverrides[i];
						if (override?.model) modelOverrides[i] = override.model;
						if (override?.skills !== undefined) skillOverrides[i] = override.skills;
					}
				}

				// Execute with overrides (tasks array has same length as params.tasks)
				const behaviors = agentConfigs.map(c => resolveStepBehavior(c, {}));
				const results = await mapConcurrent(params.tasks, MAX_CONCURRENCY, async (t, i) => {
					const overrideSkills = skillOverrides[i];
					const effectiveSkills = overrideSkills === undefined ? behaviors[i]?.skills : overrideSkills;
					return runSync(ctx.cwd, agents, t.agent, tasks[i]!, {
						cwd: t.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						maxOutput: params.maxOutput,
						modelOverride: modelOverrides[i],
						skills: effectiveSkills === false ? [] : effectiveSkills,
					});
				});

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
				if (!agentConfig) {
					return {
						content: [{ type: 'text', text: `Unknown agent: ${params.agent}` }],
						isError: true,
						details: { mode: 'single', results: [] },
					};
				}

				let task = params.task!;
				let modelOverride: string | undefined;
				let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
				// Normalize output: true means "use default" (same as undefined), false means disable
				const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
				let effectiveOutput: string | false | undefined = rawOutput === true ? agentConfig.output : rawOutput;

				// Show clarify TUI if requested
				if (params.clarify === true && ctx.hasUI) {
					// Get available models (same pattern as chain-execution.ts)
					const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
						provider: m.provider,
						id: m.id,
						fullId: `${m.provider}/${m.id}`,
					}));

					const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
					const availableSkills = discoverAvailableSkills(ctx.cwd);

					const result = await ctx.ui.custom<ChainClarifyResult>(
						(tui, theme, _kb, done) =>
							new ChainClarifyComponent(
								tui, theme,
								[agentConfig],
								[task],
								task,
								undefined,  // no chainDir for single
								[behavior],
								availableModels,
								availableSkills,
								done,
								'single',   // mode
							),
						{ overlay: true, overlayOptions: { anchor: 'center', width: 84, maxHeight: '80%' } },
					);

					if (!result || !result.confirmed) {
						return { content: [{ type: 'text', text: 'Cancelled' }], details: { mode: 'single', results: [] } };
					}

					// Apply TUI overrides
					task = result.templates[0]!;
					const override = result.behaviorOverrides[0];
					if (override?.model) modelOverride = override.model;
					if (override?.output !== undefined) effectiveOutput = override.output;
					if (override?.skills !== undefined) skillOverride = override.skills;
				}

				// Compute output path at runtime (uses effectiveOutput which may be TUI-modified)
				let outputPath: string | undefined;
				if (typeof effectiveOutput === 'string' && effectiveOutput) {
					const outputDir = `/tmp/pi-${agentConfig.name}-${runId}`;
					fs.mkdirSync(outputDir, { recursive: true });
					outputPath = `${outputDir}/${effectiveOutput}`;

					// Inject output instruction into task
					task += `\n\n---\n**Output:** Write your findings to: ${outputPath}`;
				}

				const effectiveSkills = skillOverride === false
					? []
					: skillOverride === undefined
						? undefined
						: skillOverride;

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
					modelOverride,
					skills: effectiveSkills,
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

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
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
		// Schedule cleanup after 10 seconds (track timer for cleanup on shutdown)
		const timer = setTimeout(() => {
			cleanupTimers.delete(asyncId);
			asyncJobs.delete(asyncId);
			if (lastUiContext) renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, 10000);
		cleanupTimers.set(asyncId, timer);
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
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
		asyncJobs.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
		asyncJobs.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_branch", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
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
		// Clear all pending cleanup timers
		for (const timer of cleanupTimers.values()) {
			clearTimeout(timer);
		}
		cleanupTimers.clear();
		asyncJobs.clear();
		if (lastUiContext?.hasUI) {
			lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
