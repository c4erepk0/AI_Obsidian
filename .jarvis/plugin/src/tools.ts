import { App, TFile, moment } from "obsidian";
import { ToolDef } from "./api";
import { VaultFS } from "./vaultfs";
import { PATHS, isSelfPath } from "./settings";
import { KNOWN_PLUGINS, installPlugin } from "./plugins";

export interface ToolContext {
	app: App;
	fs: VaultFS;
	confirm: (title: string, body: string) => Promise<boolean>;
	confirmSelfEdits: () => boolean;
}

const MAX_READ = 60000;

const reasonProp = {
	reason: {
		type: "string",
		description: "Зачем это изменение (одной фразой). Обязательно при изменении собственных правил и навыков.",
	},
};

export const TOOL_DEFS: ToolDef[] = [
	{
		name: "list_files",
		description:
			"Показать файлы и папки хранилища. Папки заканчиваются на '/'. Пустой folder — корень. Скрытые пути (.claude/commands) тоже можно.",
		input_schema: {
			type: "object",
			properties: {
				folder: { type: "string", description: "Папка, например '02 Проекты'. Пусто — корень." },
				recursive: { type: "boolean", description: "Показать и вложенные папки. По умолчанию false." },
			},
		},
	},
	{
		name: "read_file",
		description: "Прочитать файл целиком по пути (например '10 Я/Профиль.md').",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "search",
		description:
			"Полнотекстовый поиск по заметкам (без учёта регистра). Ищет и в именах файлов, и в тексте. Возвращает пути и строки с совпадениями. Несколько слов через '|' — ищет любое из них.",
		input_schema: {
			type: "object",
			properties: {
				query: { type: "string" },
				folder: { type: "string", description: "Ограничить поиск папкой (необязательно)." },
				limit: { type: "integer", description: "Максимум файлов, по умолчанию 20." },
			},
			required: ["query"],
		},
	},
	{
		name: "write_file",
		description:
			"Создать заметку или полностью перезаписать существующую (нужно overwrite=true; старая версия сохраняется в резервной копии). Папки создаются автоматически.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
				overwrite: { type: "boolean" },
				...reasonProp,
			},
			required: ["path", "content"],
		},
	},
	{
		name: "edit_file",
		description:
			"Точечная правка: заменить фрагмент old_text (должен встречаться ровно один раз) на new_text. Предпочтительнее перезаписи.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_text: { type: "string" },
				new_text: { type: "string" },
				...reasonProp,
			},
			required: ["path", "old_text", "new_text"],
		},
	},
	{
		name: "append_file",
		description: "Дописать текст в конец заметки (создаст её, если нет). Удобно для дневника, журналов, памяти.",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" }, text: { type: "string" }, ...reasonProp },
			required: ["path", "text"],
		},
	},
	{
		name: "move_file",
		description: "Переместить или переименовать заметку/папку. Ссылки [[...]] на неё обновятся автоматически.",
		input_schema: {
			type: "object",
			properties: { from: { type: "string" }, to: { type: "string" } },
			required: ["from", "to"],
		},
	},
	{
		name: "archive_file",
		description: "Убрать заметку в архив (05 Архив/…). Удалять заметки нельзя — только архивировать.",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "open_note",
		description: "Открыть заметку на экране владельца (например, чтобы показать результат).",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "install_plugin",
		description: `Установить и включить плагин Obsidian из списка проверенных: ${KNOWN_PLUGINS.map((p) => `${p.id} (${p.why})`).join("; ")}. Владелец подтверждает установку.`,
		input_schema: {
			type: "object",
			properties: { id: { type: "string", enum: KNOWN_PLUGINS.map((p) => p.id) } },
			required: ["id"],
		},
	},
];

/** Человекочитаемая строка для ленты действий в чате. */
export function describeToolCall(name: string, input: any): string {
	const p = input?.path ?? "";
	switch (name) {
		case "list_files":
			return `📂 смотрю папку ${input?.folder || "/"}`;
		case "read_file":
			return `📖 читаю ${p}`;
		case "search":
			return `🔎 ищу «${input?.query}»`;
		case "write_file":
			return `✍️ пишу ${p}`;
		case "edit_file":
			return `✏️ правлю ${p}`;
		case "append_file":
			return `➕ дописываю ${p}`;
		case "move_file":
			return `📦 ${input?.from} → ${input?.to}`;
		case "archive_file":
			return `🗄 в архив: ${p}`;
		case "open_note":
			return `👁 открываю ${p}`;
		case "install_plugin":
			return `🧩 устанавливаю плагин ${input?.id}`;
		default:
			return `🔧 ${name}`;
	}
}

async function logSelfEdit(ctx: ToolContext, path: string, action: string, reason?: string) {
	const line = `- (${moment().format("YYYY-MM-DD HH:mm")}) **${action}** \`${path}\` — ${reason || "без пояснения"}\n`;
	await ctx.fs.append(PATHS.improvements, line);
}

async function guardWrite(ctx: ToolContext, path: string, preview: string): Promise<string | null> {
	if (ctx.fs.isConfigPath(path))
		return "Отказано: настройки Obsidian (.obsidian) напрямую менять нельзя. Для плагинов используй install_plugin.";
	if (path.startsWith(".jarvis/")) return "Отказано: служебная папка .jarvis только для резервных копий.";
	if (isSelfPath(path) && ctx.confirmSelfEdits()) {
		const ok = await ctx.confirm(`Джарвис хочет изменить свои правила: ${path}`, preview.slice(0, 3000));
		if (!ok) return "Владелец отклонил изменение. Спроси, что именно его не устроило.";
	}
	return null;
}

