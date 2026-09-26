/**
 * Rejestr agentów (Faza 2 Ouroborosa): role żyją w bazie, nie w pliku.
 *
 * Po co: model nadrzędny (Admin) ma tworzyć nowe role „w locie” — bez
 * restartu serwera i bez edycji config.json. Runner czyta definicję agenta
 * **w momencie dispatchu**, więc agent dodany sekundę temu jest od razu
 * wykonywalny.
 *
 * Twarda reguła bezpieczeństwa (wynika z Fazy 1): agent nie dostaje sekretów
 * przez listę `env`. Nazwy typu `*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`
 * są odrzucane przy zapisie — sekrety wchodzą wyłącznie z sejfu (`agent_keys`).
 */
import type { AgentSpec } from "./config.ts";
import type { AgentDockDb } from "./db.ts";
import type { ApiVault, ApiKeyPublic } from "./vault.ts";

export interface AgentRow {
	name: string;
	description: string;
	command: string;
	args_json: string;
	stdin_prompt: number;
	env_json: string;
	builtin: number;
	enabled: number;
	created_at: string;
	updated_at: string;
	/** Preferencja modelu dla routera: `local` | `cloud` | null (auto). */
	tier: string | null;
}

/** Pełny opis agenta widziany przez API/UI. */
export interface AgentDefinition {
	name: string;
	description: string;
	command: string;
	args: string[];
	stdinPrompt: boolean;
	env: string[];
	builtin: boolean;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	keyIds: string[];
	keys: ApiKeyPublic[];
	/** Preferencja modelu dla routera (`null` = decyduje złożoność zadania). */
	tier: "local" | "cloud" | null;
}

export interface AgentInput {
	name?: string;
	description?: string;
	command: string;
	args?: string[];
	stdinPrompt?: boolean;
	env?: string[];
	enabled?: boolean;
	/** Wymuszenie poziomu modelu dla tej roli (`null`/brak = auto). */
	tier?: "local" | "cloud" | null;
}

/** Presety wbudowane, których nie wolno usunąć (demo + model lokalny). */
export const PROTECTED_PRESETS: readonly string[] = ["demo", "ollama-local"];

const TIER_VALUES: readonly string[] = ["local", "cloud"];

function parseTier(value: unknown): "local" | "cloud" | null {
	if (value === null || value === undefined || value === "" || value === "auto") return null;
	const text = String(value).trim().toLowerCase();
	if (TIER_VALUES.includes(text)) return text as "local" | "cloud";
	throw new Error(`nieznany poziom modelu "${String(value)}" (dozwolone: local, cloud, auto)`);
}

/** Nazwy presetów, których nie wolno usunąć. */
export function isProtectedPreset(name: string): boolean {
	return PROTECTED_PRESETS.includes(name);
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Nazwy zmiennych, które MUSZĄ iść przez sejf, a nie przez listę `env`. */
const SECRET_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY)/i;

export function isSecretLikeEnvName(name: string): boolean {
	return SECRET_LIKE.test(name);
}

