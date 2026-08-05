import { describe, expect, it } from "vitest";
import { browserLaunchCommand } from "../src/utils/open-browser.ts";

describe("browser launch commands", () => {
	const target = "https://app-staging.adrouter.co/connect?code=ABCD-EFGH&source=cli";

	it.each([
		["darwin", "open", [target]],
		["linux", "xdg-open", [target]],
	] as const)("uses a shell-free launcher on %s", (platform, command, args) => {
		expect(browserLaunchCommand(target, platform)).toEqual({ command, args });
	});

	it("uses encoded PowerShell Start-Process on Windows without shell parsing", () => {
		const unsafeTarget = `${target}&quoted='value'`;
		const launch = browserLaunchCommand(unsafeTarget, "win32");
		expect(launch.command).toBe("powershell.exe");
		expect(launch.args.slice(0, -1)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-EncodedCommand",
		]);
		const script = Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le");
		expect(script).toBe(`Start-Process -FilePath '${unsafeTarget.replaceAll("'", "''")}'`);
	});
});
