import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ApprovalCommandLine, ApprovalPromptData } from "../prompt.ts";

const HORIZONTAL_PADDING = 0;

export interface ApprovalDialogOptions {
	data: ApprovalPromptData;
	choices: string[];
	onChoice: (choice: string | undefined) => void;
}

export class ApprovalDialog {
	private container: Container;
	private selectList: SelectList;
	private data: ApprovalPromptData;
	private theme: Theme;
	private lastWidth: number | undefined;

	constructor(theme: Theme, options: ApprovalDialogOptions) {
		this.theme = theme;
		this.data = options.data;

		this.container = new Container();
		this.selectList = this.createSelectList(options.choices, options.onChoice);
	}

	render(width: number): string[] {
		if (this.lastWidth !== width) {
			this.lastWidth = width;
			this.rebuild(width);
		}
		return this.container.render(width);
	}

	handleInput(data: string): void {
		this.selectList.handleInput?.(data);
	}

	invalidate(): void {
		this.lastWidth = undefined;
		this.container.invalidate();
	}

	private rebuild(width: number): void {
		this.container.clear();
		this.addHeader();
		this.addBody(width);
		this.addCommands(width);
		this.addFooter();
	}

	private addHeader(): void {
		this.container.addChild(
			new DynamicBorder((s: string) => this.theme.fg("accent", s)),
		);
		this.container.addChild(
			new Text(
				this.theme.fg("accent", this.theme.bold(this.data.title)),
				HORIZONTAL_PADDING,
				0,
			),
		);
	}

	private addBody(width: number): void {
		if (!this.data.body) return;

		this.container.addChild(new Spacer(1));
		for (const line of this.data.body.split("\n")) {
			this.container.addChild(
				new Text(
					this.theme.fg("text", this.truncate(line, width)),
					HORIZONTAL_PADDING,
					0,
				),
			);
		}
	}

	private addCommands(width: number): void {
		if (this.data.commands.length === 0) return;

		this.container.addChild(new Spacer(1));
		for (const command of this.data.commands) {
			if (command.text === "") {
				this.container.addChild(new Spacer(1));
				continue;
			}

			this.container.addChild(
				new Text(
					this.theme.fg(
						command.allowed ? "success" : "warning",
						this.truncate(formatCommandLine(command), width),
					),
					HORIZONTAL_PADDING,
					0,
				),
			);
		}
	}

	private addFooter(): void {
		this.container.addChild(new Spacer(1));
		this.container.addChild(this.selectList);
		this.container.addChild(
			new DynamicBorder((s: string) => this.theme.fg("accent", s)),
		);
	}

	private truncate(text: string, width: number): string {
		const available = Math.max(1, width - HORIZONTAL_PADDING * 2);
		return truncateToWidth(text, available);
	}

	private createSelectList(
		choices: string[],
		onChoice: (choice: string | undefined) => void,
	): SelectList {
		const items: SelectItem[] = choices.map((choice) => ({
			value: choice,
			label: choice,
		}));

		const list = new SelectList(items, Math.min(items.length, 6), {
			selectedPrefix: (t: string) => this.theme.fg("accent", t),
			selectedText: (t: string) => this.theme.fg("accent", t),
			description: (t: string) => this.theme.fg("muted", t),
			scrollInfo: (t: string) => this.theme.fg("dim", t),
			noMatch: (t: string) => this.theme.fg("warning", t),
		});

		list.onSelect = (item: SelectItem) => onChoice(item.value);
		list.onCancel = () => onChoice(undefined);

		return list;
	}
}

function formatCommandLine(command: ApprovalCommandLine): string {
	const prefix = command.allowed ? "✔ " : "✖ ";
	const joiner = command.joiner ? ` ${command.joiner}` : "";
	return `${prefix}${command.text}${joiner}`;
}