function parseList(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

export class AgentRegistry {
	constructor(
		private readonly db: AgentDockDb,
		private readonly vault: ApiVault,
	) {}

	list(): AgentDefinition[] {
		const rows = this.db.raw
			.query<AgentRow, []>("select * from agents order by builtin desc, name asc")
			.all();
		return rows.map((row) => this.toDefinition(row));
	}

	get(name: string): AgentDefinition | null {
		const row = this.db.raw
			.query<AgentRow, [string]>("select * from agents where name = ?")
			.get(name);
		return row === null ? null : this.toDefinition(row);
	}

	/** Spec dla runnera (`resolveAgent`) — celowo bez kluczy i metadanych. */
	spec(name: string): AgentSpec | null {
		const row = this.db.raw
			.query<AgentRow, [string]>("select * from agents where name = ?")
			.get(name);
		if (row === null || row.enabled !== 1) return null;
		return {
			command: row.command,
			args: parseList(row.args_json),
			stdinPrompt: row.stdin_prompt === 1,
			env: parseList(row.env_json),
			builtin: row.builtin === 1,
			description: row.description,
			tier: parseTier(row.tier),
		};
	}

	exists(name: string): boolean {
		return this.get(name) !== null;
	}

	create(input: AgentInput): AgentDefinition {
		const name = (input.name ?? "").trim();
		if (!NAME_PATTERN.test(name)) {
			throw new Error(
				`nazwa agenta "${name}" jest niepoprawna (dozwolone: litery, cyfry, . _ -, do 64 znaków, nie od znaku - lub .)`,
			);
		}
		if (this.exists(name)) throw new Error(`agent "${name}" już istnieje`);
		const normalized = normalizeInput(input);
		const now = new Date().toISOString();
		this.db.raw
			.prepare(
				`insert into agents (name, description, command, args_json, stdin_prompt, env_json, builtin, enabled, created_at, updated_at, tier)
				 values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
			)
			.run(
				name,
				normalized.description,
				normalized.command,
				JSON.stringify(normalized.args),
				normalized.stdinPrompt ? 1 : 0,
				JSON.stringify(normalized.env),
				normalized.enabled ? 1 : 0,
				now,
				now,
				normalized.tier,
			);
		const created = this.get(name);
		if (created === null) throw new Error("nie udało się utworzyć agenta");
		return created;
	}

	update(name: string, patch: Partial<AgentInput>): AgentDefinition {
		const current = this.db.raw
			.query<AgentRow, [string]>("select * from agents where name = ?")
			.get(name);
		if (current === null) throw new Error(`nie ma agenta "${name}"`);

		const next: AgentInput = {
			command: patch.command ?? current.command,
			description: patch.description ?? current.description,
			args: patch.args ?? parseList(current.args_json),
			stdinPrompt: patch.stdinPrompt ?? current.stdin_prompt === 1,
			env: patch.env ?? parseList(current.env_json),
			enabled: patch.enabled ?? current.enabled === 1,
		};
		const normalized = normalizeInput(next);
		this.db.raw
			.prepare(
				`update agents set description = ?, command = ?, args_json = ?, stdin_prompt = ?, env_json = ?, enabled = ?, updated_at = ?
				 where name = ?`,
			)
			.run(
				normalized.description,
				normalized.command,
				JSON.stringify(normalized.args),
				normalized.stdinPrompt ? 1 : 0,
				JSON.stringify(normalized.env),
				normalized.enabled ? 1 : 0,
				new Date().toISOString(),
				name,
			);
		const updated = this.get(name);
		if (updated === null) throw new Error(`nie ma agenta "${name}"`);
		return updated;
	}

	remove(name: string): void {
		const row = this.db.raw
			.query<AgentRow, [string]>("select * from agents where name = ?")
			.get(name);
		if (row === null) return;
		if (row.builtin === 1 || isProtectedPreset(name)) {
			throw new Error(
				`agent "${name}" jest wbudowanym presetem (ścieżka bez kluczy API / model lokalny) — nie można go usunąć`,
			);
		}
		this.db.raw.prepare("delete from agent_keys where agent_name = ?").run(name);
		this.db.raw.prepare("delete from agents where name = ?").run(name);
	}

	setKeys(name: string, keyIds: readonly string[]): AgentDefinition {
		if (!this.exists(name)) throw new Error(`nie ma agenta "${name}"`);
		for (const id of keyIds) this.vault.assign(name, id);
		const keep = new Set(keyIds);
		for (const bound of this.vault.keysForAgent(name)) {
			if (!keep.has(bound.id)) this.vault.unassign(name, bound.id);
		}
		const updated = this.get(name);
		if (updated === null) throw new Error(`nie ma agenta "${name}"`);
		return updated;
	}

	/**
	 * Zasiew rejestru przy pierwszej migracji: domyślne presety + agenci
	 * z `config.json` (kompatybilność wsteczna — plik staje się źródłem
	 * *początkowym*, nie źródłem prawdy).
	 */
	seed(seedAgents: Record<string, Omit<AgentSpec, "builtin"> & { builtin?: boolean }>): number {
		const count = this.db.raw.query<{ n: number }, []>("select count(*) as n from agents").get();
		if ((count?.n ?? 0) > 0) return 0;
		let inserted = 0;
		const now = new Date().toISOString();
		for (const [name, spec] of Object.entries(seedAgents)) {
			if (!NAME_PATTERN.test(name)) continue;
			this.db.raw
				.prepare(
					`insert or ignore into agents (name, description, command, args_json, stdin_prompt, env_json, builtin, enabled, created_at, updated_at)
					 values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				)
				.run(
							name,
					spec.description ?? "",
					spec.command,
					JSON.stringify(spec.args ?? []),
					spec.stdinPrompt === true ? 1 : 0,
					JSON.stringify(spec.env ?? []),
					spec.builtin === true ? 1 : 0,
					now,
					now,
				);
			if (spec.tier !== undefined && spec.tier !== null) {
				this.db.raw.prepare("update agents set tier = ? where name = ?").run(spec.tier, name);
			}
			inserted += 1;
		}
		return inserted;
	}

	/**
	 * Dodaje nowe presety wbudowane do istniejącej instalacji — raz na wersję
	 * presetów (znacznik w tabeli `meta`). Dzięki temu rola `ollama-local`
	 * z Fazy 3 pojawia się po aktualizacji, ale preset usunięty świadomie przez
	 * użytkownika nie wraca przy każdym starcie.
	 */
	syncPresets(presets: Record<string, AgentSpec>, version: number): number {
		const key = "presets_version";
		const row = this.db.raw
			.query<{ value: string }, [string]>("select value from meta where key = ?")
			.get(key);
		const current = row === null ? 0 : Number.parseInt(row.value, 10) || 0;
		if (current >= version) return 0;

		let inserted = 0;
		const now = new Date().toISOString();
		for (const [name, spec] of Object.entries(presets)) {
			if (spec.builtin !== true) continue;
			if (!NAME_PATTERN.test(name)) continue;
			if (this.exists(name)) continue;
			this.db.raw
				.prepare(
					`insert or ignore into agents (name, description, command, args_json, stdin_prompt, env_json, builtin, enabled, created_at, updated_at, tier)
					 values (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
				)
				.run(
					name,
					spec.description ?? "",
					spec.command,
					JSON.stringify(spec.args ?? []),
					spec.stdinPrompt === true ? 1 : 0,
					JSON.stringify(spec.env ?? []),
					now,
					now,
					spec.tier ?? null,
				);
			inserted += 1;
		}
		this.db.raw
			.prepare("insert or replace into meta (key, value) values (?, ?)")
			.run(key, String(version));
		return inserted;
	}

	private toDefinition(row: AgentRow): AgentDefinition {
		const keys = this.vault.keysForAgent(row.name);
		return {
			name: row.name,
			description: row.description,
			command: row.command,
			args: parseList(row.args_json),
			stdinPrompt: row.stdin_prompt === 1,
			env: parseList(row.env_json),
			builtin: row.builtin === 1,
			enabled: row.enabled === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			keyIds: keys.map((k) => k.id),
			keys,
			tier: parseTier(row.tier),
		};
	}
}

function normalizeInput(input: AgentInput): {
	description: string;
	command: string;
	args: string[];
	stdinPrompt: boolean;
	env: string[];
	enabled: boolean;
	tier: "local" | "cloud" | null;
} {
	const command = (input.command ?? "").trim();
	if (command === "") throw new Error("agent musi mieć niepuste `command`");
	const args = (input.args ?? []).map((a) => String(a));
	for (const arg of args) {
		if (arg.length > 4096) throw new Error("argument agenta jest zbyt długi (limit 4096 znaków)");
	}
	if (command.length > 512) throw new Error("`command` jest zbyt długi (limit 512 znaków)");

	const env: string[] = [];
	for (const raw of input.env ?? []) {
		const name = String(raw).trim();
		if (name === "") continue;
		if (!ENV_PATTERN.test(name)) {
			throw new Error(`"${name}" nie jest poprawną nazwą zmiennej środowiskowej`);
		}
		if (isSecretLikeEnvName(name)) {
			throw new Error(
				`"${name}" wygląda na sekret — dodaj go w sejfie (zakładka „Klucze API”) i przypisz agentowi; ` +
					"lista `env` służy wyłącznie do zmiennych niesekretnych (np. OLLAMA_HOST, ANTHROPIC_BASE_URL)",
			);
		}
		env.push(name);
	}

	return {
		description: (input.description ?? "").slice(0, 1000),
		command,
		args,
		stdinPrompt: input.stdinPrompt === true,
		env,
		enabled: input.enabled !== false,
		tier: parseTier(input.tier),
	};
}
