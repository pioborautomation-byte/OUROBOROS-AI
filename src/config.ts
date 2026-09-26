/**
 * Konfiguracja AgentDock (`%USERPROFILE%\.agentdock\config.json`).
 *
 * Plik powstaje przy pierwszym uruchomieniu z sensownymi domyślnymi i jest
 * jedynym miejscem, w którym definiuje się agentów (presety + własne komendy).
 * Zmienne środowiskowe mają priorytet nad plikiem (`AGENTDOCK_PORT` itd.).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface AgentSpec {
	/** Krótki opis widoczny w UI. */
	description?: string;
	/**
	 * Preferencja modelu dla routera (Faza 3): `local` = rola mówi do modelu
	 * lokalnego, `cloud` = rola wymaga chmury, `null`/brak = router decyduje
	 * na podstawie złożoności zadania.
	 */
	tier?: "local" | "cloud" | null;
	/**
	 * Program do uruchomienia. `{self}` = sam AgentDock (wbudowany agent demo),
	 * więc nie trzeba nic dodatkowo instalować.
	 */
	command: string;
	/** Argumenty; placeholdery: `{prompt}`, `{promptFile}`, `{workspace}`, `{runId}`. */
	args: string[];
	/** true = prompt trafia na stdin dziecka (wygodne dla `claude --print`). */
	stdinPrompt?: boolean;
	/** Dodatkowe zmienne środowiskowe przepuszczane do dziecka (jeśli są ustawione). */
	env?: string[];
	/** Agent wbudowany — nie usuwaj, jest używany przez demo i testy. */
	builtin?: boolean;
}

export interface TierConfig {
	/** Rola używana dla tego poziomu (`null` = nie zamieniaj roli wybranej przez użytkownika). */
	agent: string | null;
	/** Model przekazywany do roli przez placeholder `{model}` (albo przez env). */
	model: string | null;
	provider: string | null;
	/** Dodatkowe zmienne środowiskowe wstrzykiwane dla tego poziomu. */
	env: Record<string, string>;
}

/**
 * Poziom lokalny (Faza 3.5).
 *
 * `agents` to **łańcuch kandydatów** w kolejności priorytetu — router wybiera
 * pierwszą rolę, której binarka faktycznie istnieje. Domyślnie: rola edytująca
 * kod (`aider-local`, model + narzędzia plikowe + własne commity), a gdy jej nie
 * ma — rola rozmawiająca (`ollama-local`).
 *
 * `chatAgent` obsługuje zadania **tylko czytające** („podsumuj”, „wyjaśnij”):
 * po co angażować silnik edycji i ryzykować ruchy w repozytorium, skoro
 * odpowiedź wystarcza w logu runu.
 */
export interface LocalTierConfig {
	readonly agents: string[];
	readonly chatAgent: string | null;
	readonly model: string | null;
	readonly provider: string | null;
	readonly baseUrl: string;
	readonly env: Record<string, string>;
}

/**
 * Smart Router (Faza 3): decyzja „model lokalny czy chmura” podejmowana
 * PRZED uruchomieniem agenta, na podstawie złożoności zadania, preferencji
 * roli, wrażliwości projektu i dostępności modelu lokalnego.
 */
export interface RoutingConfig {
	enabled: boolean;
	mode: "auto" | "local-only" | "cloud-only";
	/** `heuristic` = deterministyczne sygnały; `ollama` = pytanie do modelu lokalnego (z fallbackiem). */
	classifier: "heuristic" | "ollama";
	/** Próg: wynik >= threshold ⇒ chmura, poniżej ⇒ model lokalny. */
	threshold: number;
	/** Model lokalny używany przez klasyfikator `ollama`. */
	classifyModel: string;
	local: LocalTierConfig;
	cloud: TierConfig;
}

