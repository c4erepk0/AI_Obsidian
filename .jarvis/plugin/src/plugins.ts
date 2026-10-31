import { App, requestUrl } from "obsidian";

/**
 * Проверенные плагины, которые Джарвис может поставить сам (только из этого
 * списка — произвольный код из интернета он устанавливать не может).
 */
export interface KnownPlugin {
	id: string;
	repo: string;
	name: string;
	why: string;
	recommended: boolean;
}

export const KNOWN_PLUGINS: KnownPlugin[] = [
	{
		id: "dataview",
		repo: "blacksmithgu/obsidian-dataview",
		name: "Dataview",
		why: "живые таблицы на «Главной»: активные проекты, задачи, свежие заметки",
		recommended: true,
	},
	{
		id: "obsidian-tasks-plugin",
		repo: "obsidian-tasks-group/obsidian-tasks",
		name: "Tasks",
		why: "задачи со сроками 📅 и списки «на сегодня / просрочено»",
		recommended: true,
	},
	{
		id: "calendar",
		repo: "liamcain/obsidian-calendar-plugin",
		name: "Calendar",
		why: "календарь для навигации по дневнику",
		recommended: true,
	},
	{
		id: "obsidian-git",
		repo: "Vinzent03/obsidian-git",
		name: "Obsidian Git",
		why: "синхронизация с GitHub (чтобы работал и Claude Code на компьютере/в облаке)",
		recommended: false,
	},
	{
		id: "templater-obsidian",
		repo: "SilentVoid13/Templater",
		name: "Templater",
		why: "продвинутые шаблоны с датами и скриптами",
		recommended: false,
	},
];

async function download(url: string): Promise<string | null> {
	const res = await requestUrl({ url, method: "GET", throw: false });
	if (res.status !== 200) return null;
	return res.text;
}

/** Скачивает последний релиз плагина с GitHub и включает его. */
export async function installPlugin(app: App, id: string): Promise<string> {
	const p = KNOWN_PLUGINS.find((k) => k.id === id);
	if (!p) throw new Error(`Плагин «${id}» не в списке проверенных: ${KNOWN_PLUGINS.map((k) => k.id).join(", ")}`);
	const base = `https://github.com/${p.repo}/releases/latest/download`;
	const manifest = await download(`${base}/manifest.json`);
	const main = await download(`${base}/main.js`);
	if (!manifest || !main) throw new Error(`Не удалось скачать ${p.name}. Проверь интернет.`);
	const styles = await download(`${base}/styles.css`);
	const dir = `${app.vault.configDir}/plugins/${p.id}`;
	const ad = app.vault.adapter;
	if (!(await ad.exists(`${app.vault.configDir}/plugins`))) await ad.mkdir(`${app.vault.configDir}/plugins`);
	if (!(await ad.exists(dir))) await ad.mkdir(dir);
	await ad.write(`${dir}/manifest.json`, manifest);
	await ad.write(`${dir}/main.js`, main);
	if (styles) await ad.write(`${dir}/styles.css`, styles);

	const plugins = (app as any).plugins;
	await plugins?.loadManifests?.();
	await plugins?.enablePluginAndSave?.(p.id);
	return `${p.name} установлен и включён`;
}

export function isPluginEnabled(app: App, id: string): boolean {
	return !!(app as any).plugins?.enabledPlugins?.has?.(id);
}
