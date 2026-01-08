/**
 * Loaders for agent-scoped skills and context files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

/**
 * Load skills from specified paths.
 *
 * @param paths Array of absolute paths to skill directories (already resolved by agents.ts)
 * @param basePath Base path (agent file path) - used as fallback for relative paths
 * @returns Array of loaded skills
 */
export function loadSkillsFromPaths(paths: string[] | undefined, basePath: string): Skill[] {
	if (!paths || paths.length === 0) {
		return [];
	}

	const skills: Skill[] = [];
	const agentDir = path.dirname(basePath);

	for (const skillPath of paths) {
		// Paths should already be absolute (resolved by agents.ts), but handle relative as fallback
		const resolvedPath = path.isAbsolute(skillPath) ? skillPath : path.resolve(agentDir, skillPath);

		if (!fs.existsSync(resolvedPath)) {
			// Silently skip missing skill paths - they may be optional
			continue;
		}

		const stat = fs.statSync(resolvedPath);
		if (stat.isDirectory()) {
			// Load skills from directory using the SDK's loader
			const result = loadSkillsFromDir({
				dir: resolvedPath,
				source: "agent",
			});
			skills.push(...result.skills);
		} else if (stat.isFile() && resolvedPath.endsWith("SKILL.md")) {
			// Single SKILL.md file - load it directly
			const skill = loadSingleSkill(resolvedPath);
			if (skill) {
				skills.push(skill);
			}
		}
	}

	return skills;
}

/**
 * Load a single SKILL.md file.
 */
function loadSingleSkill(filePath: string): Skill | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter(content);

		if (!frontmatter.description) {
			return null;
		}

		const skillDir = path.dirname(filePath);
		const name = frontmatter.name || path.basename(skillDir);

		return {
			name,
			description: frontmatter.description,
			filePath,
			baseDir: skillDir,
			source: "agent",
		};
	} catch {
		return null;
	}
}

/**
 * Parse YAML frontmatter from markdown content.
 */
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
 * Context file with path and content.
 */
export interface ContextFile {
	path: string;
	content: string;
}

/**
 * Load context files from specified paths.
 *
 * @param paths Array of absolute paths to context files (already resolved by agents.ts)
 * @param basePath Base path (agent file path) - used as fallback for relative paths
 * @returns Array of loaded context files
 */
export function loadContextFilesFromPaths(paths: string[] | undefined, basePath: string): ContextFile[] {
	if (!paths || paths.length === 0) {
		return [];
	}

	const contextFiles: ContextFile[] = [];
	const agentDir = path.dirname(basePath);

	for (const filePath of paths) {
		// Paths should already be absolute (resolved by agents.ts), but handle relative as fallback
		const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(agentDir, filePath);

		if (!fs.existsSync(resolvedPath)) {
			// Silently skip missing context files - they may be optional
			continue;
		}

		try {
			const content = fs.readFileSync(resolvedPath, "utf-8");
			contextFiles.push({
				path: resolvedPath,
				content,
			});
		} catch {
			// Silently skip unreadable files
		}
	}

	return contextFiles;
}
