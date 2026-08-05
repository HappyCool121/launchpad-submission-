/**
 * /btw — Interactive side channel for AdRouterCLI.
 *
 * Starts a temporary fork of the current session, renders that fork in a
 * fixed panel above the editor, and routes editor submissions to the fork
 * while the panel is open. The main conversation history/context is not
 * modified. The temporary fork is deleted when the panel is dismissed.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@adrouter/cli";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@adrouter/tui";

// ── Constants ────────────────────────────────────────────────────────────────

const BTW_WIDGET_KEY = "btw-panel";
const TOKEN_REFRESH_MS = 500;
const BTW_WHEEL_LINES = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_TOOL_OUTPUT_CHARS = 1800;

type Point = { line: number; col: number };
type Selection = { anchor: Point; focus: Point; dragging: boolean };
type BtwTui = {
  requestRender(): void;
  bottomVisibleLines?: string[];
  bottomViewportStartRow?: number;
  setSelectionAttention?: (scope: string | null, options?: { exceptComponent?: unknown }) => void;
  terminal?: { columns?: number; rows?: number; write?(data: string): void };
};
type TranscriptEntry = {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  pending?: boolean;
};

type RpcRequest = Record<string, unknown> & { id?: string; type: string };

type RpcClient = {
  send(request: RpcRequest): void;
  prompt(message: string, busy: boolean): void;
  requestStats(): void;
  shutdown(): void;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_G[^\x1b]*(?:\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Sanitize raw LLM output: strip DSML/tool-call markup, collapse whitespace,
 * and detect cases where the model tried (and failed) to emit invalid markup.
 */
function sanitizeBtwOutput(raw: string): string {
  let text = stripAnsi(raw || "").replace(/\r\n/g, "\n");
  const hadToolMarkup = /[|｜]{2}DSML[|｜]{2}|tool_calls>|<tool_call|function_call/i.test(text);
  const dsml = "[|｜]{2}DSML[|｜]{2}";

  text = text.replace(new RegExp(`<${dsml}tool_calls>[\\s\\S]*?</${dsml}tool_calls>`, "g"), "");
  text = text.replace(new RegExp(`<${dsml}invoke\\b[^>]*>[\\s\\S]*?</${dsml}invoke>`, "g"), "");
  text = text.replace(new RegExp(`<${dsml}parameter\\b[^>]*>[\\s\\S]*?</${dsml}parameter>`, "g"), "");
  // Also hide partial/truncated DSML blocks while streaming so raw tool-call
  // markup never flashes into the panel before a closing tag arrives.
  text = text.replace(new RegExp(`<${dsml}(?:tool_calls|invoke|parameter)\\b[\\s\\S]*$`, "g"), "");
  text = text.replace(new RegExp(`</?${dsml}[^>]*>`, "g"), "");

  const cleanedLines = text
    .split("\n")
    .filter((line) => !/[|｜]{2}DSML[|｜]{2}|tool_calls>|<tool_call|function_call/i.test(line))
    .join("\n");

  const cleaned = cleanedLines.replace(/\n{3,}/g, "\n\n").trimEnd();
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  if (
    hadToolMarkup &&
    /^(let me|i(?:'|’)ll|i will)\b.{0,160}\b(check|look|inspect|verify)\b/i.test(normalized)
  ) {
    return "I couldn't answer cleanly; the model emitted tool-call markup instead of a response.";
  }

  return cleaned;
}

function fitToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width));
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function sliceVisible(text: string, startCol: number, endCol: number): string {
  const start = Math.max(0, startCol);
  const end = Math.max(start, endCol);
  let col = 0;
  let out = "";

  for (const char of text) {
    const charWidth = Math.max(0, visibleWidth(char));
    const next = col + charWidth;
    if (next > start && col < end && col >= start && next <= end) out += char;
    col = next;
    if (col >= end) break;
  }

  return out;
}

function copyToClipboard(text: string, tui?: BtwTui) {
  const payload = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  if (tui?.terminal?.write) tui.terminal.write(payload);
  else process.stdout.write(payload);
}

