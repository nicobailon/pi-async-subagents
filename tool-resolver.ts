/**
 * Tool resolution helper for SDK-based agent execution.
 * Maps tool names to tool instances with correct cwd binding.
 */

import {
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	type Tool,
} from "@mariozechner/pi-coding-agent";

const BUILTIN_TOOL_FACTORIES: Record<string, (cwd: string) => Tool> = {
	read: createReadTool,
	bash: createBashTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
};

export interface ResolveToolsResult {
	/** Tool instances for builtin tools */
	tools: Tool[];
	/** Extension paths for tools provided via extensions (e.g., custom .ts files) */
	extensionPaths: string[];
}

/**
 * Resolve tool names to tool instances.
 *
 * - Builtin names (read, bash, edit, write, grep, find, ls) → Tool instances
 * - Paths ending in .ts/.js or containing / → Extension paths (loaded separately)
 *
 * @param toolNames Array of tool names or paths from agent frontmatter
 * @param cwd Working directory to bind tools to
 */
export function resolveTools(toolNames: string[] | undefined, cwd: string): ResolveToolsResult {
	if (!toolNames || toolNames.length === 0) {
		// Default: all coding tools
		return {
			tools: [
				createReadTool(cwd),
				createBashTool(cwd),
				createEditTool(cwd),
				createWriteTool(cwd),
			],
			extensionPaths: [],
		};
	}

	const tools: Tool[] = [];
	const extensionPaths: string[] = [];

	for (const name of toolNames) {
		// Check if it's an extension path (contains / or ends with .ts/.js)
		if (name.includes("/") || name.endsWith(".ts") || name.endsWith(".js")) {
			extensionPaths.push(name);
			continue;
		}

		// Check if it's a builtin tool
		const factory = BUILTIN_TOOL_FACTORIES[name.toLowerCase()];
		if (factory) {
			tools.push(factory(cwd));
		}
		// Unknown tool names are silently skipped - they may be provided by extensions
	}

	return { tools, extensionPaths };
}

/**
 * Get all builtin tool names.
 */
export function getBuiltinToolNames(): string[] {
	return Object.keys(BUILTIN_TOOL_FACTORIES);
}

/**
 * Check if a tool name is a builtin tool.
 */
export function isBuiltinTool(name: string): boolean {
	return name.toLowerCase() in BUILTIN_TOOL_FACTORIES;
}
