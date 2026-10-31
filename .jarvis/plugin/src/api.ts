import { requestUrl } from "obsidian";

/**
 * Минимальный клиент Messages API поверх Obsidian requestUrl.
 * requestUrl — нативный запрос Obsidian: работает на iPhone без CORS-ограничений,
 * поэтому здесь не используется SDK (он опирается на fetch браузера).
 */

export type Block = { type: string; [k: string]: any };
export type ToolDef = Record<string, any>;
export type Msg = { role: "user" | "assistant"; content: string | Block[] };

export interface ApiResponse {
	id: string;
	content: Block[];
	stop_reason: string | null;
	stop_details?: { category?: string | null; explanation?: string } | null;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

export interface CallOptions {
	apiKey: string;
	model: string;
	effort: string;
	system: Block[];
	tools: ToolDef[];
	messages: Msg[];
	webTools: boolean;
	maxTokens?: number;
}

export const MODELS: Record<string, string> = {
	"claude-opus-5-5": "Claude Opus 5.5 — самый умный (по умолчанию)",
	"claude-sonnet-5-5": "Claude Sonnet 5.5 — быстрее и в 2 раза дешевле",
	"claude-haiku-5-5": "Claude Haiku 5.5 — очень быстрый и дешёвый",
};

/** Модели, поддерживающие серверный fallback при отказе классификатора. */
function supportsFallbacks(model: string) {
	return model === "claude-opus-5-5" || model === "claude-sonnet-5-5";
}

/** Веб-поиск/чтение страниц — серверные инструменты Anthropic. */
export function webToolDefs(model: string): ToolDef[] {
	const modern = model.startsWith("claude-opus") || model.startsWith("claude-sonnet");
	return modern
		? [
				{ type: "web_search_20260209", name: "web_search", max_uses: 5 },
				{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
			]
		: [
				{ type: "web_search_20250305", name: "web_search", max_uses: 5 },
				{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
			];
}

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(body: any, apiKey: string, betas: string[]): Promise<ApiResponse> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-api-key": apiKey,
		"anthropic-version": "2026-10-21",
		"anthropic-dangerous-direct-browser-access": "true",
	};
	if (betas.length) headers["anthropic-beta"] = betas.join(",");
	const res = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		headers,
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status >= 200 && res.status < 300) return res.json as ApiResponse;
	let msg = `HTTP ${res.status}`;
	try {
		const j = res.json;
		if (j?.error?.message) msg += `: ${j.error.message}`;
	} catch {
		/* тело не JSON */
	}
	throw new ApiError(res.status, msg);
}

/**
 * Один запрос к модели с повторами при перегрузке (429/5xx).
 * Если сервер отклонил запрос (400) из-за необязательных функций
 * (fallbacks, веб-инструменты, автокэш) — повторяем в «безопасном» режиме.
 */
export async function callClaude(o: CallOptions): Promise<ApiResponse> {
	const build = (safe: boolean) => {
		const tools = [...o.tools];
		if (o.webTools && !safe) tools.push(...webToolDefs(o.model));
		const body: any = {
			model: o.model,
			max_tokens: o.maxTokens ?? 16000,
			system: o.system,
			tools,
			messages: o.messages,
			output_config: { effort: o.effort },
		};
		const betas: string[] = [];
		if (!safe) {
			// автоматический кэш: точка кэша ставится на последний блок истории
			body.cache_control = { type: "ephemeral" };
			if (supportsFallbacks(o.model)) {
				body.fallbacks = "default";
				betas.push("server-side-fallback-2026-07-01");
			}
		}
		return { body, betas };
	};

	let safe = false;
	let attempt = 0;
	for (;;) {
		const { body, betas } = build(safe);
		try {
			return await post(body, o.apiKey, betas);
		} catch (e) {
			if (!(e instanceof ApiError)) {
				// сетевая ошибка (нет интернета и т.п.)
				if (attempt++ < 2) {
					await sleep(1500 * attempt);
					continue;
				}
				throw e;
			}
			if (e.status === 400 && !safe && !/prompt is too long|too many tokens/i.test(e.message)) {
				safe = true;
				continue;
			}
			if ((e.status === 429 || e.status >= 500) && attempt++ < 3) {
				await sleep(2000 * Math.pow(2, attempt));
				continue;
			}
			throw e;
		}
	}
}

export function humanError(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.status === 401) return "Неверный API-ключ. Проверь его в настройках Джарвиса.";
		if (e.status === 402 || /credit|billing/i.test(e.message))
			return "На аккаунте Anthropic закончились средства. Пополни баланс на console.anthropic.com.";
		if (e.status === 429) return "Слишком много запросов. Подожди минуту и попробуй снова.";
		if (e.status === 529 || e.status >= 500) return "Сервер Claude перегружен. Попробуй чуть позже.";
		return `Ошибка API: ${e.message}`;
	}
	return `Ошибка: ${(e as Error)?.message ?? String(e)}`;
}
