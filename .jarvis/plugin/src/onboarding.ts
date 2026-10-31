import { Modal, Notice, Setting } from "obsidian";
import type JarvisPlugin from "./main";
import { MODELS, callClaude, humanError } from "./api";
import { KNOWN_PLUGINS, installPlugin, isPluginEnabled } from "./plugins";
import { STARTER } from "./starter.generated";
import { VaultFS } from "./vaultfs";

/** Создаёт недостающие файлы стартовой структуры. Существующие не трогает. */
export async function installStructure(fs: VaultFS): Promise<{ created: number; skipped: number }> {
	let created = 0;
	let skipped = 0;
	for (const [path, content] of Object.entries(STARTER)) {
		const isFolder = path.endsWith("/.keep");
		const target = isFolder ? path.slice(0, -"/.keep".length) : path;
		if (await fs.exists(target)) {
			skipped++;
			continue;
		}
		if (isFolder) await fs.ensureFolder(target);
		else await fs.write(target, content);
		created++;
	}
	return { created, skipped };
}

export async function missingStructureCount(fs: VaultFS): Promise<number> {
	let n = 0;
	for (const path of Object.keys(STARTER)) {
		const p = path.endsWith("/.keep") ? path.slice(0, -"/.keep".length) : path;
		if (!(await fs.exists(p))) n++;
	}
	return n;
}

export class OnboardingModal extends Modal {
	constructor(private plugin: JarvisPlugin) {
		super(plugin.app);
	}

	async onOpen() {
		const s = this.plugin.settings;
		const { contentEl } = this;
		contentEl.addClass("jarvis-onboarding");
		this.titleEl.setText(`Знакомство: ${s.assistantName}`);
		contentEl.createEl("p", {
			text: "Пара шагов — и личный ИИ-ассистент готов. Он будет знать всё, что записано в этом хранилище, вести его за тебя и учиться на твоих отзывах.",
		});

		let address = s.userAddress;
		let apiKey = s.apiKey;
		let model = s.model;
		const missing = await missingStructureCount(this.plugin.fs);
		let doStructure = missing > 0;
		const plugins = new Set(KNOWN_PLUGINS.filter((p) => p.recommended && !isPluginEnabled(this.app, p.id)).map((p) => p.id));
		let briefing = s.autoBriefing;

		new Setting(contentEl)
			.setName("Как к тебе обращаться?")
			.setDesc("Имя, «сэр», «босс» — как нравится.")
			.addText((t) => t.setPlaceholder("Дмитрий").setValue(address).onChange((v) => (address = v.trim())));

		const keySetting = new Setting(contentEl).setName("API-ключ Anthropic").addText((t) => {
			t.inputEl.type = "password";
			t.setPlaceholder("sk-ant-…")
				.setValue(apiKey)
				.onChange((v) => (apiKey = v.trim()));
		});
		const d = keySetting.descEl;
		d.appendText("Создай на ");
		d.createEl("a", { text: "console.anthropic.com", href: "https://console.anthropic.com/settings/keys" });
		d.appendText(" → API Keys → Create Key и пополни баланс. Ключ хранится только на этом устройстве.");

		new Setting(contentEl)
			.setName("Модель")
			.addDropdown((dd) => {
				for (const [id, label] of Object.entries(MODELS)) dd.addOption(id, label);
				dd.setValue(model).onChange((v) => (model = v));
			});

		if (missing > 0)
			new Setting(contentEl)
				.setName("Создать структуру хранилища")
				.setDesc(`Папки, память «10 Я», шаблоны, навыки, «Главная» (не хватает: ${missing}). Существующие заметки не трогаются.`)
				.addToggle((t) => t.setValue(doStructure).onChange((v) => (doStructure = v)));

		const avail = KNOWN_PLUGINS.filter((p) => !isPluginEnabled(this.app, p.id));
		if (avail.length) {
			contentEl.createEl("h4", { text: "Плагины (скачаются с GitHub автоматически)" });
			for (const p of avail)
				new Setting(contentEl)
					.setName(p.name)
					.setDesc(p.why)
					.addToggle((t) =>
						t.setValue(plugins.has(p.id)).onChange((v) => (v ? plugins.add(p.id) : plugins.delete(p.id))),
					);
		}

		new Setting(contentEl)
			.setName("Утренний брифинг")
			.setDesc("При первом открытии Obsidian за день Джарвис сам готовит план дня.")
			.addToggle((t) => t.setValue(briefing).onChange((v) => (briefing = v)));

		const status = contentEl.createDiv("jarvis-onboarding-status");
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Запустить")
				.setCta()
				.onClick(async () => {
					if (!apiKey.startsWith("sk-ant-")) {
						status.setText("Похоже, ключ неверный: он должен начинаться с sk-ant-");
						return;
					}
					b.setDisabled(true);
					try {
						status.setText("Проверяю ключ…");
						await callClaude({
							apiKey,
							model,
							effort: "low",
							system: [{ type: "text", text: "Ответь одним словом." }],
							tools: [],
							messages: [{ role: "user", content: "Скажи: готов" }],
							webTools: false,
							maxTokens: 2000,
						});
						Object.assign(s, { apiKey, model, userAddress: address, autoBriefing: briefing, onboarded: true });
						await this.plugin.saveSettings();

						if (doStructure) {
							status.setText("Создаю структуру хранилища…");
							const r = await installStructure(this.plugin.fs);
							new Notice(`Создано файлов: ${r.created}`);
						}
						for (const id of plugins) {
							status.setText(`Устанавливаю ${id}…`);
							try {
								new Notice(await installPlugin(this.app, id));
							} catch (e) {
								new Notice(`${id}: ${(e as Error).message}`);
							}
						}
						this.close();
						await this.plugin.afterOnboarding();
					} catch (e) {
						status.setText(humanError(e));
						b.setDisabled(false);
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