function truncate(s: string, n = MAX_READ): string {
	return s.length > n ? s.slice(0, n) + `\n\n…[обрезано: показано ${n} из ${s.length} символов]` : s;
}

export async function runTool(ctx: ToolContext, name: string, input: any): Promise<string> {
	const { fs, app } = ctx;
	switch (name) {
		case "list_files": {
			const items = await fs.list(input?.folder ?? "", !!input?.recursive);
			return items.length ? items.join("\n") : "(пусто)";
		}
		case "read_file": {
			return truncate(await fs.read(input.path));
		}
		case "search": {
			const terms = String(input.query || "")
				.toLowerCase()
				.split("|")
				.map((t) => t.trim())
				.filter(Boolean);
			if (!terms.length) throw new Error("Пустой запрос");
			const limit = Math.min(Number(input.limit) || 20, 50);
			const results: string[] = [];
			for (const f of fs.markdownFiles(input.folder)) {
				if (results.length >= limit) break;
				const nameHit = terms.some((t) => f.path.toLowerCase().includes(t));
				const text = await app.vault.cachedRead(f);
				const lines = text.split("\n");
				const hits: string[] = [];
				for (let i = 0; i < lines.length && hits.length < 5; i++) {
					const l = lines[i].toLowerCase();
					if (terms.some((t) => l.includes(t))) hits.push(`  ${i + 1}: ${lines[i].trim().slice(0, 200)}`);
				}
				if (nameHit || hits.length) results.push(`${f.path}${hits.length ? "\n" + hits.join("\n") : ""}`);
			}
			return results.length ? results.join("\n") : "Ничего не найдено.";
		}
		case "write_file": {
			const path = fs.norm(input.path);
			const exists = await fs.exists(path);
			if (exists && !input.overwrite)
				return `Файл ${path} уже существует. Используй edit_file/append_file или overwrite=true.`;
			const denied = await guardWrite(ctx, path, input.content);
			if (denied) return denied;
			const bak = exists ? await fs.backup(path) : null;
			await fs.write(path, input.content);
			if (isSelfPath(path)) await logSelfEdit(ctx, path, exists ? "перезапись" : "создание", input.reason);
			return `Готово: ${path}${bak ? ` (старая версия: ${bak})` : ""}`;
		}
		case "edit_file": {
			const path = fs.norm(input.path);
			const text = await fs.read(path);
			const count = text.split(input.old_text).length - 1;
			if (count === 0) return "Фрагмент old_text не найден. Перечитай файл и повтори точно.";
			if (count > 1) return `Фрагмент встречается ${count} раз — добавь больше контекста, чтобы он был уникален.`;
			const denied = await guardWrite(ctx, path, `Было:\n${input.old_text}\n\nСтанет:\n${input.new_text}`);
			if (denied) return denied;
			await fs.backup(path);
			await fs.write(path, text.replace(input.old_text, () => input.new_text));
			if (isSelfPath(path)) await logSelfEdit(ctx, path, "правка", input.reason);
			return `Готово: ${path}`;
		}
		case "append_file": {
			const path = fs.norm(input.path);
			const denied = await guardWrite(ctx, path, input.text);
			if (denied) return denied;
			await fs.append(path, input.text);
			if (isSelfPath(path)) await logSelfEdit(ctx, path, "дополнение", input.reason);
			return `Готово: ${path}`;
		}
		case "move_file": {
			const from = fs.norm(input.from);
			const to = fs.norm(input.to);
			if (fs.isConfigPath(from) || fs.isConfigPath(to)) return "Отказано: .obsidian трогать нельзя.";
			await fs.move(from, to);
			return `Перемещено: ${from} → ${to}`;
		}
		case "archive_file": {
			const from = fs.norm(input.path);
			if (from.startsWith(PATHS.archive + "/")) return "Уже в архиве.";
			let to = `${PATHS.archive}/${from}`;
			if (await fs.exists(to)) to = to.replace(/(\.md)?$/, ` (${moment().format("YYYY-MM-DD HHmm")})$1`);
			await fs.move(from, to);
			return `В архиве: ${to}`;
		}
		case "open_note": {
			const f = app.vault.getAbstractFileByPath(fs.norm(input.path));
			if (!(f instanceof TFile)) return "Заметка не найдена.";
			await app.workspace.getLeaf(false).openFile(f);
			return "Открыто.";
		}
		case "install_plugin": {
			const p = KNOWN_PLUGINS.find((k) => k.id === input.id);
			if (!p) return `Неизвестный плагин. Доступны: ${KNOWN_PLUGINS.map((k) => k.id).join(", ")}`;
			const ok = await ctx.confirm(`Установить плагин «${p.name}»?`, `Зачем: ${p.why}\nИсточник: github.com/${p.repo}`);
			if (!ok) return "Владелец отказался от установки.";
			return await installPlugin(app, p.id);
		}
		default:
			throw new Error(`Неизвестный инструмент: ${name}`);
	}
}