function wrapLines(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    let remaining = paragraph;
    while (visibleWidth(remaining) > width) {
      let cut = Math.min(remaining.length, width);
      while (cut > 1 && visibleWidth(remaining.slice(0, cut)) > width) cut--;

      const candidate = remaining.slice(0, cut);
      const spaceIdx = candidate.lastIndexOf(" ");
      if (spaceIdx > Math.floor(candidate.length / 2)) cut = spaceIdx;

      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    lines.push(remaining);
  }

  return lines.length > 0 ? lines : [""];
}

function borderedPanel(title: string, rightLabel: string, body: string[], width: number): string[] {
  const contentWidth = Math.max(20, width - 4);
  const topInnerWidth = contentWidth + 2;
  const rawRight = rightLabel ? ` ${rightLabel} ` : "";
  const safeRight = truncateToWidth(rawRight, topInnerWidth);
  const titleWidth = Math.max(0, topInnerWidth - visibleWidth(safeRight));
  const safeTitle = truncateToWidth(` ${title} `, titleWidth);
  const topFill = "─".repeat(
    Math.max(0, topInnerWidth - visibleWidth(safeTitle) - visibleWidth(safeRight)),
  );

  const lines = [`╭${safeTitle}${topFill}${safeRight}╮`];
  for (const line of body) lines.push(`│ ${fitToWidth(line, contentWidth)} │`);
  lines.push(`╰${"─".repeat(contentWidth + 2)}╯`);
  return lines;
}

type ThemeLike = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
  italic?: (text: string) => string;
  underline?: (text: string) => string;
};

