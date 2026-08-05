import {
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TranscriptSelectionYieldContext,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@adrouter/tui";
import chalk from "chalk";
import { formatAdRouterSubsidy } from "../../../core/adrouter-session.ts";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { type ThemeColor, theme as uiTheme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { fitDisplayDirectory } from "./path-display.ts";

function panelColor(color: ThemeColor, text: string): string {
	return chalk.level === 0 || process.env.NO_COLOR ? text : uiTheme.fg(color, text);
}

export interface EditorMetadata {
	cwd?: string;
	gitBranch?: string;
	sessionName?: string;
	profileName?: string;
	modeLabel?: string;
	modelLabel?: string;
	providerLabel?: string;
	thinkingLabel?: string;
	contextTokens?: number | null;
	contextWindow?: number;
	extensionStatuses?: string[];
	totalCost?: number;
	totalSubsidy?: number;
	effectiveCost?: number;
	autoCompactEnabled?: boolean;
	rightLabel?: string;
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private metadataProvider: (() => EditorMetadata) | undefined;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	setMetadataProvider(provider: (() => EditorMetadata) | undefined): void {
		this.metadataProvider = provider;
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const meta = this.metadataProvider?.() ?? {};
		const panelWidth = Math.max(1, width);
		const promptGutter = panelWidth >= 3 ? 2 : 0;
		const rightPadding = panelWidth - promptGutter >= 2 ? 1 : 0;
		const layoutWidth = Math.max(1, panelWidth - promptGutter - rightPadding);
		this.lastWidth = layoutWidth;
		const layoutLines = this.layoutText(layoutWidth);
		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, layoutLines.length - maxVisibleLines)));
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
		const result: string[] = [];

		result.push(this.renderMetadataLine(meta, width));

		const foregroundSample = chalk.level === 0 || process.env.NO_COLOR ? "" : this.borderColor("");
		const foreground = foregroundSample.match(/\x1b\[38[^m]*m/)?.[0];
		const panelBackground = foreground?.replace("38", "48") ?? "";
		const restorePanelBackground = (text: string): string =>
			panelBackground ? text.replace(/\x1b\[(?:0|27|49)m/g, (reset) => `${reset}${panelBackground}`) : text;
		const makePanelLine = (content: string): string => {
			const clipped = restorePanelBackground(truncateToWidth(content, panelWidth, ""));
			const padded = clipped + " ".repeat(Math.max(0, panelWidth - visibleWidth(clipped)));
			return panelBackground ? `${panelBackground}${padded}\x1b[49m` : padded;
		};
		const halfBlockLine = (block: "▄" | "▀"): string =>
			foreground ? `${foreground}${block.repeat(panelWidth)}\x1b[39m` : block.repeat(panelWidth);

		result.push(halfBlockLine("▄"));

		if (this.scrollOffset > 0) {
			result.push(makePanelLine(panelColor("dim", ` ↑ ${this.scrollOffset} more`)));
		}
		this.lastVisibleLayoutLines = visibleLines;
		this.lastPaddingX = promptGutter;
		this.lastTextRowStart = result.length;
		const hasSelection = this.getOrderedSelection() !== undefined;
		const isEmpty = this.getText().length === 0;
		const placeholder = meta.modeLabel === "Shell" ? "Run a command..." : "Ask anything...";
		for (let visibleIndex = 0; visibleIndex < visibleLines.length; visibleIndex++) {
			const layoutLine = visibleLines[visibleIndex]!;
			let displayText = this.styleSelectionInLayoutLine(
				layoutLine.text,
				layoutLine.logicalLine,
				layoutLine.startCol,
				layoutLine.endCol,
				layoutLine.cursorPos,
				hasSelection && this.focused && layoutLine.hasCursor,
			);
			let lineWidth = visibleWidth(layoutLine.text);
			if (isEmpty && layoutLine.hasCursor) {
				const marker = this.focused ? CURSOR_MARKER : "";
				displayText = `${marker}\x1b[7m \x1b[27m${panelColor("dim", placeholder)}`;
				lineWidth = 1 + visibleWidth(placeholder);
			} else if (!hasSelection && layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = layoutLine.text.slice(0, layoutLine.cursorPos);
				const after = layoutLine.text.slice(layoutLine.cursorPos);
				const marker = this.focused ? CURSOR_MARKER : "";
				if (after) {
					const grapheme = [...this.segment(after, "grapheme")][0]?.segment ?? "";
					displayText = `${before}${marker}\x1b[7m${grapheme}\x1b[27m${after.slice(grapheme.length)}`;
				} else {
					displayText = `${before}${marker}\x1b[7m \x1b[27m`;
					lineWidth += 1;
				}
			}
			const padding = " ".repeat(Math.max(0, layoutWidth - lineWidth));
			const prompt =
				promptGutter === 0 ? "" : visibleIndex === 0 ? panelColor("border", "❯ ") : " ".repeat(promptGutter);
			result.push(makePanelLine(`${prompt}${displayText}${padding}${" ".repeat(rightPadding)}`));
		}

		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		if (linesBelow > 0) {
			result.push(makePanelLine(panelColor("dim", ` ↓ ${linesBelow} more`)));
		}
		if (this.autocompleteState && this.autocompleteList) {
			for (const line of this.autocompleteList.render(layoutWidth)) {
				const padding = " ".repeat(Math.max(0, layoutWidth - visibleWidth(line)));
				result.push(makePanelLine(`${" ".repeat(promptGutter)}${line}${padding}${" ".repeat(rightPadding)}`));
			}
		}
		result.push(halfBlockLine("▀"));

		const modelStatus = [
			meta.providerLabel || "no-provider",
			meta.modelLabel || "no-model",
			`thinking ${meta.thinkingLabel || "off"}`,
		].join(" · ");
		result.push(
			this.renderSplitLine(
				panelColor("dim", this.renderContextStatus(meta, width)),
				panelColor("dim", modelStatus),
				width,
				"left",
			),
		);
		result.push(
			this.renderSplitLine(
				this.renderCostStatus(meta, width),
				panelColor("dim", (meta.extensionStatuses ?? []).join("  ")),
				width,
			),
		);
		return result;
	}

	private renderMetadataLine(meta: EditorMetadata, width: number): string {
		if (width <= 0) return "";
		const session = meta.sessionName || "no session name";
		const profile = meta.profileName || "no profile loaded";
		const fullRight = `${session}  │  ${profile}`;
		const minimumLeft = Math.min(12, Math.max(1, Math.floor(width / 2)));
		const maximumRight = Math.max(0, width - minimumLeft - 2);
		const right = truncateToWidth(fullRight, maximumRight, "…");
		const gapWidth = right ? 2 : 0;
		const leftWidth = Math.max(0, width - visibleWidth(right) - gapWidth);
		const branch = meta.gitBranch ? ` (${meta.gitBranch})` : "";
		const fullCwd = fitDisplayDirectory(meta.cwd || "~", process.env.HOME || process.env.USERPROFILE, leftWidth);
		const branchBudget =
			visibleWidth(fullCwd) + visibleWidth(branch) <= leftWidth
				? visibleWidth(branch)
				: Math.floor(leftWidth * 0.45);
		const fittedBranch = truncateToWidth(branch, Math.max(0, branchBudget), "…");
		const pathWidth = Math.max(0, leftWidth - visibleWidth(fittedBranch));
		const cwd = fitDisplayDirectory(meta.cwd || "~", process.env.HOME || process.env.USERPROFILE, pathWidth);
		const left = truncateToWidth(`${cwd}${fittedBranch}`, leftWidth, "…");
		const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
		return panelColor("dim", left) + gap + panelColor("dim", right);
	}

	private renderContextStatus(meta: EditorMetadata, width: number): string {
		const contextWindow = Math.max(0, meta.contextWindow ?? 0);
		const contextMax = contextWindow > 0 ? formatTokens(contextWindow) : "?";
		const contextCurrent = meta.contextTokens == null ? "?" : formatTokens(Math.max(0, meta.contextTokens));
		const auto = meta.autoCompactEnabled ? " auto" : "";
		return `${width < 96 ? "ctx" : "context"} ${contextCurrent}/${contextMax}${auto}`;
	}

	private renderCostStatus(meta: EditorMetadata, width: number): string {
		const totalCost = Math.max(0, meta.totalCost ?? 0);
		const totalSubsidy = Math.max(0, meta.totalSubsidy ?? 0);
		const effectiveCost = Math.max(0, meta.effectiveCost ?? totalCost - totalSubsidy);
		const parts =
			width < 96
				? [
						panelColor("muted", `Σ$${totalCost.toFixed(3)}`),
						panelColor("subsidy", `+$${formatAdRouterSubsidy(totalSubsidy)}`),
						panelColor("success", `=$${formatAdRouterSubsidy(effectiveCost)}`),
					]
				: [
						panelColor("muted", `cost $${totalCost.toFixed(3)}`),
						panelColor("subsidy", `subsidy $${formatAdRouterSubsidy(totalSubsidy)}`),
						panelColor("success", `effective $${formatAdRouterSubsidy(effectiveCost)}`),
					];
		return parts.join(" · ");
	}

	private renderSplitLine(left: string, right: string, width: number, priority: "left" | "right" = "right"): string {
		if (width <= 0) return "";
		const bodyWidth = width;
		let leftText: string;
		let rightText: string;
		if (priority === "left") {
			leftText = truncateToWidth(left, bodyWidth, "…");
			const separatorWidth = leftText && right ? 3 : 0;
			const availableRight = Math.max(0, bodyWidth - visibleWidth(leftText) - separatorWidth);
			rightText = truncateToWidth(right, availableRight, "…");
		} else {
			rightText = truncateToWidth(right, bodyWidth, "…");
			const separatorWidth = left && rightText ? 3 : 0;
			const availableLeft = Math.max(0, bodyWidth - visibleWidth(rightText) - separatorWidth);
			leftText = truncateToWidth(left, availableLeft, "…");
		}
		const rightWidth = visibleWidth(rightText);
		const leftWidth = visibleWidth(leftText);
		const gap = Math.max(0, bodyWidth - leftWidth - rightWidth);
		return leftText && rightText
			? `${leftText}${" ".repeat(gap)}${rightText}`
			: leftText
				? `${leftText}${" ".repeat(gap)}`
				: `${" ".repeat(gap)}${rightText}`;
	}

	yieldInputToTranscriptSelection(data: string, context: TranscriptSelectionYieldContext): boolean {
		const selectUp = this.keybindings.matches(data, "tui.editor.selectUp");
		const selectDown = this.keybindings.matches(data, "tui.editor.selectDown");
		const selectLeft = this.keybindings.matches(data, "tui.editor.selectLeft");
		const selectRight = this.keybindings.matches(data, "tui.editor.selectRight");
		if (!selectUp && !selectDown && !selectLeft && !selectRight) return false;
		if (context.historyScrolled) return true;
		return this.getText().length === 0 && (selectUp || selectLeft);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
