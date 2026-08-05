import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

/**
 * Product-owned AdRouter surfaces. Vendored sources are included where local
 * adaptations can affect AdRouterCLI state or command behavior.
 */
const productFiles = [
	"README.md",
	".env.example",
	"packages/ai/src/adrouter-events.ts",
	"packages/ai/src/adrouter-settings.ts",
	"packages/ai/src/api/adrouter.ts",
	"packages/ai/src/providers/adrouter.models.ts",
	"packages/ai/src/providers/adrouter.ts",
	"packages/coding-agent/src/cli/adrouter-command.ts",
	"packages/coding-agent/src/core/adrouter-session.ts",
	"packages/coding-agent/src/core/profiles.ts",
	"packages/coding-agent/src/profile-cli.ts",
	"packages/coding-agent/src/core/resource-loader.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
	"packages/coding-agent/src/modes/interactive/components/adrouter-ad-panel.ts",
	"packages/coding-agent/src/modes/interactive/components/adrouter-settlement-entry.ts",
	"packages/coding-agent/src/modes/interactive/components/footer.ts",
	"packages/coding-agent/docs/README.md",
	"packages/coding-agent/docs/index.md",
	"packages/coding-agent/scripts/migrate-sessions.sh",
	"packages/coding-agent/src/migrations.ts",
	"packages/coding-agent/src/package-manager-cli.ts",
	"packages/coding-agent/src/core/bash-executor.ts",
	"packages/coding-agent/src/core/provider-attribution.ts",
	"packages/coding-agent/src/core/tools/bash.ts",
	"packages/coding-agent/src/core/tools/output-accumulator.ts",
	"packages/coding-agent/src/utils/clipboard-image.ts",
	"packages/coding-agent/src/utils/adrouter-user-agent.ts",
	"packages/coding-agent/src/modes/interactive/components/extension-editor.ts",
	"packages/coding-agent/src/modes/interactive/components/first-time-setup.ts",
	"scripts/check-browser-smoke.mjs",
	"scripts/build-binaries.sh",
	"scripts/profile-coding-agent-node.mjs",
	"scripts/release-notes.mjs",
];

const bundledRoot = resolve(root, "packages/coding-agent/bundled");
const activeBundledFiles = [
	"pi-subagents-0.30.0/install.mjs",
	"pi-subagents-0.30.0/src/agents/agent-management.ts",
	"pi-subagents-0.30.0/src/agents/agents.ts",
	"pi-subagents-0.30.0/src/agents/skills.ts",
	"pi-subagents-0.30.0/src/intercom/intercom-bridge.ts",
	"pi-subagents-0.30.0/src/runs/shared/mcp-direct-tool-allowlist.ts",
	"pi-subagents-0.30.0/src/shared/utils.ts",
	...readdirSync(resolve(bundledRoot, "pi-web-access-0.13.0"))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `pi-web-access-0.13.0/${name}`),
].map((file) => `packages/coding-agent/bundled/${file}`);

// Detailed technical reference pages keep upstream extension API terminology
// where the public interface requires it. These two READMEs are the shipped
// product entry points and must remain entirely AdRouterCLI-branded.
const productReadmes = new Set(["README.md", "packages/coding-agent/docs/README.md", "packages/coding-agent/docs/index.md"]);

const forbiddenPatterns = [
	{ label: "legacy .pi profile/config path", expression: /(?:^|[^A-Za-z0-9_])\.pi(?:[/\\]|["'])/g },
	{ label: "legacy Pi temporary filename", expression: /\bpi-(?:bash|browser-smoke|clipboard|editor|extension-editor|output|release-notes|test|wsl-clip)\b/gi },
	{ label: "legacy Pi binary artifact name", expression: /\bpi-(?:darwin|linux|windows)-/gi },
	{ label: "legacy Pi child command", expression: /spawn\(["']pi["']/g },
	{ label: "legacy Pi profile variable", expression: /\bPI_PROFILES_DIR\b/g },
	{ label: "legacy Pi agent directory variable", expression: /\bPI_CODING_AGENT_DIR\b/g },
	{ label: "legacy Pi profile state file", expression: /(?:profiles\.json|["']profile\.json["'])/g },
	{ label: "product-facing Pi tool report", expression: /\bPi Tool Stats\b/g },
	{ label: "product-facing Pi user agent", expression: /`pi\//g },
	{ label: "upstream Pi release or install service", expression: /pi\.dev\/(?:api\/(?:latest-version|report-install)|changelog)/g },
	{ label: "product-facing Pi copy", expression: /\bPi\s+(?:will resume|works best|Agent Harness|CLI|is a minimal|ships with)/g },
];

/**
 * These are the only tolerated Pi references in the scanned files. They are
 * required historical attribution or protocol references, never active package
 * imports or AdRouter-owned state paths.
 */
const allowlist = [
	{
		file: "README.md",
		expression: /(?:derived from \[Pi\]|preserves Pi's original MIT license)/g,
		reason: "required upstream attribution",
	},
	{
		file: "packages/coding-agent/docs/README.md",
		expression: /(?:derived from \[Pi\]|preserves Pi's original MIT license)/g,
		reason: "required upstream attribution",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		expression: /https:\/\/pi\.dev\/api\/report-install/g,
		reason: "legacy upstream telemetry protocol endpoint",
	},
];

const failures = [];
const reviewedAllowlistMatches = [];

for (const file of [...productFiles, ...activeBundledFiles]) {
	const path = resolve(root, file);
	if (!existsSync(path)) {
		failures.push(`${file}: required branding-scan target is missing`);
		continue;
	}
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		const allowedPiReference = allowlist.some((entry) => {
			if (entry.file !== file) return false;
			entry.expression.lastIndex = 0;
			return entry.expression.test(line);
		});
		if (productReadmes.has(file) && /\bpi\b/i.test(line) && !allowedPiReference) {
			failures.push(`${file}:${index + 1}: product-facing Pi name: ${line.trim()}`);
		}
		for (const pattern of forbiddenPatterns) {
			pattern.expression.lastIndex = 0;
			if (pattern.expression.test(line)) {
				failures.push(`${file}:${index + 1}: ${pattern.label}: ${line.trim()}`);
			}
		}
		for (const entry of allowlist.filter((candidate) => candidate.file === file)) {
			entry.expression.lastIndex = 0;
			if (entry.expression.test(line)) {
				reviewedAllowlistMatches.push(`${file}:${index + 1}: ${entry.reason}`);
			}
		}
	}
}

for (const match of reviewedAllowlistMatches) {
	console.log(`[allowlist] ${match}`);
}

if (failures.length > 0) {
	console.error("AdRouterCLI branding check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exitCode = 1;
} else {
	console.log("AdRouterCLI branding check passed.");
}