function ansi(code: string, reset: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[${reset}m`;
}

function markdownTheme(theme?: ThemeLike) {
  const fg = (color: string, text: string) => (theme?.fg ? theme.fg(color, text) : text);
  return {
    heading: (text: string) => fg("mdHeading", text),
    link: (text: string) => fg("mdLink", text),
    linkUrl: (text: string) => fg("mdLinkUrl", text),
    code: (text: string) => fg("mdCode", text),
    codeBlock: (text: string) => fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => fg("mdCodeBlockBorder", text),
    quote: (text: string) => fg("mdQuote", text),
    quoteBorder: (text: string) => fg("mdQuoteBorder", text),
    hr: (text: string) => fg("mdHr", text),
    listBullet: (text: string) => fg("mdListBullet", text),
    bold: (text: string) => (theme?.bold ? theme.bold(text) : ansi("1", "22", text)),
    italic: (text: string) => (theme?.italic ? theme.italic(text) : ansi("3", "23", text)),
    underline: (text: string) => (theme?.underline ? theme.underline(text) : ansi("4", "24", text)),
    strikethrough: (text: string) => ansi("9", "29", text),
    highlightCode: (code: string) => code.split("\n").map((line) => fg("mdCodeBlock", line)),
  };
}

function renderMarkdownLines(text: string, width: number, theme?: ThemeLike): string[] {
  const safeWidth = Math.max(1, width);
  try {
    const lines = new Markdown(text || " ", 0, 0, markdownTheme(theme)).render(safeWidth);
    return (lines.length > 0 ? lines : [""]).map((line) => fitToWidth(line, safeWidth));
  } catch {
    return wrapLines(stripAnsi(text || ""), safeWidth).map((line) => fitToWidth(line, safeWidth));
  }
}

function orderedSelection(selection: Selection | null, maxLine: number, maxCol: number) {
  if (!selection) return null;
  const clamp = (point: Point): Point => ({
    line: Math.max(0, Math.min(maxLine, Math.trunc(point.line))),
    col: Math.max(0, Math.min(maxCol, Math.trunc(point.col))),
  });
  const anchor = clamp(selection.anchor);
  const focus = clamp(selection.focus);
  if (anchor.line < focus.line || (anchor.line === focus.line && anchor.col <= focus.col)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

function highlightSelection(lines: string[], selection: Selection | null, maxCol: number): string[] {
  const ordered = orderedSelection(selection, Math.max(0, lines.length - 1), maxCol);
  if (!ordered) return lines;

  const result = [...lines];
  for (let lineNo = 0; lineNo < result.length; lineNo++) {
    if (lineNo < ordered.start.line || lineNo > ordered.end.line) continue;
    // Selection operates on terminal cells, not ANSI bytes. Markdown-rendered
    // lines contain styling escapes, so slice from the plain visible text to
    // avoid splitting escape sequences and corrupting subsequent rendering.
    const line = stripAnsi(result[lineNo] ?? "");
    const width = Math.max(visibleWidth(line), maxCol);
    const startCol = lineNo === ordered.start.line ? ordered.start.col : 0;
    const endCol = lineNo === ordered.end.line ? ordered.end.col : width;
    if (endCol <= startCol) continue;

    const before = sliceVisible(line, 0, startCol);
    const selected = sliceVisible(line, startCol, endCol);
    const after = sliceVisible(line, endCol, width);
    result[lineNo] = `${before}\x1b[7m${selected}\x1b[27m${after}`;
  }

  return result;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const maybe = part as { type?: unknown; text?: unknown };
      return maybe.type === "text" && typeof maybe.text === "string" ? maybe.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.path === "string") return obj.path;
  try {
    return JSON.stringify(obj);
  } catch {
    return String(args);
  }
}

function formatToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const text = textFromContent((result as { content?: unknown }).content);
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (${text.length - MAX_TOOL_OUTPUT_CHARS} chars truncated in /btw view)`;
}

function makeRpcClient(options: {
  sessionFile: string;
  tempDir: string;
  cwd: string;
  onEvent(event: any): void;
  onError(message: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}): RpcClient {
  let child: ChildProcessWithoutNullStreams | undefined;
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;

  const args = [
    "--fork",
    options.sessionFile,
    "--session-dir",
    options.tempDir,
    "--mode",
    "rpc",
    "--tools",
    "read,bash",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt",
    [
      "You are the assistant for an interactive /btw side panel.",
      "Answer the user's side questions without modifying the main AdRouterCLI conversation.",
      "You may use only the read and bash tools when useful.",
      "Prefer concise answers, but use files/commands when needed to answer questions outside the current conversation context.",
      "Never emit raw function-call, tool-call, XML, or DSML markup in assistant text.",
    ].join("\n"),
  ];

  child = spawn("adrouter", args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      options.onEvent(JSON.parse(trimmed));
    } catch {
      options.onError(trimmed);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let idx = stdoutBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      handleLine(line);
      idx = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    let idx = stderrBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = stderrBuffer.slice(0, idx).trim();
      stderrBuffer = stderrBuffer.slice(idx + 1);
      if (line) options.onError(line);
      idx = stderrBuffer.indexOf("\n");
    }
  });

  child.on("error", (err) => options.onError(err.message));
  child.on("exit", (code, signal) => {
    closed = true;
    const remainingStdout = stdoutBuffer.trim();
    const remainingStderr = stderrBuffer.trim();
    if (remainingStdout) handleLine(remainingStdout);
    if (remainingStderr) options.onError(remainingStderr);
    options.onExit(code, signal);
  });

  const send = (request: RpcRequest) => {
    if (closed || !child || child.killed || !child.stdin.writable) return;
    const payload = { ...request, id: request.id ?? `btw-${nextId++}` };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    send,
    prompt(message: string, busy: boolean) {
      send({ type: busy ? "follow_up" : "prompt", message });
    },
    requestStats() {
      send({ type: "get_session_stats" });
    },
    shutdown() {
      closed = true;
      try {
        child?.stdin.end();
      } catch {
        /* ignore */
      }
      if (child && !child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !child.killed) child.kill("SIGKILL");
        }, 750).unref();
      }
    },
  };
}

