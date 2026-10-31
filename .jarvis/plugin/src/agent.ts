import { Block, Msg, callClaude, ApiResponse } from "./api";
import { TOOL_DEFS, ToolContext, describeToolCall, runTool } from "./tools";
import { JarvisSettings } from "./settings";

export interface AgentEvents {
	onText: (text: string) => void;
	onActivity: (line: string) => void;
	onUsage: (u: ApiResponse["usage"]) => void;
	shouldStop: () => boolean;
}

const MAX_STEPS = 30;

/**
 * Цикл агента: запрос → (инструменты → результаты)* → финальный ответ.
 * История только дописывается (никогда не редактируется), как требует API
 * для блоков рассуждений.
 */
export class Agent {
	messages: Msg[] = [];
	system: Block[] | null = null;
	lastInputTokens = 0;

	constructor(
		private getSettings: () => JarvisSettings,
		private ctx: ToolContext,
	) {}

	reset() {
		this.messages = [];
		this.system = null;
		this.lastInputTokens = 0;
	}

	async run(userText: string, ev: AgentEvents): Promise<string> {
		const s = this.getSettings();
		if (!this.system) throw new Error("system prompt not built");
		const last = this.messages[this.messages.length - 1];
		if (last && last.role === "user") {
			// прошлый запуск прервался до ответа модели — дописываем в то же сообщение
			// (оно ещё не было отправлено, так что история не «переписывается»)
			const blocks: Block[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
			blocks.push({ type: "text", text: userText });
			last.content = blocks;
		} else this.messages.push({ role: "user", content: userText });
		let finalText = "";

		for (let step = 0; step < MAX_STEPS; step++) {
			if (ev.shouldStop()) {
				ev.onActivity("⏹ остановлено");
				// история должна заканчиваться корректно: если ждали результатов
				// инструментов — они уже добавлены ниже, так что просто выходим
				break;
			}
			const res = await callClaude({
				apiKey: s.apiKey,
				model: s.model,
				effort: s.effort,
				system: this.system,
				tools: TOOL_DEFS,
				messages: this.messages,
				webTools: s.webTools,
			});
			ev.onUsage(res.usage);
			this.lastInputTokens =
				(res.usage?.input_tokens ?? 0) +
				(res.usage?.cache_read_input_tokens ?? 0) +
				(res.usage?.cache_creation_input_tokens ?? 0);
			this.messages.push({ role: "assistant", content: res.content });

			const texts: string[] = [];
			const toolUses: Block[] = [];
			for (const b of res.content) {
				if (b.type === "text" && b.text?.trim()) texts.push(b.text);
				else if (b.type === "tool_use") toolUses.push(b);
				else if (b.type === "server_tool_use")
					ev.onActivity(
						b.name === "web_search" ? `🌐 ищу в интернете: ${b.input?.query ?? ""}` : `🌐 читаю страницу ${b.input?.url ?? ""}`,
					);
			}
			if (texts.length) {
				finalText = texts.join("\n\n");
				ev.onText(finalText);
			}

			if (res.stop_reason === "tool_use" && toolUses.length) {
				const results: Block[] = [];
				for (const tu of toolUses) {
					ev.onActivity(describeToolCall(tu.name, tu.input));
					try {
						const out = await runTool(this.ctx, tu.name, tu.input ?? {});
						results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
					} catch (e) {
						const msg = (e as Error)?.message ?? String(e);
						ev.onActivity(`⚠️ ${msg}`);
						results.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
					}
				}
				this.messages.push({ role: "user", content: results });
				continue;
			}
			if (res.stop_reason === "pause_turn") continue; // сервер продолжит веб-поиск
			if (res.stop_reason === "refusal") {
				ev.onText((finalText ? finalText + "\n\n" : "") + "_Модель отказалась отвечать на этот запрос._");
			} else if (res.stop_reason === "max_tokens") {
				ev.onActivity("✂️ ответ обрезан по длине — попроси продолжить");
			}
			break;
		}
		return finalText;
	}
}
