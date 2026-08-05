import { execFile, spawnSync } from "child_process";
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	mkdtempSync,
	rmSync,
	type Stats,
	type WatchListener,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[1] === "symbolic-ref") {
				setTimeout(
					() =>
						callback(
							resolvedBranch ? null : new Error("detached"),
							resolvedBranch ? `${resolvedBranch}\n` : "",
							"",
						),
					0,
				);
				return;
			}
			setTimeout(() => callback(new Error("unsupported"), "", ""), 0);
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import { FooterDataProvider, type FooterDataProviderWatchDependencies } from "../src/core/footer-data-provider.ts";

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

function createWatchHarness() {
	const directoryWatches: Array<{
		listener: WatchListener<string>;
		onError: () => void;
		path: string;
		watcher: FSWatcher;
	}> = [];
	const pollingWatches: Array<{
		listener: (current: Stats, previous: Stats) => void;
		path: string;
	}> = [];
	const unwatchPolling = vi.fn();
	const dependencies: FooterDataProviderWatchDependencies = {
		watchDirectory: (path, listener, onError) => {
			const watcher = { close: vi.fn() } as unknown as FSWatcher;
			directoryWatches.push({ listener, onError, path, watcher });
			return watcher;
		},
		watchPolling: (path, _options, listener) => {
			pollingWatches.push({ path: path.toString(), listener });
			return undefined;
		},
		unwatchPolling,
	};
	return { dependencies, directoryWatches, pollingWatches, unwatchPolling };
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;
	let watchHarness: ReturnType<typeof createWatchHarness>;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		watchHarness = createWatchHarness();
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider(nestedDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		resolvedBranch = "";

		const provider = new FooterDataProvider(repoDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	it("does not notify listeners when an injected reftable callback keeps the same branch", async () => {
		vi.useFakeTimers();
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(spawnSync).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			watchHarness.directoryWatches.find(({ path }) => path === reftableDir)?.listener("change", "tables.list");
			await vi.advanceTimersByTimeAsync(500);
			await vi.runOnlyPendingTimersAsync();

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("coalesces rapid injected reftable callbacks into one async refresh", async () => {
		vi.useFakeTimers();
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(execFile).mockClear();

			const listener = watchHarness.directoryWatches.find(({ path }) => path === reftableDir)?.listener;
			listener?.("change", "tables.list");
			listener?.("change", "tables.list");
			listener?.("rename", "tables.list");
			await vi.advanceTimersByTimeAsync(500);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("updates the cached branch when an injected reftable callback observes a change", async () => {
		vi.useFakeTimers();
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir, watchHarness.dependencies);
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			watchHarness.directoryWatches.find(({ path }) => path === reftableDir)?.listener("change", "tables.list");
			await vi.advanceTimersByTimeAsync(500);
			await vi.runOnlyPendingTimersAsync();

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("retries injected git watchers 5 seconds after a watcher error", async () => {
		vi.useFakeTimers();
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir, watchHarness.dependencies);
		try {
			const originalWatcher = watchHarness.directoryWatches[0]?.watcher;
			watchHarness.directoryWatches[0]?.onError();
			expect(vi.mocked(originalWatcher.close)).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(4999);
			expect(watchHarness.directoryWatches).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(watchHarness.directoryWatches).toHaveLength(2);
			expect(watchHarness.directoryWatches[1]?.watcher).not.toBe(originalWatcher);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("unregisters the exact reftable polling listener and closes every watcher", () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		const provider = new FooterDataProvider(worktreeDir, watchHarness.dependencies);
		const polling = watchHarness.pollingWatches.find(({ path }) => path === join(reftableDir, "tables.list"));
		expect(polling).toBeDefined();

		provider.dispose();

		expect(watchHarness.unwatchPolling).toHaveBeenCalledWith(polling?.path, polling?.listener);
		for (const { watcher } of watchHarness.directoryWatches) {
			expect(vi.mocked(watcher.close)).toHaveBeenCalledOnce();
		}
	});
});
