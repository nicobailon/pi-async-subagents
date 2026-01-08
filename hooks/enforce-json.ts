/**
 * JSON output enforcement hook
 * 
 * Validates that the agent's final output is valid JSON.
 * If not, sends a correction message to retry.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_RETRIES = 2;

export default function(pi: ExtensionAPI) {
	// Track retry count per extension instance (resets when extension loads)
	let retryCount = 0;
	
	// Reset on session start
	pi.on("session_start", async () => {
		retryCount = 0;
	});
	
	pi.on("agent_end", async (event) => {
		const assistantMessages = event.messages?.filter(m => m.role === "assistant") || [];
		const lastMsg = assistantMessages[assistantMessages.length - 1];
		if (!lastMsg) return;
		
		const text = lastMsg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n")
			.trim();
		
		try {
			JSON.parse(text);
			retryCount = 0; // Reset on success
		} catch {
			if (retryCount < MAX_RETRIES) {
				retryCount++;
				pi.sendMessage({
					customType: "json-retry",
					content: `Output is not valid JSON. Attempt ${retryCount}/${MAX_RETRIES}. Output ONLY valid JSON, no prose or markdown.`,
					display: true,
				}, { triggerTurn: true });
			}
		}
	});
}
