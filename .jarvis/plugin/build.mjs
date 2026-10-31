// Сборка плагина Джарвиса.
//   node build.mjs           → dist/ (main.js, manifest.json, styles.css)
//   node build.mjs --install → ещё и копирует в ../../.obsidian/plugins/jarvis
// Стартовая структура хранилища (память, шаблоны, навыки) встраивается в
// main.js, чтобы плагин мог развернуть её в любом хранилище — даже на iPhone.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const vault = path.resolve(here, "../..");

// Что входит в стартовую структуру (пути относительно корня хранилища)
const INCLUDE = [
  "CLAUDE.md",
  "Главная.md",
  "10 Я",
  "03 Сферы",
  "90 Шаблоны",
  "90 Система/Джарвис.md",
  "90 Система/Журнал улучшений.md",
  "90 Система/Обратная связь.md",
  "90 Система/Навыки",
  ".claude/commands",
];
const EMPTY_FOLDERS = ["00 Входящие", "01 Дневник", "02 Проекты", "04 Знания", "05 Архив", "90 Система/Диалоги"];

const starter = {};
const addFile = (rel) => {
  if (rel.endsWith(".md")) starter[rel] = fs.readFileSync(path.join(vault, rel), "utf8");
};
const walk = (rel) => {
  const abs = path.join(vault, rel);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(`${rel}/${n}`);
  else addFile(rel);
};
INCLUDE.forEach(walk);
for (const f of EMPTY_FOLDERS) starter[`${f}/.keep`] = "";
fs.writeFileSync(
  path.join(here, "src/starter.generated.ts"),
  "// Сгенерировано build.mjs — не редактировать вручную.\nexport const STARTER: Record<string, string> = " +
    JSON.stringify(starter, null, 1) + ";\n",
);
console.log(`Стартовая структура: ${Object.keys(starter).length} файлов`);

const dist = path.join(here, "dist");
fs.mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(here, "src/main.ts")],
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "browser",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  outfile: path.join(dist, "main.js"),
  minify: false,
  legalComments: "none",
  banner: { js: "/* Джарвис — ИИ-ассистент для Obsidian. Исходники: .jarvis/plugin/src */" },
});
fs.copyFileSync(path.join(here, "manifest.json"), path.join(dist, "manifest.json"));
fs.copyFileSync(path.join(here, "styles.css"), path.join(dist, "styles.css"));
console.log("Собрано в dist/");

if (process.argv.includes("--install")) {
  const target = path.join(vault, ".obsidian/plugins/jarvis");
  fs.mkdirSync(target, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(dist, f), path.join(target, f));
  console.log("Установлено в .obsidian/plugins/jarvis");
}
