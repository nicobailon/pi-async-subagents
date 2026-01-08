/**
 * Read-only bash hook
 * 
 * Blocks write commands (rm, mv, cp, mkdir, touch, chmod, git commit, etc.)
 * in bash tool calls. Use this for read-only agents like scouts or reviewers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Word-boundary commands
const WRITE_COMMANDS = /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|sed\s+-i|git\s+(commit|push|add)|npm\s+(publish|version))\b/;
// Output redirects (can't use word boundary for operators)
const OUTPUT_REDIRECT = /[^>]>>?[^>]/;

export default function(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		
		const cmd = event.input.command as string;
		
		if (WRITE_COMMANDS.test(cmd) || OUTPUT_REDIRECT.test(` ${cmd} `)) {
			return {
				block: true,
				reason: "This agent is read-only. Write commands are blocked.",
			};
		}
		
		return undefined;
	});
}
