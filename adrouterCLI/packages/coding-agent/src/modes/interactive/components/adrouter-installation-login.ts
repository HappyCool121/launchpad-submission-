import type { OAuthDeviceCodeInfo } from "@adrouter/ai/oauth";
import { Container, getKeybindings, Loader, type SelectItem, SelectList, Spacer, Text, type TUI } from "@adrouter/tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { helperHint, rawHelperHint } from "./keybinding-hints.ts";

type LoginAction = "done" | "quit" | "open" | "copy";

const CONFIRM_ACTIONS: SelectItem[] = [
	{ value: "done", label: "Done" },
	{ value: "quit", label: "Quit login" },
];

const APPROVAL_ACTIONS: SelectItem[] = [
	{ value: "open", label: "Open approval page" },
	{ value: "copy", label: "Copy approval link" },
	{ value: "quit", label: "Quit login" },
];

export class AdRouterInstallationLoginComponent extends Container {
	private readonly tui: TUI;
	private readonly content = new Container();
	private readonly abortController = new AbortController();
	private actions: SelectItem[] = [];
	private selectList: SelectList | undefined;
	private selectedIndex = 0;
	private confirmResolver: ((confirmed: boolean) => void) | undefined;
	private loader: Loader | undefined;
	private statusLine: Text | undefined;
	private approvalUrl: string | undefined;
	private phase: "idle" | "confirm" | "creating" | "approval" | "disposed" = "idle";

	constructor(tui: TUI) {
		super();
		this.tui = tui;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Connect this CLI to AdRouter")), 1, 0));
		this.addChild(this.content);
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	confirmSignIn(signInUrl: string): Promise<boolean> {
		this.stopLoader();
		this.phase = "confirm";
		this.content.clear();
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(theme.fg("text", "Sign in to your AdRouter account in the browser."), 1, 0));
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(theme.fg("accent", this.link(signInUrl)), 1, 0));
		this.content.addChild(new Text(theme.fg("dim", "If the browser does not open, use the URL above."), 1, 0));
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(theme.fg("text", "After signing in to AdRouter, choose an action:"), 1, 0));
		this.installActions(CONFIRM_ACTIONS);
		openBrowser(signInUrl, () => {
			if (this.phase !== "confirm") return;
			this.setStatus("The browser could not be opened automatically. Open the sign-in URL above.", "warning");
		});
		this.tui.requestRender();
		return new Promise((resolve) => {
			this.confirmResolver = resolve;
		});
	}

	showApproval(info: OAuthDeviceCodeInfo & { verificationUriComplete?: string; expiresAt?: number }): void {
		this.stopLoader();
		this.phase = "approval";
		this.approvalUrl = info.verificationUriComplete ?? info.verificationUri;
		this.content.clear();
		this.content.addChild(new Spacer(1));
		this.loader = new Loader(
			this.tui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("dim", text),
			"Waiting for approval in AdRouter…",
		);
		this.content.addChild(this.loader);
		this.content.addChild(new Text(theme.fg("warning", `Compare code: ${info.userCode}`), 1, 0));
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(theme.fg("accent", this.link(this.approvalUrl)), 1, 0));
		this.content.addChild(new Spacer(1));
		this.installActions(APPROVAL_ACTIONS);
		this.tui.requestRender();
	}

	showProgress(message: string): void {
		if (this.phase === "disposed") return;
		this.setStatus(message, "dim");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (!this.selectList || this.actions.length === 0) return;
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + this.actions.length) % this.actions.length;
			this.selectList.setSelectedIndex(this.selectedIndex);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
			this.selectList.setSelectedIndex(this.selectedIndex);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") this.selectList.handleInput(data);
	}

	dispose(): void {
		if (this.phase === "disposed") return;
		this.phase = "disposed";
		this.stopLoader();
		this.confirmResolver?.(false);
		this.confirmResolver = undefined;
		if (!this.abortController.signal.aborted) this.abortController.abort();
	}

	private installActions(actions: SelectItem[]): void {
		this.actions = actions;
		this.selectedIndex = 0;
		this.selectList = new SelectList(actions, actions.length, getSelectListTheme());
		this.selectList.onSelect = (item) => this.selectAction(item.value as LoginAction);
		this.content.addChild(this.selectList);
		this.content.addChild(new Spacer(1));
		this.content.addChild(
			new Text(
				rawHelperHint("↑↓", "navigate") +
					"  │  " +
					helperHint("tui.select.confirm", "select") +
					"  │  " +
					helperHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
	}

	private selectAction(action: LoginAction): void {
		if (action === "quit") {
			this.cancel();
			return;
		}
		if (action === "done" && this.phase === "confirm") {
			const resolve = this.confirmResolver;
			this.confirmResolver = undefined;
			this.showCreatingAuthorization();
			resolve?.(true);
			return;
		}
		if (this.phase !== "approval" || !this.approvalUrl) return;
		if (action === "open") {
			openBrowser(this.approvalUrl, () => {
				this.setStatus(
					"The approval page could not be opened automatically. Copy the link and open it manually.",
					"warning",
				);
			});
			this.setStatus("Opening the approval page…", "dim");
			return;
		}
		if (action === "copy") {
			void copyToClipboard(this.approvalUrl)
				.then(() => this.setStatus("Approval link copied.", "success"))
				.catch(() =>
					this.setStatus("The approval link could not be copied. Open it from the URL above.", "warning"),
				);
		}
	}

	private showCreatingAuthorization(): void {
		this.stopLoader();
		this.phase = "creating";
		this.actions = [];
		this.selectList = undefined;
		this.content.clear();
		this.content.addChild(new Spacer(1));
		this.loader = new Loader(
			this.tui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("dim", text),
			"Creating the approval request…",
		);
		this.content.addChild(this.loader);
		this.content.addChild(new Text(helperHint("tui.select.cancel", "cancel"), 1, 0));
		this.tui.requestRender();
	}

	private cancel(): void {
		if (this.phase === "disposed") return;
		this.stopLoader();
		const resolve = this.confirmResolver;
		this.confirmResolver = undefined;
		if (!this.abortController.signal.aborted) this.abortController.abort();
		resolve?.(false);
	}

	private setStatus(message: string, color: "dim" | "warning" | "success"): void {
		if (!this.statusLine) {
			this.statusLine = new Text("", 1, 0);
			this.content.addChild(this.statusLine);
		}
		this.statusLine.setText(theme.fg(color, message));
		this.tui.requestRender();
	}

	private stopLoader(): void {
		this.loader?.stop();
		this.loader = undefined;
		this.statusLine = undefined;
	}

	private link(url: string): string {
		return `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
	}
}
