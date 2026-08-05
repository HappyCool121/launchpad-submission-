/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId, truncateToWidth, visibleWidth } from "@adrouter/tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

function capitalizeAction(action: string): string {
	return action.length === 0 ? action : `${action[0]!.toUpperCase()}${action.slice(1)}`;
}

export function helperHint(keybinding: Keybinding, action: string): string {
	return rawHelperHint(keyDisplayText(keybinding), action, false);
}

export function rawHelperHint(key: string, action: string, formatKey = true): string {
	const displayKey = (formatKey ? formatKeyText(key, { capitalize: true }) : key).replace(/\bEscape\b/g, "Esc");
	return theme.fg("dim", `[${displayKey}]`) + theme.fg("muted", ` ${capitalizeAction(action)}`);
}

/** Pack complete shortcut hints into width-safe rows separated by vertical rules. */
export function helperHintRows(hints: readonly string[], width: number): string[] {
	if (width <= 0 || hints.length === 0) return [];
	const separator = theme.fg("muted", "  │  ");
	const rows: string[] = [];
	let row = "";
	for (const hint of hints) {
		const next = row ? `${row}${separator}${hint}` : hint;
		if (visibleWidth(next) <= width) {
			row = next;
			continue;
		}
		if (row) rows.push(row);
		row = visibleWidth(hint) <= width ? hint : truncateToWidth(hint, width, "…");
	}
	if (row) rows.push(row);
	return rows;
}
