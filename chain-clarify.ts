/**
 * Chain Clarification TUI Component
 *
 * Shows templates and resolved behaviors for each step in a chain.
 * Supports template editing before chain execution.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";
import type { ResolvedStepBehavior } from "./settings.js";

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
}

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = 84;

	private selectedStep = 0;
	private editingStep: number | null = null;
	private editBuffer: string[] = [];
	private editCursor = { line: 0, col: 0 };

	constructor(
		private theme: Theme,
		private agentConfigs: AgentConfig[],
		private templates: string[],
		private originalTask: string,
		private chainDir: string,
		private resolvedBehaviors: ResolvedStepBehavior[],
		private done: (result: ChainClarifyResult) => void,
	) {}

	handleInput(data: string): void {
		if (this.editingStep !== null) {
			this.handleEditInput(data);
			return;
		}

		// Navigation mode
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ confirmed: false, templates: [] });
			return;
		}

		if (matchesKey(data, "return")) {
			this.done({ confirmed: true, templates: this.templates });
			return;
		}

		if (matchesKey(data, "up")) {
			this.selectedStep = Math.max(0, this.selectedStep - 1);
			return;
		}

		if (matchesKey(data, "down")) {
			this.selectedStep = Math.min(this.agentConfigs.length - 1, this.selectedStep + 1);
			return;
		}

		if (matchesKey(data, "tab") || data === "e") {
			this.enterEditMode();
			return;
		}
	}

	private enterEditMode(): void {
		this.editingStep = this.selectedStep;
		const template = this.templates[this.selectedStep] ?? "";
		this.editBuffer = template.split("\n");
		const lastLine = this.editBuffer.length - 1;
		this.editCursor = { line: lastLine, col: (this.editBuffer[lastLine] ?? "").length };
	}

	private handleEditInput(data: string): void {
		// Escape saves and exits
		if (matchesKey(data, "escape")) {
			this.templates[this.editingStep!] = this.editBuffer.join("\n");
			this.editingStep = null;
			return;
		}

		const line = this.editCursor.line;
		const col = this.editCursor.col;
		const currentLine = this.editBuffer[line] ?? "";

		// Backspace
		if (matchesKey(data, "backspace")) {
			if (col > 0) {
				this.editBuffer[line] = currentLine.slice(0, col - 1) + currentLine.slice(col);
				this.editCursor.col--;
			} else if (line > 0) {
				// Merge with previous line
				const prevLine = this.editBuffer[line - 1] ?? "";
				this.editBuffer[line - 1] = prevLine + currentLine;
				this.editBuffer.splice(line, 1);
				this.editCursor.line--;
				this.editCursor.col = prevLine.length;
			}
			return;
		}

		// Enter - new line
		if (matchesKey(data, "return")) {
			const before = currentLine.slice(0, col);
			const after = currentLine.slice(col);
			this.editBuffer[line] = before;
			this.editBuffer.splice(line + 1, 0, after);
			this.editCursor.line++;
			this.editCursor.col = 0;
			return;
		}

		// Arrow keys
		if (matchesKey(data, "left")) {
			if (col > 0) this.editCursor.col--;
			else if (line > 0) {
				this.editCursor.line--;
				this.editCursor.col = (this.editBuffer[line - 1] ?? "").length;
			}
			return;
		}
		if (matchesKey(data, "right")) {
			if (col < currentLine.length) this.editCursor.col++;
			else if (line < this.editBuffer.length - 1) {
				this.editCursor.line++;
				this.editCursor.col = 0;
			}
			return;
		}
		if (matchesKey(data, "up") && line > 0) {
			this.editCursor.line--;
			this.editCursor.col = Math.min(col, (this.editBuffer[line - 1] ?? "").length);
			return;
		}
		if (matchesKey(data, "down") && line < this.editBuffer.length - 1) {
			this.editCursor.line++;
			this.editCursor.col = Math.min(col, (this.editBuffer[line + 1] ?? "").length);
			return;
		}

		// Insert printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.editBuffer[line] = currentLine.slice(0, col) + data + currentLine.slice(col);
			this.editCursor.col++;
		}
	}

	render(_width: number): string[] {
		// Use fixed width for overlay
		const w = this.width;
		const innerW = w - 2;
		const th = this.theme;
		const lines: string[] = [];

		// Helper to pad line to inner width
		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) =>
			th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		// Header with chain name (truncate if too long)
		const chainLabel = this.agentConfigs.map((c) => c.name).join(" → ");
		const maxHeaderLen = innerW - 4;
		const headerText = ` Chain: ${truncateToWidth(chainLabel, maxHeaderLen - 9)} `;
		const headerPadLen = Math.max(0, innerW - visibleWidth(headerText));
		const headerPadLeft = Math.floor(headerPadLen / 2);
		const headerPadRight = headerPadLen - headerPadLeft;
		const headerLine =
			th.fg("border", "╭" + "─".repeat(headerPadLeft)) +
			th.fg("accent", headerText) +
			th.fg("border", "─".repeat(headerPadRight) + "╮");
		lines.push(headerLine);

		lines.push(row(""));

		// Original task (truncated) and chain dir
		const taskPreview = truncateToWidth(this.originalTask, innerW - 16);
		lines.push(row(` Original Task: ${taskPreview}`));
		lines.push(row(` Chain Dir: ${th.fg("dim", this.chainDir)}`));
		lines.push(row(""));

		// Each step
		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const template =
				this.editingStep === i ? this.editBuffer.join("\n") : this.templates[i]!;
			const isSelected = i === this.selectedStep;
			const isEditing = i === this.editingStep;

			// Step header
			const color = isEditing ? "warning" : isSelected ? "accent" : "dim";
			const stepLabel = `Step ${i + 1}: ${config.name}`;
			lines.push(
				row(` ${th.fg(color, isSelected ? "▶ " + stepLabel : "  " + stepLabel)}`),
			);

			// Template preview (first line only, with variable highlighting)
			const templateFirstLine = template.split("\n")[0] ?? "";
			let highlighted = templateFirstLine
				.replace(/\{task\}/g, th.fg("success", "{task}"))
				.replace(/\{previous\}/g, th.fg("warning", "{previous}"))
				.replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));

			// Show cursor in edit mode
			if (isEditing && this.editCursor.line === 0) {
				const before = templateFirstLine.slice(0, this.editCursor.col);
				const cursorChar = templateFirstLine[this.editCursor.col] ?? " ";
				const after = templateFirstLine.slice(this.editCursor.col + 1);
				highlighted = `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
			}

			lines.push(row(`     ${truncateToWidth(highlighted, innerW - 6)}`));

			// Behavior summary - show RESOLVED behavior after step overrides
			const behavior = this.resolvedBehaviors[i]!;
			const behaviors: string[] = [];
			if (behavior.output) behaviors.push(`output: ${behavior.output}`);
			else if (config.output)
				behaviors.push(th.fg("dim", `output: ${config.output} (disabled)`));
			if (behavior.reads && behavior.reads.length > 0)
				behaviors.push(`reads: [${behavior.reads.join(", ")}]`);
			if (behavior.progress) behaviors.push("progress: ✓");
			if (behaviors.length) {
				lines.push(row(`     ${th.fg("dim", "⚙ " + behaviors.join(" • "))}`));
			}
			lines.push(row(""));
		}

		// Footer with keybindings
		const footerText = " [Enter] Run • [Esc] Cancel • [Tab] Edit • [↑↓] Navigate ";
		const footerPadLen = Math.max(0, innerW - visibleWidth(footerText));
		const footerPadLeft = Math.floor(footerPadLen / 2);
		const footerPadRight = footerPadLen - footerPadLeft;
		const footerLine =
			th.fg("border", "╰" + "─".repeat(footerPadLeft)) +
			th.fg("dim", footerText) +
			th.fg("border", "─".repeat(footerPadRight) + "╯");
		lines.push(footerLine);

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
