import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, moment } from "obsidian";
import { Agent } from "./agent";
import { MODELS } from "./api";
import { confirmAsync, TextPromptModal } from "./modals";
import { OnboardingModal, installStructure } from "./onboarding";
import { KNOWN_PLUGINS, installPlugin, isPluginEnabled } from "./plugins";
import { DEFAULT_SETTINGS, JarvisSettings, PATHS } from "./settings";
import { VaultFS } from "./vaultfs";
import { JarvisView, VIEW_TYPE } from "./view";

export default class JarvisPlugin extends Plugin {
	settings!: JarvisSettings;
	fs!: VaultFS;
	agent!: Agent;

	async onload() {
		await this.loadSettings();
		this.fs = new VaultFS(this.app);
		this.agent = new Agent(() => this.settings, {
			app: this.app,
			fs: this.fs,
			confirm: (t, b) => confirmAsync(this.app, t, b),
			confirmSelfEdits: () => this.settings.confirmSelfEdits,
		});

		this.registerView(VIEW_TYPE, (leaf) => new JarvisView(leaf, this));
		this.addRibbonIcon("bot", this.settings.assistantName, () => this.openView());

		this.addCommand({ id: "open", name: "Открыть чат", callback: () => this.openView() });
		this.addCommand({
			id: "capture",
			name: "Быстрая запись во «Входящие»",
			callback: () =>
				new TextPromptModal(this.app, "Быстрая запись", "Мысль, задача, ссылка…", (t) => this.capture(t)).open(),
		});
		this.addCommand({
			id: "ask-about-note",
			name: "Спросить о текущей заметке",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return false;
				if (!checking)
					new TextPromptModal(this.app, `Вопрос о «${f.basename}»`, "Что сделать с этой заметкой?", (q) =>
						this.ask(`Про заметку [[${f.basename}]] (${f.path}): ${q}`),
					).open();
				return true;
			},
		});
		this.addCommand({ id: "briefing", name: "Утренний брифинг", callback: () => this.ask("/brief") });
		this.addCommand({ id: "improve", name: "Самоулучшение (рефлексия)", callback: () => this.ask("/improve") });
		this.addCommand({ id: "setup", name: "Мастер настройки", callback: () => this.openOnboarding() });
		this.addCommand({
			id: "install-structure",
			name: "Создать недостающую структуру хранилища",
			callback: async () => {
				const r = await installStructure(this.fs);
				new Notice(`Создано: ${r.created}, уже было: ${r.skipped}`);
			},
		});

		// obsidian://jarvis?q=текст — для Siri / Команд iOS / виджетов
		// obsidian://jarvis?capture=текст — запись во «Входящие» без ИИ
		this.registerObsidianProtocolHandler("jarvis", async (params) => {
			if (params.capture) return this.capture(params.capture);
			if (params.q) return this.ask(params.q);
			return this.openView();
		});

