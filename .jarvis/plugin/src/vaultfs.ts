import { App, TFile, TFolder, normalizePath, moment } from "obsidian";

/**
 * Работа с файлами хранилища. Обычные заметки идут через Vault API (чтобы
 * Obsidian сразу видел изменения и обновлял ссылки), скрытые пути (.claude/,
 * .jarvis/) — через adapter, т.к. Obsidian их не индексирует.
 */
export class VaultFS {
	constructor(private app: App) {}

	norm(path: string): string {
		let p = (path || "").trim().replace(/^\/+/, "").replace(/\\/g, "/");
		p = normalizePath(p);
		if (p === "/" || p === ".") return "";
		if (p.split("/").some((seg) => seg === "..")) throw new Error("Путь не может содержать '..'");
		return p;
	}

	isHidden(path: string): boolean {
		return path.split("/").some((seg) => seg.startsWith("."));
	}

	isConfigPath(path: string): boolean {
		const cfg = this.app.vault.configDir; // обычно .obsidian
		return path === cfg || path.startsWith(cfg + "/");
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(this.norm(path));
	}

	async read(path: string): Promise<string> {
		const p = this.norm(path);
		const f = this.app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) return this.app.vault.cachedRead(f);
		if (await this.app.vault.adapter.exists(p)) return this.app.vault.adapter.read(p);
		throw new Error(`Файл не найден: ${p}`);
	}

	async readIfExists(path: string): Promise<string | null> {
		try {
			return await this.read(path);
		} catch {
			return null;
		}
	}

	async ensureFolder(folder: string): Promise<void> {
		const p = this.norm(folder);
		if (!p) return;
		const parts = p.split("/");
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) {
				if (this.isHidden(cur)) await this.app.vault.adapter.mkdir(cur);
				else await this.app.vault.createFolder(cur).catch(() => this.app.vault.adapter.mkdir(cur));
			}
		}
	}

	parent(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.slice(0, i);
	}

	/** Сохраняет копию файла перед перезаписью в .jarvis/backups/ГГГГ-ММ-ДД/ */
	async backup(path: string): Promise<string | null> {
		const old = await this.readIfExists(path);
		if (old === null) return null;
		const dir = `.jarvis/backups/${moment().format("YYYY-MM-DD")}`;
		await this.ensureFolder(dir);
		const name = path.replace(/\//g, "__");
		const target = `${dir}/${moment().format("HHmmss")}__${name}`;
		await this.app.vault.adapter.write(target, old);
		return target;
	}

	async write(path: string, content: string): Promise<void> {
		const p = this.norm(path);
		await this.ensureFolder(this.parent(p));
		const f = this.app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) await this.app.vault.modify(f, content);
		else if (this.isHidden(p)) await this.app.vault.adapter.write(p, content);
		else await this.app.vault.create(p, content);
	}

	async append(path: string, text: string): Promise<void> {
		const p = this.norm(path);
		const old = await this.readIfExists(p);
		if (old === null) return this.write(p, text);
		const sep = old.endsWith("\n") || old.length === 0 ? "" : "\n";
		await this.write(p, old + sep + text);
	}

	async move(from: string, to: string): Promise<void> {
		const a = this.norm(from);
		const b = this.norm(to);
		if (await this.exists(b)) throw new Error(`Уже существует: ${b}`);
		await this.ensureFolder(this.parent(b));
		const f = this.app.vault.getAbstractFileByPath(a);
		if (f) await this.app.fileManager.renameFile(f, b); // обновляет ссылки
		else if (await this.app.vault.adapter.exists(a)) await this.app.vault.adapter.rename(a, b);
		else throw new Error(`Не найдено: ${a}`);
	}

	/** Список файлов/папок. Для скрытых путей — через adapter. */
	async list(folder: string, recursive: boolean, limit = 400): Promise<string[]> {
		const p = this.norm(folder);
		const out: string[] = [];
		if (this.isHidden(p)) {
			const walk = async (dir: string) => {
				if (out.length >= limit) return;
				const res = await this.app.vault.adapter.list(dir);
				for (const d of res.folders) {
					out.push(d + "/");
					if (recursive) await walk(d);
				}
				for (const f of res.files) out.push(f);
			};
			if (await this.app.vault.adapter.exists(p)) await walk(p);
			return out.slice(0, limit);
		}
		const root = p ? this.app.vault.getAbstractFileByPath(p) : this.app.vault.getRoot();
		if (!(root instanceof TFolder)) throw new Error(`Папка не найдена: ${p || "/"}`);
		const walk = (dir: TFolder) => {
			for (const child of dir.children) {
				if (out.length >= limit) return;
				if (child instanceof TFolder) {
					out.push(child.path + "/");
					if (recursive) walk(child);
				} else out.push(child.path);
			}
		};
		walk(root);
		return out;
	}

	markdownFiles(folder?: string): TFile[] {
		const p = folder ? this.norm(folder) : "";
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => !p || f.path === p || f.path.startsWith(p + "/"))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}
}