export interface AgentDockConfig {
	port: number;
	/** Token operatora (localhost). Generowany przy pierwszym starcie. */
	token: string;
	/** Ile runów może działać jednocześnie; reszta czeka w kolejce. */
	maxConcurrent: number;
	/** Domyślny limit pamięci jednego procesu runu (MB). */
	memoryLimitMb: number;
	/** Domyślny limit czasu runu (s). */
	timeoutSec: number;
	/** Domyślne gałęzie: prefiks gałęzi runów. */
	branchPrefix: string;
	/** Konfiguracja Smart Routera (Faza 3). */
	routing: RoutingConfig;
	agents: Record<string, AgentSpec>;
}

/** Zmienne przekazywane do każdego runu (bez sekretów) — reszta jest odcinana. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"ComSpec",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"CommonProgramFiles",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
	"LANG",
	"LC_ALL",
	"PYTHONIOENCODING",
];

/**
 * Domyślna konfiguracja routera. `local.agent` wskazuje rolę mówiącą do modelu
 * lokalnego (Ollama); jeśli Ollama nie odpowiada, router schodzi do chmury
 * z jawnym powodem — nigdy nie udaje, że model lokalny istnieje.
 */
export const DEFAULT_ROUTING: RoutingConfig = {
	enabled: true,
	mode: "auto",
	classifier: "heuristic",
	threshold: 0.5,
	classifyModel: "qwen2.5-coder:7b",
	local: {
		// Kolejność ma znaczenie: najpierw rola, która UMIE EDYTOWAĆ kod
		// (aider + model lokalny = commity w repo), potem rola rozmawiająca.
		agents: ["aider-local", "ollama-local"],
		chatAgent: "ollama-local",
		model: "qwen2.5-coder:7b",
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		env: {
			OLLAMA_API_BASE: "http://127.0.0.1:11434",
			OLLAMA_HOST: "127.0.0.1:11434",
		},
	},
	cloud: { agent: null, model: null, provider: null, env: {} },
};

export const DEFAULT_AGENTS: Record<string, AgentSpec> = {
	demo: {
		builtin: true,
		description:
			"Wbudowany agent zastępczy — nie woła modelu. Pisze plik w workspace, loguje przebieg i (opcjonalnie) commituje. Do testów i demo.",
		command: "{self}",
		args: ["--demo-agent"],
		stdinPrompt: true,
	},
	"aider-local": {
		builtin: true,
		tier: "local",
		description:
			"Model lokalny z narzędziami do edycji kodu (Aider + Ollama). Tworzy i modyfikuje pliki oraz commituje zmiany — to domyślna rola poziomu lokalnego. Wymaga `aider` w PATH i pobranego modelu.",
		command: "aider",
		args: [
			"--model",
			"ollama/{model}",
			"--yes-always",
			"--no-check-update",
			"--no-show-model-warnings",
			"--message",
			"{prompt}",
		],
	},
	"ollama-local": {
		builtin: true,
		tier: "local",
		description:
			"Model lokalny bez narzędzi (Ollama CLI) — odpowiada tekstem, nie zmienia plików. Używany do zadań tylko czytających (podsumuj, wyjaśnij) i jako rezerwa, gdy brak roli edytującej.",
		command: "ollama",
		args: ["run", "{model}", "{prompt}"],
	},
	claude: {
		description: "Claude Code CLI (wymaga `claude` w PATH i poświadczenia modelu).",
		command: "claude",
		args: [
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		],
		stdinPrompt: true,
		env: [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CONFIG_DIR",
		],
	},
	codex: {
		description: "OpenAI Codex CLI (wymaga `codex` w PATH i OPENAI_API_KEY).",
		command: "codex",
		args: ["exec", "--full-auto", "{prompt}"],
		env: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
	},
	aider: {
		description: "Aider (wymaga `aider` w PATH i klucza dostawcy modelu).",
		command: "aider",
		args: ["--yes-always", "--no-auto-commits", "--message", "{prompt}"],
		env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"],
	},
};

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): AgentDockConfig {
	const portRaw = env.AGENTDOCK_PORT?.trim();
	const port = portRaw !== undefined && portRaw !== "" ? Number.parseInt(portRaw, 10) : 8787;
	return {
		port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787,
		token: randomBytes(24).toString("base64url"),
		maxConcurrent: 2,
		memoryLimitMb: 2048,
		timeoutSec: 1800,
		branchPrefix: "agentdock/run-",
		routing: structuredClone(DEFAULT_ROUTING),
		agents: { ...DEFAULT_AGENTS },
	};
}