		this.addSettingTab(new JarvisSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => this.onReady());
	}

	onunload() {
		window.speechSynthesis?.cancel();
	}

	private async onReady() {
		if (!this.settings.onboarded || !this.settings.apiKey) {
			this.openOnboarding();
			return;
		}
		if (this.settings.openHomeOnStart) {
			const home = this.app.vault.getAbstractFileByPath(PATHS.home);
			const active = this.app.workspace.getActiveFile();
			if (home instanceof TFile && !active) await this.app.workspace.getLeaf(false).openFile(home);
		}
		const today = moment().format("YYYY-MM-DD");
		if (this.settings.autoBriefing && this.settings.lastBriefing !== today && new Date().getHours() >= 5) {
			this.settings.lastBriefing = today;
			await this.saveSettings();
			this.ask("/brief");
		}
	}

	isMobile() {
		return Platform.isMobile;
	}

	openOnboarding() {
		new OnboardingModal(this).open();
	}

	async afterOnboarding() {
		const view = await this.openView();
		const profile = (await this.fs.readIfExists("10 Я/Профиль.md")) ?? "";
		const empty = /- Имя:\s*$/m.test(profile) || !profile;
		if (empty) view?.send("/interview");
	}

	async openView(): Promise<JarvisView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = Platform.isMobile ? workspace.getLeaf("tab") : workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
		const view = leaf.view instanceof JarvisView ? leaf.view : null;
		view?.focusInput();
		return view;
	}

	async ask(text: string) {
		const view = await this.openView();
		if (view) await view.send(text);
	}

	async capture(text: string) {
		const name = `${PATHS.inbox}/${moment().format("YYYY-MM-DD HHmmss")}.md`;
		await this.fs.write(name, `${text}\n`);
		new Notice("📥 Записал во «Входящие»");
	}

	/** Озвучка ответа голосом (iOS: встроенный синтез речи). */
	speak(text: string, force = false) {
		if (!force && !this.settings.speakReplies) return;
		const synth = window.speechSynthesis;
		if (!synth) return;
		synth.cancel();
		const clean = text
			.replace(/```[\s\S]*?```/g, "")
			.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
			.replace(/[#*_`>|]/g, "")
			.slice(0, 3000);
		const u = new SpeechSynthesisUtterance(clean);
		u.lang = "ru-RU";
		const ru = synth.getVoices().find((v) => v.lang?.startsWith("ru"));
		if (ru) u.voice = ru;
		synth.speak(u);
	}

	async logFeedback(mark: string, request: string, reason: string) {
		const req = request.replace(/\s+/g, " ").slice(0, 160);
		const line = `- (${moment().format("YYYY-MM-DD HH:mm")}) ${mark} на «${req}»${reason ? ` — ${reason}` : ""}\n`;
		await this.fs.append(PATHS.feedback, line);
	}

	async saveChat(user: string, answer: string) {
		if (!this.settings.saveChats) return;
		const path = `${PATHS.chatsDir}/${moment().format("YYYY-MM-DD")}.md`;
		const t = moment().format("HH:mm");
		await this.fs.append(path, `\n### ${t}\n**Я:** ${user}\n\n**${this.settings.assistantName}:** ${answer}\n`);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class JarvisSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: JarvisPlugin,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Мастер настройки").addButton((b) =>
			b.setButtonText("Открыть").onClick(() => this.plugin.openOnboarding()),
		);

		new Setting(containerEl)
			.setName("API-ключ Anthropic")
			.setDesc("console.anthropic.com → API Keys. Хранится только локально (data.json, не попадает в git).")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.apiKey).onChange(async (v) => {
					s.apiKey = v.trim();
					await save();
				});
			});

		new Setting(containerEl).setName("Модель").addDropdown((d) => {
			for (const [id, label] of Object.entries(MODELS)) d.addOption(id, label);
			d.setValue(s.model).onChange(async (v) => {
				s.model = v;
				this.plugin.agent.reset();
				await save();
			});
		});

		new Setting(containerEl)
			.setName("Глубина размышлений")
			.setDesc("Выше — умнее, но медленнее и дороже. Для повседневных дел хватает «средней».")
			.addDropdown((d) =>
				d
					.addOptions({ low: "Низкая (быстро)", medium: "Средняя", high: "Высокая", xhigh: "Очень высокая" })
					.setValue(s.effort)
					.onChange(async (v) => {
						s.effort = v;
						await save();
					}),
			);

		new Setting(containerEl).setName("Имя ассистента").addText((t) =>
			t.setValue(s.assistantName).onChange(async (v) => {
				s.assistantName = v.trim() || "Джарвис";
				await save();
			}),
		);
		new Setting(containerEl).setName("Как обращаться ко мне").addText((t) =>
			t.setValue(s.userAddress).onChange(async (v) => {
				s.userAddress = v.trim();
				await save();
			}),
		);

		const toggle = (name: string, desc: string, key: keyof JarvisSettings) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(s[key] as boolean).onChange(async (v) => {
						(s as any)[key] = v;
						await save();
					}),
				);

		toggle("Интернет", "Поиск и чтение веб-страниц (погода, новости, факты).", "webTools");
		toggle("Озвучивать ответы", "Читать ответы вслух голосом iOS.", "speakReplies");
		toggle("Сохранять диалоги", `В «${PATHS.chatsDir}/» — для памяти и самоулучшения.`, "saveChats");
		toggle(
			"Спрашивать перед изменением своих правил",
			"Если выключено — Джарвис улучшает себя сам (всё логируется и бэкапится).",
			"confirmSelfEdits",
		);
		toggle("Открывать «Главную» при запуске", "", "openHomeOnStart");
		toggle("Утренний брифинг", "Автоматически при первом открытии за день.", "autoBriefing");

		containerEl.createEl("h3", { text: "Плагины" });
		for (const p of KNOWN_PLUGINS) {
			const on = isPluginEnabled(this.app, p.id);
			new Setting(containerEl)
				.setName(p.name)
				.setDesc(p.why)
				.addButton((b) =>
					b
						.setButtonText(on ? "Установлен" : "Установить")
						.setDisabled(on)
						.onClick(async () => {
							b.setDisabled(true).setButtonText("…");
							try {
								new Notice(await installPlugin(this.app, p.id));
							} catch (e) {
								new Notice((e as Error).message);
							}
							this.display();
						}),
				);
		}

		containerEl.createEl("h3", { text: "Siri и Команды iOS" });
		containerEl.createEl("p", {
			text: "Спросить: obsidian://jarvis?q=ТЕКСТ · Записать во «Входящие»: obsidian://jarvis?capture=ТЕКСТ. Подробная инструкция — в README хранилища.",
		});
	}
}
