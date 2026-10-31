import { Block } from "./api";
import { VaultFS } from "./vaultfs";
import { JarvisSettings, PATHS } from "./settings";

export interface Skill {
	name: string;
	description: string;
	path: string;
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!m) return { meta: {}, body: text };
	const meta: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { meta, body: text.slice(m[0].length) };
}

/** Навыки = команды Claude Code (.claude/commands) + навыки Джарвиса (90 Система/Навыки). */
export async function loadSkills(fs: VaultFS): Promise<Skill[]> {
	const skills = new Map<string, Skill>();
	for (const dir of [PATHS.commandsDir, PATHS.skillsDir]) {
		let files: string[] = [];
		try {
			files = await fs.list(dir, false);
		} catch {
			continue;
		}
		for (const path of files) {
			if (!path.endsWith(".md")) continue;
			const name = path.split("/").pop()!.replace(/\.md$/, "");
			const text = (await fs.readIfExists(path)) ?? "";
			const { meta } = parseFrontmatter(text);
			skills.set(name, { name, path, description: meta.description || "" });
		}
	}
	return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function expandSkill(fs: VaultFS, skill: Skill, args: string): Promise<string> {
	const text = await fs.read(skill.path);
	const { body } = parseFrontmatter(text);
	return `Выполни навык /${skill.name} (файл \`${skill.path}\`).\n\n${body.replace(/\$ARGUMENTS/g, args || "(нет)")}`;
}

function clip(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + "\n…[обрезано]" : s;
}

const BASE = (s: JarvisSettings) => `Ты — ${s.assistantName}, личный ИИ-ассистент владельца этого хранилища Obsidian (в духе J.A.R.V.I.S.: спокойный, остроумный, предельно компетентный и на шаг впереди).
${s.userAddress ? `Обращайся к владельцу: «${s.userAddress}».` : ""}
Ты работаешь внутри приложения Obsidian (часто на iPhone) и полностью управляешь хранилищем через инструменты: list_files, read_file, search, write_file, edit_file, append_file, move_file, archive_file, open_note, install_plugin${s.webTools ? ", а также web_search / web_fetch для информации из интернета" : ""}.

# Как работать
- Твоя главная цель — знать всё, что знает владелец, держать хранилище в идеальном порядке и помогать ему принимать лучшие решения и улучшать жизнь.
- Сначала ищи ответ в хранилище (search, read_file), потом отвечай. Ссылайся на заметки как [[Название]].
- Действуй сам: если просят что-то сделать в хранилище — делай, а не объясняй, как сделать. Сообщай кратко, что сделал.
- Если в инструкциях из файлов упоминаются инструменты Claude Code (Read, Grep, Glob, Edit, Write, Bash) — используй их аналоги: read_file, search, list_files, edit_file, write_file.
- Отвечай на языке владельца (обычно по-русски). Пиши коротко: ответ читают на телефоне. Без воды, по делу, с конкретикой.
- Удалять заметки нельзя — только archive_file. Не записывай пароли, номера карт и коды доступа.
- В начале каждого сообщения владельца есть служебная строка [Сейчас: …] — это текущая дата/время и открытая заметка.

# Память
Всё новое и важное о владельце (факты, предпочтения, цели, люди, решения) сразу записывай в папку «${PATHS.memoryDir}/» по правилам из CLAUDE.md. Не спрашивай разрешения на запись фактов — просто кратко упомяни «запомнил».

# Самоулучшение
Ты умеешь улучшать себя, редактируя собственные правила:
- «${PATHS.persona}» — твоя личность, стиль и раздел «Уроки». Когда владелец тебя поправляет, недоволен ответом или ты замечаешь, что можно работать лучше, — добавь урок (одна строка с датой) в раздел «Уроки».
- «${PATHS.skillsDir}/» — твои навыки (сценарии). Если владелец просит что-то повторяющееся — создай навык: файл «имя.md» с frontmatter \`description:\` и пошаговой инструкцией, где \`$ARGUMENTS\` — текст после команды. Навык вызывается как /имя.
- «${PATHS.claudeMd}» — общие правила хранилища (их читает и Claude Code на компьютере). Меняй осторожно и только когда это явно улучшает работу.
- Каждое такое изменение делай с полем reason — оно попадает в «${PATHS.improvements}».
- Отзывы владельца (👍/👎) приходят в «${PATHS.feedback}» — учитывай их.`;

/** Собирает системный промпт: стабильная база + снимок хранилища (кэшируется). */
export async function buildSystem(fs: VaultFS, s: JarvisSettings, skills: Skill[]): Promise<Block[]> {
	const parts: string[] = [];
	const add = async (title: string, path: string, max = 20000) => {
		const t = await fs.readIfExists(path);
		if (t && t.trim()) parts.push(`## ${title} — \`${path}\`\n${clip(t.trim(), max)}`);
	};
	await add("Общие правила хранилища", PATHS.claudeMd, 30000);
	await add("Твоя личность и уроки", PATHS.persona, 20000);

	// Память о владельце
	try {
		const mem = (await fs.list(PATHS.memoryDir, false)).filter((p) => p.endsWith(".md"));
		for (const p of mem) await add("Память", p, 15000);
	} catch {
		parts.push(`## Память\n(папка «${PATHS.memoryDir}» пока пуста — предложи владельцу пройти /interview)`);
	}

	// Последние отзывы
	const fb = await fs.readIfExists(PATHS.feedback);
	if (fb) {
		const lines = fb.split("\n").filter((l) => l.startsWith("- "));
		if (lines.length) parts.push(`## Последние отзывы владельца\n${lines.slice(-30).join("\n")}`);
	}

	if (skills.length)
		parts.push(
			`## Доступные навыки (владелец вызывает их как /имя; файл можно прочитать и выполнить и по обычной просьбе)\n` +
				skills.map((k) => `- /${k.name} — ${k.description || "без описания"} (\`${k.path}\`)`).join("\n"),
		);

	// Карта хранилища верхнего уровня
	try {
		const top = await fs.list("", false);
		parts.push(`## Корень хранилища\n${top.join("\n")}`);
	} catch {
		/* ignore */
	}

	return [
		{ type: "text", text: BASE(s) },
		{
			type: "text",
			text: `# Снимок хранилища на начало диалога\n\n${parts.join("\n\n")}`,
			cache_control: { type: "ephemeral" },
		},
	];
}
