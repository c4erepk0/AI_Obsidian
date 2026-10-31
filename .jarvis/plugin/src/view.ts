import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon, moment } from "obsidian";
import type JarvisPlugin from "./main";
import { humanError } from "./api";
import { Skill, buildSystem, expandSkill, loadSkills } from "./prompt";
import { PATHS } from "./settings";
import { FeedbackModal } from "./modals";

export const VIEW_TYPE = "jarvis-chat";

const QUICK: { label: string; text: string }[] = [
	{ label: "☀️ Брифинг", text: "/brief" },
	{ label: "📥 Входящие", text: "/inbox" },
	{ label: "📓 День", text: "/daily" },
	{ label: "📊 Неделя", text: "/weekly" },
	{ label: "🧠 Улучшись", text: "/improve" },
];

export class JarvisView extends ItemView {
	private listEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private busy = false;
	private stopRequested = false;
	private skills: Skill[] = [];
	private lastUserText = "";

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: JarvisPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return this.plugin.settings.assistantName;
	}
	getIcon() {
		return "bot";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("jarvis-root");

		const header = root.createDiv("jarvis-header");
		header.createDiv({ cls: "jarvis-title", text: `◉ ${this.plugin.settings.assistantName}` });
		const actions = header.createDiv("jarvis-header-actions");
		const newBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Новый диалог" } });
		setIcon(newBtn, "plus");
		newBtn.onclick = () => this.newChat();
		const speakBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Озвучивать ответы" } });
		const updSpeak = () => {
			setIcon(speakBtn, this.plugin.settings.speakReplies ? "volume-2" : "volume-x");
		};
		updSpeak();
		speakBtn.onclick = async () => {
			this.plugin.settings.speakReplies = !this.plugin.settings.speakReplies;
			await this.plugin.saveSettings();
			if (!this.plugin.settings.speakReplies) window.speechSynthesis?.cancel();
			updSpeak();
		};

		this.listEl = root.createDiv("jarvis-messages");

		const quick = root.createDiv("jarvis-quick");
		for (const q of QUICK) {
			const b = quick.createEl("button", { text: q.label, cls: "jarvis-chip" });
			b.onclick = () => this.send(q.text);
		}

		const form = root.createDiv("jarvis-input");
		this.inputEl = form.createEl("textarea", {
			attr: { placeholder: "Спроси или поручи что-нибудь… (/ — навыки, 🎤 — диктовка на клавиатуре)", rows: "2" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !(e as any).isComposing && !this.plugin.isMobile()) {
				e.preventDefault();
				this.submit();
			}
		});
		this.sendBtn = form.createEl("button", { cls: "jarvis-send mod-cta" });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.onclick = () => (this.busy ? this.requestStop() : this.submit());

		this.statusEl = root.createDiv("jarvis-status");
		this.greet();
	}

	async onClose() {
		window.speechSynthesis?.cancel();
	}

	private greet() {
		const s = this.plugin.settings;
		const h = new Date().getHours();
		const part = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
		const who = s.userAddress ? `, ${s.userAddress}` : "";
		const msg = s.apiKey
			? `${part}${who}. Я на связи. Чем займёмся?`
			: `${part}${who}. Чтобы я заработал, укажи API-ключ: Настройки → ${s.assistantName}.`;
		this.addBubble("assistant", msg, false);
	}

	newChat() {
		if (this.busy) return;
		this.plugin.agent.reset();
		this.listEl.empty();
		this.statusEl.setText("");
		this.greet();
	}

	private requestStop() {
		this.stopRequested = true;
		this.statusEl.setText("Останавливаюсь после текущего шага…");
	}

	private submit() {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		this.send(text);
	}

	focusInput() {
		this.inputEl?.focus();
	}

	private addBubble(role: "user" | "assistant", text: string, withFeedback: boolean): HTMLElement {
		const el = this.listEl.createDiv(`jarvis-msg jarvis-${role}`);
		const body = el.createDiv("jarvis-body");
		if (role === "assistant") MarkdownRenderer.render(this.app, text, body, "", this);
		else body.setText(text);
		if (withFeedback) this.addFeedback(el, text);
		this.scroll();
		return el;
	}

	private addFeedback(el: HTMLElement, answer: string) {
		const bar = el.createDiv("jarvis-feedback");
		const request = this.lastUserText;
		const mk = (icon: string, label: string, fn: () => void) => {
			const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = fn;
			return b;
		};
		mk("copy", "Скопировать", () => {
			navigator.clipboard?.writeText(answer);
			new Notice("Скопировано");
		});
		mk("volume-2", "Озвучить", () => this.plugin.speak(answer, true));
		mk("thumbs-up", "Хороший ответ", async () => {
			await this.plugin.logFeedback("👍", request, "");
			bar.addClass("jarvis-rated");
			new Notice("Спасибо! Учту.");
		});
		mk("thumbs-down", "Плохой ответ", () => {
			new FeedbackModal(this.app, async (reason) => {
				await this.plugin.logFeedback("👎", request, reason);
				bar.addClass("jarvis-rated");
				new Notice("Записал. Исправлюсь — урок попадёт в мои правила.");
			}).open();
		});
	}

	private scroll() {
		this.listEl.scrollTop = this.listEl.scrollHeight;
	}

	/** Главная точка входа: сообщение или /навык. */
	async send(raw: string) {
		const s = this.plugin.settings;
		if (this.busy) {
			new Notice("Подожди, я ещё работаю над прошлым запросом");
			return;
		}
		if (!s.apiKey) {
			this.plugin.openOnboarding();
			return;
		}
		this.busy = true;
		this.stopRequested = false;
		setIcon(this.sendBtn, "square");
		this.lastUserText = raw;
		this.addBubble("user", raw, false);

		const working = this.listEl.createDiv("jarvis-msg jarvis-assistant jarvis-working");
		const activity = working.createDiv("jarvis-activity");
		const answerEl = working.createDiv("jarvis-body");
		const thinking = activity.createDiv({ cls: "jarvis-thinking", text: "Думаю…" });
		this.scroll();

		try {
			const agent = this.plugin.agent;
			if (!agent.system || !this.skills.length) this.skills = await loadSkills(this.plugin.fs);
			if (!agent.system) agent.system = await buildSystem(this.plugin.fs, s, this.skills);

			let text = raw;
			const m = raw.match(/^\/([\p{L}\p{N}_-]+)\s*([\s\S]*)$/u);
			if (m) {
				const skill = this.skills.find((k) => k.name.toLowerCase() === m[1].toLowerCase());
				if (skill) text = await expandSkill(this.plugin.fs, skill, m[2]);
			}
			const active = this.app.workspace.getActiveFile();
			const now = moment().locale("ru").format("dd, DD.MM.YYYY HH:mm");
			const stamp = `[Сейчас: ${now}${active ? `; открыта заметка: ${active.path}` : ""}]`;

			const final = await agent.run(`${stamp}\n${text}`, {
				onText: (t) => {
					answerEl.empty();
					MarkdownRenderer.render(this.app, t, answerEl, "", this);
					this.scroll();
				},
				onActivity: (line) => {
					activity.createDiv({ cls: "jarvis-activity-line", text: line });
					this.scroll();
				},
				onUsage: (u) => {
					const k = (n?: number) => `${Math.round((n ?? 0) / 100) / 10}k`;
					this.statusEl.setText(
						`↑${k((u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0))} · кэш ${k(u?.cache_read_input_tokens)} · ↓${k(u?.output_tokens)}`,
					);
				},
				shouldStop: () => this.stopRequested,
			});
			thinking.remove();
			working.removeClass("jarvis-working");
			if (final) {
				this.addFeedback(working, final);
				this.plugin.speak(final);
				await this.plugin.saveChat(raw, final);
			} else if (!activity.childElementCount) answerEl.setText("(пустой ответ)");
			if (agent.lastInputTokens > 400000)
				this.statusEl.setText("Диалог стал очень длинным и дорогим — нажми «+», чтобы начать новый.");
		} catch (e) {
			thinking.remove();
			working.removeClass("jarvis-working");
			answerEl.createDiv({ cls: "jarvis-error", text: humanError(e) });
			console.error("Jarvis", e);
		} finally {
			this.busy = false;
			setIcon(this.sendBtn, "arrow-up");
			this.scroll();
		}
	}
}