export interface LoadedConfig {
	readonly config: AgentDockConfig;
	readonly created: boolean;
}

/** Wczytuje config, dopisując brakujące klucze i nowe wbudowane agenty. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
	const created = !existsSync(path);
	let parsed: Partial<AgentDockConfig> = {};
	if (!created) {
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentDockConfig>;
		} catch (err) {
			throw new Error(
				`config.json jest uszkodzony (${path}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	const base = defaultConfig(env);
	const config: AgentDockConfig = {
		port: parsed.port ?? base.port,
		token: parsed.token ?? base.token,
		maxConcurrent: parsed.maxConcurrent ?? base.maxConcurrent,
		memoryLimitMb: parsed.memoryLimitMb ?? base.memoryLimitMb,
		timeoutSec: parsed.timeoutSec ?? base.timeoutSec,
		branchPrefix: parsed.branchPrefix ?? base.branchPrefix,
		routing: mergeRouting(parsed.routing),
		agents: { ...DEFAULT_AGENTS, ...(parsed.agents ?? {}) },
	};
	if (env.AGENTDOCK_PORT !== undefined && env.AGENTDOCK_PORT.trim() !== "") {
		const p = Number.parseInt(env.AGENTDOCK_PORT, 10);
		if (Number.isInteger(p) && p > 0 && p < 65536) config.port = p;
	}
	saveConfig(path, config);
	return { config, created };
}

/**
 * Scala router z pliku z domyślnym — pole po polu, żeby dopisanie nowej opcji
 * w kodzie nie wymagało edycji `config.json` u użytkownika.
 */
export function mergeRouting(partial: Partial<RoutingConfig> | undefined): RoutingConfig {
	const base = structuredClone(DEFAULT_ROUTING);
	if (partial === undefined) return base;
	const localRaw = (partial.local ?? {}) as Partial<LocalTierConfig> & { agent?: string | null };
	// Kompatybilność wsteczna: wcześniejsze wersje miały pojedyncze pole
	// `local.agent` zamiast łańcucha `local.agents` (Faza 3.5).
	const legacyAgent = typeof localRaw.agent === "string" && localRaw.agent !== "" ? [localRaw.agent] : [];
	const agents =
		Array.isArray(localRaw.agents) && localRaw.agents.length > 0
			? localRaw.agents.filter((name): name is string => typeof name === "string" && name !== "")
			: legacyAgent.length > 0
				? legacyAgent
				: base.local.agents;
	return {
		enabled: partial.enabled ?? base.enabled,
		mode: partial.mode ?? base.mode,
		classifier: partial.classifier ?? base.classifier,
		threshold: typeof partial.threshold === "number" ? partial.threshold : base.threshold,
		classifyModel: partial.classifyModel ?? base.classifyModel,
		local: {
			agents,
			chatAgent:
				localRaw.chatAgent !== undefined ? localRaw.chatAgent : base.local.chatAgent,
			model: localRaw.model ?? base.local.model,
			provider: localRaw.provider ?? base.local.provider,
			baseUrl: localRaw.baseUrl ?? base.local.baseUrl,
			env: { ...base.local.env, ...(localRaw.env ?? {}) },
		},
		cloud: { ...base.cloud, ...(partial.cloud ?? {}), env: { ...base.cloud.env, ...(partial.cloud?.env ?? {}) } },
	};
}

export function saveConfig(path: string, config: AgentDockConfig): void {
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}
