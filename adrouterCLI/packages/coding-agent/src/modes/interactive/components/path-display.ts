import { truncateToWidth, visibleWidth } from "@adrouter/tui";

function normalizeDisplayPath(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
	let end = normalized.length;
	while (end > 0 && normalized.charCodeAt(end - 1) === 47) end--;
	return normalized.slice(0, end);
}

function isWithinHome(path: string, home: string): boolean {
	const caseInsensitive = /^[A-Za-z]:\//.test(path) || /^[A-Za-z]:\//.test(home);
	const candidate = caseInsensitive ? path.toLowerCase() : path;
	const base = caseInsensitive ? home.toLowerCase() : home;
	return candidate === base || candidate.startsWith(`${base}/`);
}

/** Replace the home prefix with ~ without abbreviating sibling directories. */
export function formatDisplayDirectory(path: string, home?: string): string {
	const normalizedPath = normalizeDisplayPath(path);
	if (!home) return normalizedPath;
	const normalizedHome = normalizeDisplayPath(home);
	if (!isWithinHome(normalizedPath, normalizedHome)) return normalizedPath;
	const remainder = normalizedPath.slice(normalizedHome.length);
	return remainder ? `~${remainder.startsWith("/") ? remainder : `/${remainder}`}` : "~";
}

/**
 * Collapse the middle of a directory path while preserving its root/home prefix
 * and as many trailing path segments as the available terminal width allows.
 */
export function truncateDisplayDirectory(path: string, width: number): string {
	if (width <= 0) return "";
	const normalized = normalizeDisplayPath(path);
	if (visibleWidth(normalized) <= width) return normalized;

	let prefix = "";
	let remainder = normalized;
	if (normalized === "~" || normalized.startsWith("~/")) {
		prefix = "~";
		remainder = normalized.slice(1).replace(/^\/+/, "");
	} else if (/^[A-Za-z]:\//.test(normalized)) {
		prefix = normalized.slice(0, 2);
		remainder = normalized.slice(3);
	} else if (normalized.startsWith("//")) {
		const uncParts = normalized.slice(2).split("/");
		prefix = `//${uncParts.slice(0, 2).join("/")}`;
		remainder = uncParts.slice(2).join("/");
	} else if (normalized.startsWith("/")) {
		remainder = normalized.slice(1);
	}

	const segments = remainder.split("/").filter(Boolean);
	if (segments.length === 0) return truncateToWidth(normalized, width, "…");
	const prefixText = prefix === "" && normalized.startsWith("/") ? "/" : prefix ? `${prefix}/` : "";
	let tail = segments.at(-1)!;
	let candidate = `${prefixText}…/${tail}`;
	if (visibleWidth(candidate) > width) return truncateToWidth(tail, width, "…");

	for (let index = segments.length - 2; index >= 0; index--) {
		const expandedTail = `${segments[index]}/${tail}`;
		const expanded = `${prefixText}…/${expandedTail}`;
		if (visibleWidth(expanded) > width) break;
		tail = expandedTail;
		candidate = expanded;
	}
	return candidate;
}

export function fitDisplayDirectory(path: string, home: string | undefined, width: number): string {
	return truncateDisplayDirectory(formatDisplayDirectory(path, home), width);
}
