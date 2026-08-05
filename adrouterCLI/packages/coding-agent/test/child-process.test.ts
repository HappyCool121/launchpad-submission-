import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../src/utils/child-process.ts";

function fakeChild(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, {
		exitCode: null,
		killed: false,
		signalCode: null,
		stderr: new PassThrough(),
		stdout: new PassThrough(),
	});
	return child;
}

describe("waitForChildProcess post-exit stdio handling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("restarts the 500ms idle grace when output arrives after exit", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		let settled = false;
		const result = waitForChildProcess(child).then((code) => {
			settled = true;
			return code;
		});

		child.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(400);
		child.stdout?.emit("data", Buffer.from("tail"));
		await vi.advanceTimersByTimeAsync(499);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe(0);
		expect(child.stdout?.destroyed).toBe(true);
		expect(child.stderr?.destroyed).toBe(true);
	});

	it("resolves immediately when both streams end after exit", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const result = waitForChildProcess(child);

		child.emit("exit", 7, null);
		child.stdout?.emit("end");
		child.stderr?.emit("end");

		await expect(result).resolves.toBe(7);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases quiet inherited streams when the 500ms grace expires", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const result = waitForChildProcess(child);

		child.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(499);
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe(0);
	});
});