// ── Extension Entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Open an interactive temporary side session without changing the main conversation",
    argumentHint: "<question>",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "error");
        return;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/btw requires a persisted session (ephemeral sessions not supported)", "error");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw is only available in interactive mode", "error");
        return;
      }

      // ── Panel State ──────────────────────────────────────────────────────

      let closed = false;
      let loading = true;
      let busy = false;
      let scrollOffset = 0;
      let lastMaxOffset = 0;
      let lastPageSize = 5;
      let fixedPanelLines: number | undefined;
      let autoScroll = true;
      let spinIdx = 0;
      let tokenLabel = "… tokens";
      let selection: Selection | null = null;
      let lastPanelLines: string[] = [];
      let flattenedLines: string[] = [];
      let activeAssistantIndex: number | null = null;
      const toolLineById = new Map<string, number>();
      let spinTimer: ReturnType<typeof setTimeout> | null = null;
      let statsTimer: ReturnType<typeof setInterval> | null = null;
      let tuiRef: BtwTui | undefined;
      let rpc: RpcClient | undefined;
      let unsubscribeInput: (() => void) | undefined;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adrouter-btw-"));
      const transcript: TranscriptEntry[] = [
        {
          role: "system",
          text: "Temporary /btw session started. Tools enabled: read, bash. Type in the editor and press Enter to send. Press Esc to close.",
        },
      ];

      const requestRender = () => {
        if (!closed) tuiRef?.requestRender();
      };

      const cleanupTempDir = () => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      };

      const clearSelection = () => {
        if (!selection) {
          tuiRef?.setSelectionAttention?.(null);
          return false;
        }
        selection = null;
        tuiRef?.setSelectionAttention?.(null);
        requestRender();
        return true;
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (spinTimer) {
          clearTimeout(spinTimer);
          spinTimer = null;
        }
        if (statsTimer) {
          clearInterval(statsTimer);
          statsTimer = null;
        }
        unsubscribeInput?.();
        rpc?.shutdown();
        cleanupTempDir();
        tuiRef?.setSelectionAttention?.(null);
        ctx.ui.setWidget(BTW_WIDGET_KEY, undefined);
        ctx.ui.setStatus("btw", undefined);
      };

      const scheduleSpin = () => {
        if (closed || spinTimer) return;
        spinTimer = setTimeout(() => {
          spinTimer = null;
          if (loading || busy) spinIdx = (spinIdx + 1) % SPINNER_FRAMES.length;
          requestRender();
          scheduleSpin();
        }, 80);
      };

      const appendEntry = (entry: TranscriptEntry) => {
        transcript.push(entry);
        if (autoScroll) scrollOffset = lastMaxOffset;
        requestRender();
      };

      const scrollPanel = (delta: number) => {
        if (delta === 0) return;
        const next = Math.max(0, Math.min(lastMaxOffset, scrollOffset + delta));
        if (next === scrollOffset) return;
        selection = null;
        tuiRef?.setSelectionAttention?.(null);
        scrollOffset = next;
        autoScroll = scrollOffset >= lastMaxOffset;
        requestRender();
      };

      const copySelection = () => {
        const maxCol = tuiRef?.terminal?.columns ?? process.stdout.columns ?? 80;
        const ordered = orderedSelection(selection, Math.max(0, lastPanelLines.length - 1), maxCol);
        if (!ordered) return false;

        const parts: string[] = [];
        for (let lineNo = ordered.start.line; lineNo <= ordered.end.line; lineNo++) {
          const line = stripAnsi(lastPanelLines[lineNo] ?? "");
          const width = Math.max(visibleWidth(line), maxCol);
          const startCol = lineNo === ordered.start.line ? ordered.start.col : 0;
          const endCol = lineNo === ordered.end.line ? ordered.end.col : width;
          parts.push(endCol <= startCol ? "" : sliceVisible(line, startCol, endCol).replace(/\s+$/g, ""));
        }

        const text = parts.join("\n");
        selection = null;
        tuiRef?.setSelectionAttention?.(null);
        requestRender();
        if (!text) return false;
        copyToClipboard(text, tuiRef);
        return true;
      };

      const normalizePanelMatchLine = (line: string) => stripAnsi(line ?? "").replace(/\s+$/g, "");

      const isPanelMatchSeed = (line: string) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !/^│\s*│$/.test(line);
      };

      const findPanelStartRow = () => {
        const bottomLines = tuiRef?.bottomVisibleLines ?? [];
        const bottomStart = tuiRef?.bottomViewportStartRow ?? 0;
        if (bottomLines.length === 0 || lastPanelLines.length === 0) return null;

        const visible = bottomLines.map(normalizePanelMatchLine);
        const panel = lastPanelLines.map(normalizePanelMatchLine);
        let best: { visibleIndex: number; panelIndex: number; length: number } | null = null;

        for (let visibleIndex = 0; visibleIndex < visible.length; visibleIndex++) {
          for (let panelIndex = 0; panelIndex < panel.length; panelIndex++) {
            if (visible[visibleIndex] !== panel[panelIndex] || !isPanelMatchSeed(panel[panelIndex] ?? "")) continue;

            let length = 1;
            while (
              visibleIndex + length < visible.length &&
              panelIndex + length < panel.length &&
              visible[visibleIndex + length] === panel[panelIndex + length]
            ) {
              length++;
            }

            if (!best || length > best.length) best = { visibleIndex, panelIndex, length };
          }
        }

        return best ? bottomStart + best.visibleIndex - best.panelIndex : null;
      };

      const panelPointForScreen = (row: number, col: number, clamp = false): Point | null => {
        const startRow = findPanelStartRow();
        if (startRow === null || lastPanelLines.length === 0) return null;
        const relativeLine = row - startRow;
        if (!clamp && (relativeLine < 0 || relativeLine >= lastPanelLines.length)) return null;
        const maxCol = tuiRef?.terminal?.columns ?? process.stdout.columns ?? 80;
        return {
          line: Math.max(0, Math.min(lastPanelLines.length - 1, relativeLine)),
          col: Math.max(0, Math.min(maxCol, col)),
        };
      };

      const handleMouse = (data: string) => {
        const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
        if (!match) return false;

        const code = Number.parseInt(match[1]!, 10);
        const col = Number.parseInt(match[2]!, 10) - 1;
        const row = Number.parseInt(match[3]!, 10) - 1;
        const suffix = match[4]!;
        const button = code & 3;
        const isMotion = (code & 32) === 32;
        const isWheel = (code & 64) === 64;

        if (isWheel) {
          // Match the main session-history mouse-wheel behavior: only plain
          // SGR wheel-up/wheel-down events scroll, in 3-line chunks. Other
          // wheel variants (modifier/motion bits) are consumed but ignored so
          // high-resolution trackpads do not double-scroll or feel jittery.
          if (code === 64) scrollPanel(-BTW_WHEEL_LINES);
          else if (code === 65) scrollPanel(BTW_WHEEL_LINES);
          return true;
        }

        const panelStartRow = findPanelStartRow();
        const panelEndRow = panelStartRow === null ? null : panelStartRow + lastPanelLines.length - 1;
        const isBelowPanel = panelEndRow !== null && row > panelEndRow;

        if (suffix === "M" && button === 0 && !isMotion) {
          const point = panelPointForScreen(row, col);
          if (point) {
            selection = { anchor: point, focus: point, dragging: true };
            tuiRef?.setSelectionAttention?.("external");
            requestRender();
            return true;
          }

          selection = null;
          tuiRef?.setSelectionAttention?.(null);
          requestRender();
          return isBelowPanel ? false : true;
        }

        if (suffix === "M" && isMotion && selection?.dragging) {
          const point = panelPointForScreen(row, col, true);
          if (point) selection.focus = point;
          requestRender();
          return true;
        }

        if (suffix === "M" && isMotion && !selection?.dragging && isBelowPanel) {
          return false;
        }

        if (suffix === "m" && selection?.dragging) {
          const point = panelPointForScreen(row, col, true);
          if (point) selection.focus = point;
          selection.dragging = false;
          requestRender();
          return true;
        }

        if (suffix === "m" && !selection?.dragging && isBelowPanel) {
          return false;
        }

        // Consume other mouse events above/inside the panel so clicking/selection
        // cannot target the main session history while /btw is active. Let events
        // below the panel pass through to the editor.
        return isBelowPanel ? false : true;
      };

      const submitEditorText = () => {
        const text = ctx.ui.getEditorText().trim();
        ctx.ui.setEditorText("");
        clearSelection();
        if (!text) return;

        const wasBusy = busy;
        appendEntry({ role: "user", text: wasBusy ? `${text}\n(queued; will send after the current /btw turn)` : text });
        if (!wasBusy) {
          activeAssistantIndex = transcript.length;
          appendEntry({ role: "assistant", text: "", pending: true });
        }
        busy = true;
        loading = false;
        ctx.ui.setStatus("btw", `${SPINNER_FRAMES[spinIdx]} BTW running`);
        rpc?.prompt(text, wasBusy);
        requestRender();
      };

      const setActiveAssistantText = (text: string, append = false) => {
        if (activeAssistantIndex === null || !transcript[activeAssistantIndex]) {
          activeAssistantIndex = transcript.length;
          transcript.push({ role: "assistant", text: "", pending: true });
        }
        const entry = transcript[activeAssistantIndex]!;
        entry.text = sanitizeBtwOutput(append ? `${entry.text}${stripAnsi(text)}` : text);
        entry.pending = true;
        if (autoScroll) scrollOffset = lastMaxOffset;
        requestRender();
      };

      const finishAssistant = (message?: any) => {
        if (message?.content && activeAssistantIndex !== null && transcript[activeAssistantIndex]) {
          const finalText = sanitizeBtwOutput(textFromContent(message.content));
          if (finalText) transcript[activeAssistantIndex]!.text = finalText;
        }
        if (activeAssistantIndex !== null && transcript[activeAssistantIndex]) {
          transcript[activeAssistantIndex]!.pending = false;
          if (!transcript[activeAssistantIndex]!.text.trim()) {
            transcript[activeAssistantIndex]!.text = "No answer returned.";
          }
        }
        activeAssistantIndex = null;
        requestRender();
      };

      const handleRpcEvent = (event: any) => {
        if (closed || !event || typeof event !== "object") return;

        if (event.type === "response") {
          if (event.command === "get_session_stats" && event.success && event.data) {
            const tokens = event.data.contextUsage?.tokens ?? event.data.tokens?.total;
            tokenLabel = typeof tokens === "number" ? `${Math.round(tokens).toLocaleString()} tokens` : tokenLabel;
            requestRender();
          } else if (!event.success && event.error) {
            appendEntry({ role: "system", text: `RPC error: ${event.error}` });
          }
          return;
        }

        switch (event.type) {
          case "agent_start":
          case "turn_start":
            busy = true;
            loading = false;
            ctx.ui.setStatus("btw", `${SPINNER_FRAMES[spinIdx]} BTW running`);
            requestRender();
            break;

          case "message_start":
            if (event.message?.role === "assistant") setActiveAssistantText("", false);
            break;

          case "message_update": {
            const delta = event.assistantMessageEvent;
            if (!delta || typeof delta !== "object") break;
            if (delta.type === "text_delta" && typeof delta.delta === "string") {
              setActiveAssistantText(delta.delta, true);
            } else if (delta.type === "text_end" && typeof delta.content === "string") {
              setActiveAssistantText(delta.content, false);
            } else if (delta.type === "toolcall_end" && delta.toolCall) {
              const toolCall = delta.toolCall as { name?: string; input?: unknown; args?: unknown };
              appendEntry({
                role: "tool",
                text: `↳ ${toolCall.name ?? "tool"}: ${summarizeArgs(toolCall.input ?? toolCall.args)}`,
              });
            } else if (delta.type === "error") {
              appendEntry({ role: "system", text: `Error: ${delta.error ?? delta.reason ?? "unknown"}` });
            }
            break;
          }

          case "tool_execution_start": {
            const lineIndex = transcript.length;
            toolLineById.set(String(event.toolCallId), lineIndex);
            appendEntry({ role: "tool", text: `⧉ ${event.toolName}: ${summarizeArgs(event.args)}`, pending: true });
            break;
          }

          case "tool_execution_update": {
            const lineIndex = toolLineById.get(String(event.toolCallId));
            if (lineIndex !== undefined && transcript[lineIndex]) {
              const output = formatToolResult(event.partialResult);
              transcript[lineIndex]!.text = `⧉ ${event.toolName}: ${summarizeArgs(event.args)}${output ? `\n${output}` : ""}`;
              transcript[lineIndex]!.pending = true;
              requestRender();
            }
            break;
          }

          case "tool_execution_end": {
            const lineIndex = toolLineById.get(String(event.toolCallId));
            if (lineIndex !== undefined && transcript[lineIndex]) {
              const output = formatToolResult(event.result);
              transcript[lineIndex]!.text = `✓ ${event.toolName}${event.isError ? " failed" : ""}${output ? `\n${output}` : ""}`;
              transcript[lineIndex]!.pending = false;
              requestRender();
            }
            break;
          }

          case "turn_end":
            finishAssistant(event.message);
            break;

          case "agent_end":
            busy = false;
            loading = false;
            finishAssistant();
            ctx.ui.setStatus("btw", "BTW ready");
            rpc?.requestStats();
            requestRender();
            break;

          case "auto_retry_start":
            appendEntry({ role: "system", text: `Retrying after error: ${event.errorMessage ?? "unknown error"}` });
            break;

          case "compaction_start":
            appendEntry({ role: "system", text: "Compacting temporary /btw context…", pending: true });
            break;

          case "compaction_end":
            appendEntry({ role: "system", text: event.aborted ? "Compaction aborted." : "Compaction complete." });
            break;
        }
      };

      const handleRpcError = (message: string) => {
        if (closed) return;
        if (/^\s*$/.test(message)) return;
        appendEntry({ role: "system", text: `stderr: ${stripAnsi(message)}` });
      };

      // ── Keyboard + Mouse Input Handler ───────────────────────────────────

      const handlePanelInput = (data: string) => {
        if (closed) return { consume: false };

        // Let terminal cell-size replies continue to TUI internals.
        if (/^\x1b\[6;\d+;\d+t$/.test(data)) return { consume: false };

        if (handleMouse(data)) return { consume: true };

        if (selection) {
          if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.super("c"))) {
            copySelection();
            return { consume: true };
          }
          if (matchesKey(data, Key.escape)) {
            clearSelection();
            return { consume: true };
          }
          clearSelection();
        }

        // Escape dismisses /btw and returns to the main session. Enter submits
        // the current editor contents to the temporary /btw session.
        if (matchesKey(data, Key.escape)) {
          close();
          return { consume: true };
        }
        if (matchesKey(data, Key.enter)) {
          submitEditorText();
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("c"))) {
          // Match the normal editor clear binding while /btw is active, without
          // letting repeated Ctrl-C exit the parent Pi session. Esc still closes
          // the /btw panel.
          ctx.ui.setEditorText("");
          clearSelection();
          return { consume: true };
        }

        // Do not consume normal typing or Up/Down arrows: the editor keeps its
        // normal editing and message-history behavior while /btw is active.
        return { consume: false };
      };

      unsubscribeInput = ctx.ui.onTerminalInput(handlePanelInput);

      // ── Widget Registration ──────────────────────────────────────────────

      ctx.ui.setWidget(BTW_WIDGET_KEY, (tui, theme) => {
        tuiRef = tui as BtwTui;
        scheduleSpin();
        return {
          invalidate() {},
          dispose() {
            if (spinTimer) {
              clearTimeout(spinTimer);
              spinTimer = null;
            }
            if (statsTimer) {
              clearInterval(statsTimer);
              statsTimer = null;
            }
          },
          render(width: number): string[] {
            const panelWidth = Math.max(24, width);
            const contentWidth = Math.max(20, panelWidth - 4);
            // Fill almost all space above the editor so the /btw transcript takes
            // the place of the main session history while retaining the same border.
            // The panel is pinned at its first maximum height and padded on every
            // render; streaming text/tool output can no longer make the panel grow
            // or shrink and corrupt surrounding TUI borders while the user scrolls.
            const terminalRows = tuiRef?.terminal?.rows ?? process.stdout.rows ?? 40;
            const maxEditorTextLines = Math.max(5, Math.floor(terminalRows * 0.3));
            const editorReserveLines = Math.max(7, maxEditorTextLines + 4);
            const availablePanelLines = Math.max(8, terminalRows - editorReserveLines);
            fixedPanelLines ??= availablePanelLines;
            const maxPanelLines = Math.min(fixedPanelLines, availablePanelLines);
            const maxBodyLines = Math.max(4, maxPanelLines - 2);
            const title = `BTW: ${question}`;

            flattenedLines = [];
            for (const entry of transcript) {
              const icon =
                entry.role === "user"
                  ? "You"
                  : entry.role === "assistant"
                    ? entry.pending
                      ? `${SPINNER_FRAMES[spinIdx]} BTW`
                      : "BTW"
                    : entry.role === "tool"
                      ? "tool"
                      : "note";
              const prefix = `${icon}: `;
              const prefixWidth = visibleWidth(prefix);
              const rendered = renderMarkdownLines(
                entry.text || (entry.pending ? "Thinking…" : ""),
                Math.max(1, contentWidth - prefixWidth),
                theme as ThemeLike,
              );
              rendered.forEach((line, index) => {
                flattenedLines.push(
                  index === 0
                    ? `${prefix}${fitToWidth(line, contentWidth - prefixWidth)}`
                    : `${" ".repeat(prefixWidth)}${fitToWidth(line, contentWidth - prefixWidth)}`,
                );
              });
              flattenedLines.push("");
            }

            if (flattenedLines.length > 0 && flattenedLines[flattenedLines.length - 1] === "") flattenedLines.pop();
            if (flattenedLines.length === 0) flattenedLines.push("Starting temporary /btw session…");

            const reservedFooterLines = flattenedLines.length > maxBodyLines - 1 ? 2 : 1;
            const visibleCount = Math.max(1, Math.min(maxBodyLines - reservedFooterLines, flattenedLines.length));
            lastPageSize = visibleCount;
            lastMaxOffset = Math.max(0, flattenedLines.length - visibleCount);
            if (autoScroll) scrollOffset = lastMaxOffset;
            scrollOffset = Math.max(0, Math.min(scrollOffset, lastMaxOffset));
            autoScroll = scrollOffset >= lastMaxOffset;

            const body = flattenedLines.slice(scrollOffset, scrollOffset + visibleCount);
            if (flattenedLines.length > visibleCount) {
              const pct = lastMaxOffset > 0 ? Math.round((scrollOffset / lastMaxOffset) * 100) : 100;
              body.push("─".repeat(Math.min(contentWidth, 24)));
              body.push(
                `${scrollOffset + 1}-${Math.min(scrollOffset + visibleCount, flattenedLines.length)} of ${flattenedLines.length} (${pct}%) · mouse wheel scroll · enter send · esc close`,
              );
            } else {
              body.push("Type in editor, Enter sends to /btw · mouse wheel scroll · Esc closes");
            }
            while (body.length < maxBodyLines) body.push("");
            if (body.length > maxBodyLines) body.length = maxBodyLines;

            const panelLines = borderedPanel(title, tokenLabel, body, panelWidth);
            lastPanelLines = panelLines;
            return highlightSelection(panelLines, selection, panelWidth);
          },
        };
      });

      // ── Temporary RPC Session ────────────────────────────────────────────

      ctx.ui.setStatus("btw", `${SPINNER_FRAMES[spinIdx]} BTW starting`);
      rpc = makeRpcClient({
        sessionFile,
        tempDir,
        cwd: ctx.cwd,
        onEvent: handleRpcEvent,
        onError: handleRpcError,
        onExit(code, signal) {
          if (closed) return;
          busy = false;
          loading = false;
          appendEntry({ role: "system", text: `Temporary /btw session exited (${signal ?? code ?? "unknown"}). Press Esc to close.` });
          ctx.ui.setStatus("btw", "BTW exited");
        },
      });

      statsTimer = setInterval(() => rpc?.requestStats(), TOKEN_REFRESH_MS);
      rpc.requestStats();

      // Send the initial question after the RPC process has had a moment to bind
      // its forked session. JSONL stdin is buffered, but this avoids making the
      // first render look stuck on very fast terminals.
      setTimeout(() => {
        if (closed) return;
        appendEntry({ role: "user", text: question });
        activeAssistantIndex = transcript.length;
        appendEntry({ role: "assistant", text: "", pending: true });
        busy = true;
        loading = false;
        rpc?.prompt(question, false);
        requestRender();
      }, 50).unref();
    },
  });
}
