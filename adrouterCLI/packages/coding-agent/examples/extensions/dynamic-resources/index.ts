import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@adrouter/cli";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		return {
			skillPaths: [join(baseDir, "docs", "SKILL.md")],
			promptPaths: [join(baseDir, "docs", "dynamic.md")],
			themePaths: [join(baseDir, "dynamic.json")],
		};
	});
}
