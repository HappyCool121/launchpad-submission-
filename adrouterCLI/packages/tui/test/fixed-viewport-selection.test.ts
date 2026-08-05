import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, type TranscriptSelectionYieldContext, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class SelectableLines extends Lines {
	events: string[] = [];
	beginMouseSelection(row: number, col: number): boolean {
		this.events.push(`begin:${row}:${col}`);
		return true;
	}
	updateMouseSelection(row: number, col: number): boolean {
		this.events.push(`update:${row}:${col}`);
		return true;
	}
	endMouseSelection(row: number, col: number): boolean {
		this.events.push(`end:${row}:${col}`);
		return true;
	}
	clearSelection(): boolean {
		return false;
	}
}

class KeyboardSelectableLines extends Lines {
	inputText = "";
	inputSelection = "preserved";
	inputs: string[] = [];

	yieldInputToTranscriptSelection(data: string, context: TranscriptSelectionYieldContext): boolean {
		const direction = data.match(/^\x1b\[1;2([ABCD])$/)?.[1];
		if (!direction) return false;
		if (context.historyScrolled) return true;
		return this.inputText.length === 0 && (direction === "A" || direction === "D");
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

class ClipboardTerminal extends VirtualTerminal {
	clipboardWrites: string[] = [];

	override write(data: string): void {
		if (data.startsWith("\x1b]52;c;")) this.clipboardWrites.push(data);
		super.write(data);
	}
}

function decodeClipboardWrite(value: string): string {
	const payload = value.slice("\x1b]52;c;".length, -1);
	return Buffer.from(payload, "base64").toString("utf8");
}

describe("fixed transcript viewport", () => {
	it("anchors the fixed section and scrolls only session history", () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(Array.from({ length: 8 }, (_, index) => `history-${index}`));
		const fixed = new Lines(["ad", "editor"]);
		tui.addChild(transcript);
		tui.addChild(fixed);
		tui.setBottomAnchorStart(fixed);

		assert.deepStrictEqual(tui.render(20), ["history-4", "history-5", "history-6", "history-7", "ad", "editor"]);
		tui.scrollTranscriptPage(1);
		assert.deepStrictEqual(tui.render(20), ["history-1", "history-2", "history-3", "history-4", "ad", "editor"]);
	});

	it("routes mouse drag coordinates into a selectable fixed editor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(["one", "two", "three", "four"]);
		const editor = new SelectableLines(["prompt", "status"]);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;5M");
		terminal.sendInput("\x1b[<32;4;6M");
		terminal.sendInput("\x1b[<0;4;6m");

		assert.deepStrictEqual(editor.events, ["begin:0:1", "update:1:3", "end:1:3"]);
		tui.stop();
	});

	it("lets an input listener consume PageUp before transcript scrolling", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(Array.from({ length: 8 }, (_, index) => `history-${index}`));
		const fixed = new Lines(["ad", "editor"]);
		tui.addChild(transcript);
		tui.addChild(fixed);
		tui.setBottomAnchorStart(fixed);
		tui.addInputListener(() => ({ consume: true }));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[5~");

		assert.deepStrictEqual(tui.render(20), ["history-4", "history-5", "history-6", "history-7", "ad", "editor"]);
		tui.stop();
	});

	it("starts keyboard selection at the latest transcript line and copies ANSI emoji text", async () => {
		const terminal = new ClipboardTerminal(30, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(["first", "\x1b[31mlast😀\x1b[0m"]);
		const editor = new KeyboardSelectableLines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;2D");
		terminal.sendInput("\x03");

		assert.strictEqual(terminal.clipboardWrites.length, 1);
		assert.strictEqual(decodeClipboardWrite(terminal.clipboardWrites[0]!), "😀");
		assert.deepStrictEqual(editor.inputs, []);
		tui.stop();
	});

	it("crosses transcript line boundaries with Shift+Left", async () => {
		const terminal = new ClipboardTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(["ab", "cd"]);
		const editor = new KeyboardSelectableLines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		for (let i = 0; i < 4; i++) terminal.sendInput("\x1b[1;2D");
		terminal.sendInput("\x03");

		assert.strictEqual(decodeClipboardWrite(terminal.clipboardWrites[0]!), "b\ncd");
		tui.stop();
	});

	it("preserves the display column and autoscrolls while extending upward", async () => {
		const terminal = new ClipboardTerminal(20, 5);
		const tui = new TUI(terminal);
		const transcript = new Lines(["0", "123456789", "22", "333333333", "4444", "555555555", "666666", "777777777"]);
		const editor = new KeyboardSelectableLines(["ad", "editor"]);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		for (let i = 0; i < 4; i++) terminal.sendInput("\x1b[1;2A");
		const selection = (
			tui as unknown as {
				transcriptSelection?: { focus: { line: number; col: number }; goalCol?: number };
			}
		).transcriptSelection;
		assert.deepStrictEqual(selection?.focus, { line: 3, col: 9 });
		assert.strictEqual(selection?.goalCol, 9);
		assert.ok(tui.render(20).some((line) => line.includes("333333333")));
		tui.stop();
	});

	it("uses transcript selection after PageUp even when the editor has text", async () => {
		const terminal = new ClipboardTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(Array.from({ length: 8 }, (_, index) => `history-${index}`));
		const editor = new KeyboardSelectableLines(["editor"]);
		editor.inputText = "draft";
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[1;2C");

		const selection = (tui as unknown as { transcriptSelection?: unknown }).transcriptSelection;
		assert.ok(selection);
		assert.deepStrictEqual(editor.inputs, []);
		assert.strictEqual(editor.inputSelection, "preserved");
		tui.stop();
	});

	it("leaves an active editor selection and overlays isolated", async () => {
		const terminal = new ClipboardTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(["history"]);
		const editor = new KeyboardSelectableLines(["editor"]);
		editor.inputText = "draft";
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;2D");
		assert.deepStrictEqual(editor.inputs, ["\x1b[1;2D"]);
		assert.strictEqual(editor.inputSelection, "preserved");

		const overlay = new KeyboardSelectableLines(["overlay"]);
		tui.showOverlay(overlay, { width: 10 });
		terminal.sendInput("\x1b[1;2D");
		assert.deepStrictEqual(overlay.inputs, ["\x1b[1;2D"]);
		assert.strictEqual((tui as unknown as { transcriptSelection?: unknown }).transcriptSelection, undefined);
		tui.stop();
	});

	it("clears keyboard transcript selection with Escape", async () => {
		const terminal = new ClipboardTerminal(20, 6);
		const tui = new TUI(terminal);
		const transcript = new Lines(["history"]);
		const editor = new KeyboardSelectableLines(["editor"]);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setBottomAnchorStart(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[1;2D");
		terminal.sendInput("\x1b");
		assert.strictEqual((tui as unknown as { transcriptSelection?: unknown }).transcriptSelection, undefined);
		terminal.sendInput("\x03");
		assert.strictEqual(terminal.clipboardWrites.length, 0);
		assert.deepStrictEqual(editor.inputs, ["\x03"]);
		tui.stop();
	});
});
