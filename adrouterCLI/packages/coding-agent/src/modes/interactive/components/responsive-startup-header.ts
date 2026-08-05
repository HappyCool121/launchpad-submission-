import { type Component, truncateToWidth, visibleWidth } from "@adrouter/tui";
import chalk from "chalk";
import { theme } from "../theme/theme.ts";
import { truncateDisplayDirectory } from "./path-display.ts";

export const STARTUP_ART_MIN_WIDTH = 32;

type StartupColorMode = "truecolor" | "256color";

const JELLYFISH_PALETTE = {
	"0": { hex: [0, 0, 0], ansi256: 16 },
	"1": { hex: [0, 0, 102], ansi256: 17 },
	"2": { hex: [0, 0, 179], ansi256: 19 },
	"3": { hex: [0, 0, 255], ansi256: 21 },
	"4": { hex: [0, 43, 102], ansi256: 17 },
	"5": { hex: [0, 75, 179], ansi256: 25 },
	"6": { hex: [0, 107, 255], ansi256: 27 },
	"7": { hex: [17, 17, 17], ansi256: 233 },
	"8": { hex: [26, 26, 77], ansi256: 17 },
	"9": { hex: [45, 45, 134], ansi256: 18 },
	A: { hex: [77, 77, 255], ansi256: 63 },
	B: { hex: [77, 155, 255], ansi256: 69 },
	C: { hex: [77, 192, 255], ansi256: 75 },
	D: { hex: [153, 202, 255], ansi256: 117 },
	E: { hex: [153, 223, 255], ansi256: 117 },
	F: { hex: [179, 230, 230], ansi256: 152 },
	G: { hex: [238, 238, 238], ansi256: 255 },
	H: { hex: [255, 255, 255], ansi256: 231 },
} as const;

type JellyfishColor = keyof typeof JELLYFISH_PALETTE;

// Exact 30x32 bead sprite from makebead-30x32-2.png
// SHA-256: 28ee5aae83e8dc930510073c389b5e9c22553fbac4b038fb75d2f99d4c7a149a
// Edge-connected source black is represented as transparent dots; enclosed black remains "0".
export const JELLYFISH_PIXELS = [
	"..............................",
	"..............................",
	"..........3333333333..........",
	"..........66666666664.........",
	".......666BBBBBBBBBB666.......",
	".....66BBHHBHBBBBBBBBBB66.....",
	"....766BHHHBBBBBBBBBBBB6652...",
	"....6BBBGHBBBBBBBBBBBBBBB62...",
	"..11ABHHBBBBBBBBBBBBBBBBBAA...",
	"..26BBHHBBBBBBBBBBBBBBBBBBB6..",
	"..56BB6BBC0BBBBBBBBB0BBBBBB6..",
	"..56BBBBBB00BBBBBBB00BBBBBB6..",
	"..566BBBBBB00BBBBB00BBBBBB66..",
	"..266BBBBB07BBBBBBB00BBBBB66..",
	"..25666BBBBBBB0B0BBBBBBB6665..",
	"..2566666BBBBBB0BBBBBB66666...",
	"....566666BBBBBBBBBB6666652...",
	".....55555555555555555555.....",
	"......256B566B65D565BB691.....",
	".......66D666D66D666DD5.......",
	".......66D666D66D666DD6.......",
	".......66D666D66D665DE6.......",
	".......66D666D66D666DE6.......",
	"......6DDF566D66D665FGD6......",
	".....5DDD656DB65BD6566DD5.....",
	".....5BDD656DB65BD6566DB6.....",
	".....5B6656DBB65BBD6526B5.....",
	"......665.66B6..6BB65465......",
	"..........5665..66655.........",
	"..........8558...55...........",
	".................11...........",
	"..............................",
] as const;

const PROMPT_WORDMARK = [
	"████╗",
	"╚████╗",
	" ╚████╗",
	"  ╚████╗",
	"   ╚████╗",
	"    ╚████╗",
	"    ████╔╝",
	"   ████╔╝",
	"  ████╔╝",
	" ████╔╝",
	"████╔╝",
	"╚═══╝",
] as const;

