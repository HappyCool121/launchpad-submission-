import { setKeybindings, type TUI } from "@adrouter/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { AdRouterInstallationLoginComponent } from "../../../src/modes/interactive/components/adrouter-installation-login.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { copyToClipboard } from "../../../src/utils/clipboard.ts";
import { openBrowser } from "../../../src/utils/open-browser.ts";

vi.mock("../../../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
vi.mock("../../../src/utils/clipboard.ts", () => ({ copyToClipboard: vi.fn() }));

function createDialog(): AdRouterInstallationLoginComponent {
	return new AdRouterInstallationLoginComponent({ requestRender: vi.fn() } as unknown as TUI);
}

function output(dialog: AdRouterInstallationLoginComponent): string {
	return stripAnsi(dialog.render(120).join("\n"));
}

describe("AdRouterInstallationLoginComponent", () => {
	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.mocked(openBrowser).mockReset();
		vi.mocked(copyToClipboard).mockReset();
		vi.mocked(copyToClipboard).mockResolvedValue(undefined);
	});

	test("uses Done as the default native selection without typed confirmation", async () => {
		const dialog = createDialog();
		const signInUrl =
			"https://app-staging.adrouter.co/developers?connect=cli#handoff=46be2c5c-f9ea-4d55-b5b0-3f51c3de5739";
		const confirmation = dialog.confirmSignIn(signInUrl);

		expect(output(dialog)).toContain("→ Done");
		expect(output(dialog)).toContain("Quit login");
		expect(output(dialog)).not.toContain("type DONE");
		expect(output(dialog)).not.toContain("Cancel | Submit");
		expect(openBrowser).toHaveBeenCalledWith(signInUrl, expect.any(Function));

		dialog.handleInput("\n");
		await expect(confirmation).resolves.toBe(true);
		expect(dialog.signal.aborted).toBe(false);
		expect(output(dialog)).toContain("Creating the approval request");
		dialog.dispose();
	});

	test("maps j navigation and Esc to a clean quit", async () => {
		const dialog = createDialog();
		const confirmation = dialog.confirmSignIn("https://app-staging.adrouter.co/developers?connect=cli");

		dialog.handleInput("j");
		expect(output(dialog)).toContain("→ Quit login");
		dialog.handleInput("\n");

		await expect(confirmation).resolves.toBe(false);
		expect(dialog.signal.aborted).toBe(true);
		dialog.dispose();
	});

	test("keeps one live waiting surface while opening and copying the approval link", async () => {
		vi.useFakeTimers();
		try {
			const dialog = createDialog();
			const confirmation = dialog.confirmSignIn("https://app-staging.adrouter.co/developers?connect=cli");
			dialog.handleInput("\n");
			await confirmation;
			const approvalUrl = "https://app-staging.adrouter.co/connect?code=A6FZ-3KHS";
			dialog.showApproval({
				userCode: "A6FZ-3KHS",
				verificationUri: "https://app-staging.adrouter.co/connect",
				verificationUriComplete: approvalUrl,
			});

			expect(output(dialog)).toContain("Waiting for approval in AdRouter");
			expect(output(dialog)).toContain("A6FZ-3KHS");
			expect(output(dialog)).toContain("→ Open approval page");
			expect(vi.getTimerCount()).toBe(1);

			dialog.handleInput("\n");
			expect(openBrowser).toHaveBeenLastCalledWith(approvalUrl, expect.any(Function));
			expect(output(dialog)).toContain("Opening the approval page");

			dialog.handleInput("j");
			dialog.handleInput("\n");
			await vi.runAllTicks();
			expect(copyToClipboard).toHaveBeenCalledWith(approvalUrl);
			expect(output(dialog)).toContain("Approval link copied.");
			expect(output(dialog)).toContain("Open approval page");
			expect(vi.getTimerCount()).toBe(1);

			dialog.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("keeps recovery actions after a browser-launch failure", async () => {
		const dialog = createDialog();
		const confirmation = dialog.confirmSignIn("https://app-staging.adrouter.co/developers?connect=cli");
		dialog.handleInput("\n");
		await confirmation;
		dialog.showApproval({
			userCode: "A6FZ-3KHS",
			verificationUri: "https://app-staging.adrouter.co/connect",
			verificationUriComplete: "https://app-staging.adrouter.co/connect?code=A6FZ-3KHS",
		});
		dialog.handleInput("\n");
		const onError = vi.mocked(openBrowser).mock.calls.at(-1)?.[1];
		onError?.(new Error("raw launcher detail"));

		expect(output(dialog)).toContain("could not be opened automatically");
		expect(output(dialog)).not.toContain("raw launcher detail");
		expect(output(dialog)).toContain("Copy approval link");
		dialog.dispose();
	});
});
