/**
 * Rozwiązywanie agenta na konkretną komendę + środowisko.
 *
 * Trzy zasady, które mają znaczenie dla bezpieczeństwa i przewidywalności:
 *   1. dziecko NIE dziedziczy całego środowiska — dostaje allowlistę bazową,
 *      jawnie zadeklarowane zmienne **niesekretne** (`spec.env`) oraz sekrety
 *      z sejfu (`secrets`, nazwa zmiennej → wartość),
 *   2. nazwy sekretopodobne w `spec.env` są pomijane (z ostrzeżeniem) — sekrety
 *      wchodzą wyłącznie z sejfu, więc nie da się ich „przemycić” przez config,
 *   3. do runu wstrzykujemy stały zestaw zmiennych (`AGENTDOCK_*`, `GIT_*`),
 *      na których agent może polegać.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BASE_ENV_ALLOWLIST, type AgentSpec } from "./config.ts";
import { isSecretLikeEnvName } from "./registry.ts";

export interface ResolvedAgent {
	argv: string[];
	env: Record<string, string>;
	stdinPrompt: boolean;
	/** Czy agent jest wbudowany (agent demo) — do raportowania w UI. */
	builtin: boolean;
	/** Niekrytyczne problemy do odnotowania w zdarzeniach runu. */
	problems: string[];
}

export interface ResolveAgentInput {
	readonly spec: AgentSpec;
	readonly vars: Record<string, string>;
	/** Sekrety z sejfu: `{ ANTHROPIC_API_KEY: "sk-…" }`. Nigdy nie logowane. */
	readonly secrets?: Record<string, string>;
	/** Dodatkowe zmienne (np. decyzja routera modeli — Faza 3). */
	readonly extraEnv?: Record<string, string>;
}

/**
 * Argumenty do ponownego uruchomienia samego AgentDock (wbudowany agent demo).
 * W trybie `bun run src/main.ts` trzeba podać ścieżkę skryptu; w skompilowanym
 * `.exe` nie ma skryptu, więc wystarczy sam plik wykonywalny.
 */
export function selfArgv(): string[] {
	// Nadpisanie przydaje się w testach i przy nietypowych launcher-ach.
	const override = process.env.AGENTDOCK_SELF_ENTRY;
	if (override !== undefined && override !== "") return [process.execPath, resolve(override)];
	// Ścieżki muszą być absolutne: dziecko startuje z cwd = worktree runu.
	for (const candidate of [process.argv[1], Bun.main]) {
		if (candidate === undefined || candidate === "") continue;
		const absolute = resolve(candidate);
		if (/\.(ts|js|mjs|cjs)$/i.test(absolute) && existsSync(absolute)) {
			return [process.execPath, absolute];
		}
	}
	return [process.execPath];
}

function substitute(token: string, vars: Record<string, string>): string {
	return token.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

export function buildRunEnv(
	spec: AgentSpec,
	vars: Record<string, string>,
	secrets: Record<string, string> = {},
	extraEnv: Record<string, string> = {},
): { env: Record<string, string>; problems: string[] } {
	const env: Record<string, string> = {};
	const problems: string[] = [];

	for (const key of BASE_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}

	// Zmienne niesekretne zdefiniowane przy agencie (np. OLLAMA_HOST).
	for (const key of spec.env ?? []) {
		if (isSecretLikeEnvName(key)) {
			problems.push(
				`pominięto "${key}" z listy env agenta — nazwy sekretopodobne muszą iść przez sejf (zakładka „Klucze API”)`,
			);
			continue;
		}
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}

	// Sekrety z sejfu — ostatnie słowo, nie da się ich nadpisać listą env.
	for (const [key, value] of Object.entries(secrets)) env[key] = value;
	for (const [key, value] of Object.entries(extraEnv)) env[key] = value;

	// Identyfikacja runu + higiena gita: żadnych interaktywnych promptów,
	// żadnego globalnego configu użytkownika, deterministyczna tożsamość.
	env.AGENTDOCK = "1";
	env.AGENTDOCK_RUN_ID = vars.runId ?? "";
	env.AGENTDOCK_PROJECT = vars.project ?? "";
	env.AGENTDOCK_WORKSPACE = vars.workspace ?? "";
	env.AGENTDOCK_PROMPT_FILE = vars.promptFile ?? "";
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_CONFIG_NOSYSTEM = "1";
	if (vars.gitConfigGlobal !== undefined) env.GIT_CONFIG_GLOBAL = vars.gitConfigGlobal;
	env.GIT_AUTHOR_NAME = vars.gitAuthor ?? "AgentDock";
	env.GIT_AUTHOR_EMAIL = vars.gitEmail ?? "agentdock@localhost";
	env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
	env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
	return { env, problems };
}

export function resolveAgent(input: ResolveAgentInput): ResolvedAgent {
	const { spec, vars } = input;
	const command = substitute(spec.command, vars);
	const argv =
		command === "{self}"
			? [...selfArgv(), ...spec.args.map((a) => substitute(a, vars))]
			: [command, ...spec.args.map((a) => substitute(a, vars))];

	const { env, problems } = buildRunEnv(spec, vars, input.secrets ?? {}, input.extraEnv ?? {});

	return {
		argv,
		env,
		stdinPrompt: spec.stdinPrompt === true,
		builtin: spec.builtin === true,
		problems,
	};
}

/** Czy plik wykonywalny agenta jest widoczny w PATH (diagnostyka UI). */
export function agentBinaryAvailable(spec: AgentSpec): boolean {
	if (spec.builtin === true || spec.command === "{self}") return true;
	return Bun.which(spec.command) !== null;
}