function startupColorCode(color: string, background: boolean, mode: StartupColorMode): string {
	const entry = JELLYFISH_PALETTE[color as JellyfishColor];
	if (!entry) return background ? "\x1b[49m" : "\x1b[39m";
	if (mode === "truecolor") {
		const [r, g, b] = entry.hex;
		return `\x1b[${background ? 48 : 38};2;${r};${g};${b}m`;
	}
	return `\x1b[${background ? 48 : 38};5;${entry.ansi256}m`;
}

function renderMonochromePixel(top: string, bottom: string): string {
	const normalizedTop = top === "0" ? "." : top;
	const normalizedBottom = bottom === "0" ? "." : bottom;
	if (normalizedTop === "." && normalizedBottom === ".") return " ";
	if (normalizedTop === ".") return "▄";
	if (normalizedBottom === ".") return "▀";
	if (/[DEFGH]/.test(normalizedTop) || /[DEFGH]/.test(normalizedBottom)) return "▓";
	return "█";
}

function renderJellyfish(rows: readonly string[]): string[] {
	const colorEnabled = chalk.level > 0 && !process.env.NO_COLOR;
	const mode = theme.getColorMode();
	const output: string[] = [];

	for (let y = 0; y < rows.length; y += 2) {
		const topRow = rows[y];
		if (!topRow) continue;
		const bottomRow = rows[y + 1] ?? ".".repeat(topRow.length);
		let line = "";
		for (let x = 0; x < topRow.length; x++) {
			const top = topRow[x] ?? ".";
			const bottom = bottomRow[x] ?? ".";
			if (!colorEnabled) {
				line += renderMonochromePixel(top, bottom);
				continue;
			}
			if (top === "." && bottom === ".") {
				line += " ";
			} else if (top === bottom) {
				line += `${startupColorCode(top, false, mode)}█`;
			} else if (bottom === ".") {
				line += `${startupColorCode(top, false, mode)}▀`;
			} else if (top === ".") {
				line += `${startupColorCode(bottom, false, mode)}▄`;
			} else {
				line += `${startupColorCode(top, false, mode)}${startupColorCode(bottom, true, mode)}▀\x1b[49m`;
			}
		}
		output.push(colorEnabled ? `${line}\x1b[0m` : line);
	}

	return output;
}

function brandText(text: string, color: JellyfishColor = "B"): string {
	if (chalk.level === 0 || process.env.NO_COLOR) return text;
	return `${startupColorCode(color, false, theme.getColorMode())}${text}\x1b[39m`;
}

const STARTUP_BUBBLE_ROWS: ReadonlyArray<ReadonlyArray<readonly [string, JellyfishColor]>> = [
	[
		["°", "C"],
		["○", "B"],
		[".", "6"],
		["∘", "5"],
	],
	[
		[".", "5"],
		["°", "C"],
		["o", "6"],
		["°", "B"],
	],
	[
		["∘", "B"],
		[".", "5"],
		["°", "C"],
		["○", "B"],
	],
	[
		["o", "6"],
		["°", "C"],
		[".", "5"],
		["∘", "B"],
	],
];

const STARTUP_BUBBLE_GAPS = [
	[5, 3, 6, 4],
	[3, 5, 2, 5],
	[3, 4, 3, 5],
	[4, 6, 2, 5],
] as const;

const STARTUP_BUBBLE_LEADING = [0, 2, 4, 0] as const;

function renderBubbleField(width: number, row: number): string {
	if (width <= 0) return "";
	const gaps = STARTUP_BUBBLE_GAPS[row % STARTUP_BUBBLE_GAPS.length]!;
	const bubbles = STARTUP_BUBBLE_ROWS[row % STARTUP_BUBBLE_ROWS.length]!;
	const leading = Math.min(width, STARTUP_BUBBLE_LEADING[row % STARTUP_BUBBLE_LEADING.length] ?? 0);
	let line = " ".repeat(leading);
	let used = leading;
	let index = 0;

	while (used < width) {
		const [symbol, color] = bubbles[index % bubbles.length]!;
		line += brandText(symbol, color);
		used += 1;
		const gap = gaps[index % gaps.length] ?? 1;
		if (used + gap + 1 > width) break;
		line += " ".repeat(gap);
		used += gap;
		index += 1;
	}

	return padStartupLine(line, width);
}

