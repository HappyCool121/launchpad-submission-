import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";

export const CHILD_PROCESS_DEADLINE_MS = 45_000;

function forceCleanup(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}

	child.kill("SIGKILL");
}

export function withChildProcessDeadline<T>(
	child: ChildProcess,
	operation: Promise<T>,
	diagnostics: () => string,
	deadlineMs = CHILD_PROCESS_DEADLINE_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			forceCleanup(child);
			const detail = diagnostics().trim();
			reject(
				new Error(
					`Child process ${child.pid ?? "without pid"} exceeded ${deadlineMs}ms and was forcibly cleaned up.${
						detail ? `\n${detail}` : ""
					}`,
				),
			);
		}, deadlineMs);

		operation.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				forceCleanup(child);
				reject(error);
			},
		);
	});
}
