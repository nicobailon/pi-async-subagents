/**
 * SDK-based agent runner.
 *
 * Runs agents via createAgentSession() instead of spawning pi subprocess.
 * Enables agent-scoped extensions, skills, and context files.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	loadExtensions,
	SessionManager,
	SettingsManager,
	type AuthStorage,
	type ModelRegistry,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { loadContextFilesFromPaths, loadSkillsFromPaths, type ContextFile } from "./loaders.js";
import { resolveTools } from "./tool-resolver.js";

/** Progress tracking specific to SDK runner (simpler than types.ts AgentProgress) */
export interface SDKProgress {
	currentTool?: string;
	currentToolArgs?: string;
	toolCount: number;
	tokens: number;
	turns: number;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SDKRunnerOptions {
	agent: AgentConfig;
	task: string;
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onProgress?: (progress: SDKProgress) => void;
	onMessage?: (message: Message) => void;
	/**
	 * Messages to pre-load from parent session.
	 * When provided, the subagent inherits the parent's conversation context
	 * before executing its task.
	 */
	inheritMessages?: AgentMessage[];
}

export interface SDKRunnerResult {
	messages: Message[];
	usage: Usage;
	model?: string;
	exitCode: number;
	error?: string;
}

/**
 * Run an agent using the SDK directly instead of spawning a subprocess.
 *
 * Benefits:
 * - Agent-scoped extensions: Only load extensions specified in agent frontmatter
 * - Agent-scoped skills: Only load skills specified in agent frontmatter
 * - Agent-scoped context: Only load context files specified in agent frontmatter
 * - Faster execution: No subprocess spawn overhead
 * - Better integration: Direct access to session events and messages
 */
export async function runAgentSDK(options: SDKRunnerOptions): Promise<SDKRunnerResult> {
	const { agent, task, cwd, authStorage, modelRegistry, signal, onProgress, onMessage, inheritMessages } = options;

	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};

	const progress: SDKProgress = {
		toolCount: 0,
		tokens: 0,
		turns: 0,
	};

	const messages: Message[] = [];

	try {
		// Resolve model from agent config or use default
		let model = undefined as ReturnType<typeof modelRegistry.find>;
		
		if (agent.model) {
			let modelIdToSearch = agent.model;
			
			// Check if model is in "provider/model-id" format
			if (agent.model.includes("/")) {
				const [provider, modelId] = agent.model.split("/", 2);
				model = modelRegistry.find(provider, modelId);
				modelIdToSearch = modelId; // Use just the model ID for fallback
			}
			
			// If not found or no provider prefix, search by model ID
			if (!model) {
				for (const m of modelRegistry.getAll()) {
					if (m.id === modelIdToSearch) {
						model = m;
						break;
					}
				}
			}
		}

		// Resolve tools
		const { tools, extensionPaths } = resolveTools(agent.tools, cwd);

		// Combine extension paths from tools and agent.extensions
		const allExtensionPaths = [...extensionPaths, ...(agent.extensions || [])];

		// Load agent-scoped skills
		const agentSkills: Skill[] = loadSkillsFromPaths(agent.skills, agent.filePath);

		// Load agent-scoped context files
		const agentContextFiles: ContextFile[] = loadContextFilesFromPaths(agent.contextFiles, agent.filePath);

		// Load agent-scoped extensions manually
		// We can't use extensions: [] with additionalExtensionPaths because the SDK ignores
		// additionalExtensionPaths when extensions is explicitly set (even to empty array)
		const preloadedExtensions = allExtensionPaths.length > 0
			? await loadExtensions(allExtensionPaths, cwd)
			: undefined;

		// Create session with agent-scoped configuration
		const { session } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model,
			// Use agent's system prompt
			systemPrompt: agent.systemPrompt?.trim() || undefined,
			// Use resolved tools
			tools,
			// Disable global extension discovery by providing preloaded (even if undefined triggers discovery)
			// If we have agent-scoped extensions, use preloadedExtensions to skip discovery
			// If no agent extensions, pass extensions: [] to disable all extension discovery
			...(preloadedExtensions
				? { preloadedExtensions }
				: { extensions: [] }),
			// If agent specifies skills, use them (empty means disable discovery)
			// If agent doesn't specify skills (undefined), use default discovery
			skills: agent.skills !== undefined ? agentSkills : undefined,
			// If agent specifies contextFiles, use them (empty means disable discovery)
			// If agent doesn't specify contextFiles (undefined), use default discovery
			contextFiles: agent.contextFiles !== undefined ? agentContextFiles : undefined,
			// In-memory session (no persistence)
			sessionManager: SessionManager.inMemory(),
			// In-memory settings (no file I/O)
			settingsManager: SettingsManager.inMemory(),
		});

		// Pre-load inherited messages from parent session if provided
		// This allows the subagent to "see" the parent's conversation context
		if (inheritMessages && inheritMessages.length > 0) {
			session.agent.replaceMessages(inheritMessages);
		}

		// Subscribe to events for progress tracking
		const unsubscribe = session.subscribe((event) => {
			switch (event.type) {
				case "tool_execution_start":
					progress.toolCount++;
					progress.currentTool = event.toolName;
					progress.currentToolArgs = extractToolArgsPreview(event.args);
					onProgress?.(progress);
					break;

				case "tool_execution_end":
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					onProgress?.(progress);
					break;

				case "message_end":
					if (event.message) {
						// Only collect standard LLM messages (user, assistant, toolResult)
						// Skip custom agent messages (bashExecution, custom, branchSummary, etc.)
						const role = event.message.role;
						if (role === "user" || role === "assistant" || role === "toolResult") {
							messages.push(event.message as Message);
							onMessage?.(event.message as Message);
						}

						if (event.message.role === "assistant") {
							usage.turns++;
							progress.turns++;
							const u = (event.message as any).usage;
							if (u) {
								usage.input += u.input || 0;
								usage.output += u.output || 0;
								usage.cacheRead += u.cacheRead || 0;
								usage.cacheWrite += u.cacheWrite || 0;
								usage.cost += u.cost?.total || 0;
								progress.tokens = usage.input + usage.output;
							}
						}
					}
					break;

				// Note: turn_end also has toolResults but we don't use it here
				// because message_end already provides all messages including tool results
			}
		});

		// Handle abort signal
		if (signal) {
			signal.addEventListener("abort", () => {
				session.abort();
			}, { once: true });
		}

		try {
			// Run the task
			await session.prompt(`Task: ${task}`);

			return {
				messages,
				usage,
				model: session.model?.id,
				exitCode: 0,
			};
		} finally {
			// Always cleanup
			unsubscribe();
			session.dispose();
		}
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return {
			messages,
			usage,
			exitCode: 1,
			error: errorMessage,
		};
	}
}

/**
 * Extract a preview of tool arguments for display.
 */
function extractToolArgsPreview(args: Record<string, unknown> | undefined): string {
	if (!args) return "";

	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}
	return "";
}

/**
 * Get the final text output from messages.
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
