export interface JarvisSettings {
	apiKey: string;
	model: string;
	effort: string;
	assistantName: string;
	userAddress: string;
	webTools: boolean;
	speakReplies: boolean;
	saveChats: boolean;
	confirmSelfEdits: boolean;
	openHomeOnStart: boolean;
	autoBriefing: boolean;
	lastBriefing: string;
	onboarded: boolean;
}

export const DEFAULT_SETTINGS: JarvisSettings = {
	apiKey: "",
	model: "claude-opus-5-5",
	effort: "medium",
	assistantName: "Джарвис",
	userAddress: "",
	webTools: true,
	speakReplies: false,
	saveChats: true,
	confirmSelfEdits: false,
	openHomeOnStart: true,
	autoBriefing: false,
	lastBriefing: "",
	onboarded: false,
};

/** Пути хранилища, которыми пользуется Джарвис. */
export const PATHS = {
	claudeMd: "CLAUDE.md",
	persona: "90 Система/Джарвис.md",
	skillsDir: "90 Система/Навыки",
	commandsDir: ".claude/commands",
	feedback: "90 Система/Обратная связь.md",
	improvements: "90 Система/Журнал улучшений.md",
	chatsDir: "90 Система/Диалоги",
	memoryDir: "10 Я",
	inbox: "00 Входящие",
	daily: "01 Дневник",
	archive: "05 Архив",
	home: "Главная.md",
};

/** «Собственные правила» Джарвиса: их изменение — это самоулучшение. */
export function isSelfPath(path: string): boolean {
	return (
		path === PATHS.claudeMd ||
		path === PATHS.persona ||
		path.startsWith(PATHS.skillsDir + "/") ||
		path.startsWith(".claude/")
	);
}
