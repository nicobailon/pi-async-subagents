/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	extensions?: string[];      // Paths to extension files (agent-scoped)
	skills?: string[];          // Paths to skill directories (agent-scoped)
	contextFiles?: string[];    // Paths to context files like AGENTS.md (agent-scoped)
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, body };
}

/**
 * Expand ~ to home directory in a path.
 */
function expandTilde(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	if (p === "~") {
		return os.homedir();
	}
	return p;
}

function parseCommaSeparatedPaths(value: string | undefined, basePath: string): string[] | undefined {
	if (!value) return undefined;
	const paths = value
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			// Expand ~ to home directory
			const expanded = expandTilde(p);
			// Resolve relative paths against the agent file's directory
			if (expanded.startsWith("./") || expanded.startsWith("../") || !path.isAbsolute(expanded)) {
				return path.resolve(basePath, expanded);
			}
			return expanded;
		});
	return paths.length > 0 ? paths : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const agentDir = path.dirname(filePath);

		// Parse tools - resolve any paths (e.g., ./custom-tool.ts) relative to agent dir
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => {
				// If it looks like a path (contains / or ends with .ts/.js), resolve it
				if (t.includes("/") || t.endsWith(".ts") || t.endsWith(".js")) {
					// Expand ~ to home directory
					const expanded = expandTilde(t);
					if (!path.isAbsolute(expanded)) {
						return path.resolve(agentDir, expanded);
					}
					return expanded;
				}
				return t;
			});

		// Parse new agent-scoped fields with path resolution
		const extensions = parseCommaSeparatedPaths(frontmatter.extensions, agentDir);
		const skills = parseCommaSeparatedPaths(frontmatter.skills, agentDir);
		const contextFiles = parseCommaSeparatedPaths(frontmatter.contextFiles || frontmatter["context-files"], agentDir);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			extensions,
			skills,
			contextFiles,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