function padStartupLine(
	line: string,
	width: number,
	alignment: "left" | "center" = "left",
	truncationMarker = "…",
): string {
	const clipped = truncateToWidth(line, width, truncationMarker);
	const gap = Math.max(0, width - visibleWidth(clipped));
	if (alignment === "center") {
		const left = Math.floor(gap / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(gap - left)}`;
	}
	return `${clipped}${" ".repeat(gap)}`;
}

function combineStartupColumns(columns: readonly string[][], gap = 3): string[] {
	const height = Math.max(0, ...columns.map((lines) => lines.length));
	const widths = columns.map((lines) => Math.max(0, ...lines.map((line) => visibleWidth(line))));
	return Array.from({ length: height }, (_, row) =>
		columns
			.map((lines, column) => {
				const line = lines[row] ?? "";
				return column === columns.length - 1 ? line : padStartupLine(line, widths[column] ?? 0);
			})
			.join(" ".repeat(gap)),
	);
}

function centerStartupLines(lines: readonly string[], height: number): string[] {
	const top = Math.max(0, Math.floor((height - lines.length) / 2));
	return [...Array.from({ length: top }, () => ""), ...lines];
}

export interface ResponsiveStartupHeaderOptions {
	version: string;
	expanded?: boolean;
	compactInstructions: string;
	expandedInstructions: string;
	compactOnboarding: string;
	onboarding: string;
	getModelLabel: () => string | undefined;
	getCwdLabel: () => string | undefined;
}

export class ResponsiveStartupHeader implements Component {
	private expanded: boolean;
	private readonly options: ResponsiveStartupHeaderOptions;

	constructor(options: ResponsiveStartupHeaderOptions) {
		this.options = options;
		this.expanded = options.expanded ?? false;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		// Rendering is intentionally derived from current width, theme, and live session metadata.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const innerWidth = Math.max(1, width - 2);
		const banner = width >= STARTUP_ART_MIN_WIDTH ? this.renderWide(innerWidth) : this.renderNarrow(innerWidth);
		const help = this.expanded
			? this.options.expandedInstructions.split("\n")
			: [this.options.compactInstructions, this.options.compactOnboarding];
		const lines = [...banner, "", ...help, "", this.options.onboarding];
		return lines.map(
			(line, index) => ` ${padStartupLine(line, innerWidth, "left", index < banner.length ? "" : "…")} `,
		);
	}

	private renderWide(width: number): string[] {
		const model = this.options.getModelLabel() || "No model selected";
		const cwd = this.options.getCwdLabel() || "~";
		const jellyfish = renderJellyfish(JELLYFISH_PIXELS);
		const wordmark = centerStartupLines(
			PROMPT_WORDMARK.map((line, index) => brandText(line, index < 4 ? "B" : index < 8 ? "6" : "5")),
			jellyfish.length,
		);
		const fixedColumnsWidth =
			Math.max(...jellyfish.map((line) => visibleWidth(line))) +
			Math.max(...wordmark.map((line) => visibleWidth(line))) +
			2;
		const detailsWidth = Math.max(1, width - fixedColumnsWidth);
		const details = centerStartupLines(
			[
				renderBubbleField(detailsWidth, 0),
				renderBubbleField(detailsWidth, 1),
				"",
				theme.bold(brandText("adrouterCLI", "B")),
				theme.fg("dim", `v${this.options.version}`),
				theme.fg("muted", model),
				theme.fg("dim", truncateDisplayDirectory(cwd, detailsWidth)),
				"",
				renderBubbleField(detailsWidth, 2),
				renderBubbleField(detailsWidth, 3),
			],
			jellyfish.length,
		);
		return combineStartupColumns([jellyfish, wordmark, details], 1);
	}

	private renderNarrow(width: number): string[] {
		const model = theme.fg("muted", truncateToWidth(this.options.getModelLabel() || "No model selected", width, "…"));
		const cwd = theme.fg("dim", truncateDisplayDirectory(this.options.getCwdLabel() || "~", width));
		return [theme.bold(brandText(`> adrouterCLI v${this.options.version}`, "B")), model, cwd];
	}
}
