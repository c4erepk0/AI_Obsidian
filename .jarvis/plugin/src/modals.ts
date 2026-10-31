import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
	private resolved = false;
	constructor(
		app: App,
		private title: string,
		private body: string,
		private done: (ok: boolean) => void,
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(this.title);
		const pre = this.contentEl.createEl("pre", { cls: "jarvis-confirm-body" });
		pre.setText(this.body);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Отклонить").onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText("Разрешить")
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}
	private finish(ok: boolean) {
		this.resolved = true;
		this.done(ok);
		this.close();
	}
	onClose() {
		if (!this.resolved) this.done(false);
		this.contentEl.empty();
	}
}

export function confirmAsync(app: App, title: string, body: string): Promise<boolean> {
	return new Promise((res) => new ConfirmModal(app, title, body, res).open());
}

export class FeedbackModal extends Modal {
	constructor(
		app: App,
		private onSubmit: (reason: string) => void,
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Что было не так?");
		const ta = this.contentEl.createEl("textarea", {
			cls: "jarvis-feedback-input",
			attr: { rows: "4", placeholder: "Например: слишком длинно / не учёл мои цели / ошибся в факте…" },
		});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Отправить")
				.setCta()
				.onClick(() => {
					this.onSubmit(ta.value.trim());
					this.close();
				}),
		);
		setTimeout(() => ta.focus(), 50);
	}
	onClose() {
		this.contentEl.empty();
	}
}

export class TextPromptModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private placeholder: string,
		private onSubmit: (text: string) => void,
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(this.title);
		const ta = this.contentEl.createEl("textarea", {
			cls: "jarvis-feedback-input",
			attr: { rows: "3", placeholder: this.placeholder },
		});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Готово")
				.setCta()
				.onClick(() => {
					if (ta.value.trim()) this.onSubmit(ta.value.trim());
					this.close();
				}),
		);
		setTimeout(() => ta.focus(), 50);
	}
	onClose() {
		this.contentEl.empty();
	}
}
