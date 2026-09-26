/**
 * Warstwa trwałości: SQLite (`bun:sqlite`) — projekty, runy, zdarzenia.
 *
 * Od wersji Ouroboros schemat jest **wersjonowany**: `pragma user_version`
 * trzyma numer migracji, a `MIGRATIONS` to uporządkowana lista kroków.
 * To warunek konieczny dalszego rozwoju (sejf kluczy, agenci w bazie,
 * orkiestracja roju) — bez tego każda zmiana kolumny kończyłaby się ręczną
 * ingerencją w plik bazy użytkownika.
 *
 * Reguły migracji:
 *   1. kroki są nieodwracalne i wykonywane po kolei od `user_version + 1`,
 *   2. każdy krok jest idempotentny (`if not exists`) — stara baza z epoki
 *      AgentDocka (user_version = 0, tabele już istnieją) przechodzi krok 1
 *      bez błędów,
 *   3. cała migracja jest w transakcji; błąd ⇒ rollback i wyjątek (lepiej
 *      odmówić startu niż pracować na wpół zmigrowanej bazie).
 */
import { Database } from "bun:sqlite";

export type RunState =
	| "queued"
	| "preparing"
	| "running"
	| "finalizing"
	| "succeeded"
	| "failed"
	| "cancelled";

export const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(state: string): boolean {
	return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Stan dostawy gałęzi — odróżnia „nie było czego pushować” od „push się nie udał”. */
export type DeliveryState =
	| "not_attempted"
	| "skipped_no_commits"
	| "skipped_cancelled"
	| "skipped_disabled"
	| "pushed"
	| "failed";

export interface ProjectRow {
	id: string;
	name: string;
	path: string;
	url: string | null;
	default_branch: string;
	added_at: string;
	/** 1 = projekt wrażliwy: router nie może wysłać jego kodu do modelu w chmurze. */
	sensitive: number;
}

export interface RunRow {
	id: string;
	project_id: string;
	agent: string;
	prompt: string;
	state: RunState;
	branch: string | null;
	worktree: string | null;
	base_commit: string | null;
	pid: number | null;
	exit_code: number | null;
	failure_reason: string | null;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
	cost_usd: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	commits_ahead: number | null;
	files_changed: number | null;
	insertions: number | null;
	deletions: number | null;
	pushed: number | null;
	memory_limit_mb: number | null;
	timeout_sec: number | null;
	job_kind: string | null;
	/** Czy wolno pushować gałąź tego runu (wolę operatora z dispatchu). */
	push_enabled: number | null;
	/** Wynik próby dostawy (patrz `DeliveryState`). */
	delivery_state: string | null;
	/** Komunikat błędu pusha, gdy `delivery_state = 'failed'`. */
	push_error: string | null;
	/** JSON: etykiety kluczy z sejfu użytych przez ten run (audyt). */
	keys_used: string | null;
	/** Decyzja routera: `local` | `cloud` (null = routing wyłączony). */
	route_tier: string | null;
	/** Model wybrany przez router (null = bez nadpisania). */
	route_model: string | null;
	/** Pełny zapis decyzji: wynik, próg, sygnały, rola efektywna, ostrzeżenia. */
	route_json: string | null;
	/** Żądanie operatora z dispatchu: `auto` | `local` | `cloud`. */
	route_request: string | null;
}

export interface EventRow {
	id: number;
	run_id: string;
	seq: number;
	ts: string;
	kind: string;
	stream: string | null;
	text: string;
}

// ---------------------------------------------------------------------------
// migracje
// ---------------------------------------------------------------------------

interface Migration {
	readonly version: number;
	readonly description: string;
	readonly sql: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: "bazowy schemat (projekty, runy, zdarzenia) — zgodny z epoką AgentDocka",
		sql: [
			`create table if not exists projects (
				id text primary key,
				name text not null,
				path text not null,
				url text,
				default_branch text not null,
				added_at text not null
			)`,
			`create table if not exists runs (
				id text primary key,
				project_id text not null,
				agent text not null,
				prompt text not null,
				state text not null,
				branch text,
				worktree text,
				base_commit text,
				pid integer,
				exit_code integer,
				failure_reason text,
				created_at text not null,
				started_at text,
				ended_at text,
				cost_usd real,
				tokens_in integer,
				tokens_out integer,
				commits_ahead integer,
				files_changed integer,
				insertions integer,
				deletions integer,
				pushed integer,
				memory_limit_mb integer,
				timeout_sec integer,
				job_kind text
			)`,
			`create table if not exists events (
				id integer primary key autoincrement,
				run_id text not null,
				seq integer not null,
				ts text not null,
				kind text not null,
				stream text,
				text text not null
			)`,
			"create index if not exists events_run_seq on events(run_id, seq)",
			"create index if not exists runs_state on runs(state)",
		],
	},
	{
		version: 2,
		description: "sejf kluczy API + rejestr agentów (dynamiczne role)",
		sql: [
			`create table if not exists api_keys (
				id text primary key,
				label text not null,
				provider text not null,
				env_var text not null,
				cipher text not null,
				hint text not null default '',
				created_at text not null,
				last_used_at text,
				disabled integer not null default 0
			)`,
			`create table if not exists agents (
				name text primary key,
				description text not null default '',
				command text not null,
				args_json text not null default '[]',
				stdin_prompt integer not null default 0,
				env_json text not null default '[]',
				builtin integer not null default 0,
				enabled integer not null default 1,
				created_at text not null,
				updated_at text not null
			)`,
			`create table if not exists agent_keys (
				agent_name text not null,
				key_id text not null,
				primary key (agent_name, key_id)
			)`,
			"create index if not exists agent_keys_key on agent_keys(key_id)",
		],
	},
	{
		version: 3,
		description: "prawda o dostawie (push_enabled/delivery_state/push_error) + audyt kluczy w runie",
		sql: [
			"alter table runs add column push_enabled integer not null default 1",
			"alter table runs add column delivery_state text",
			"alter table runs add column push_error text",
			"alter table runs add column keys_used text",
		],
	},
	{
		version: 4,
		description:
			"Smart Router (Faza 3): decyzja o modelu w runie, preferencja modelu roli, wrażliwość projektu, tabela meta",
		sql: [
			"alter table runs add column route_tier text",
			"alter table runs add column route_model text",
			"alter table runs add column route_json text",
			"alter table runs add column route_request text",
			"alter table agents add column tier text",
			"alter table projects add column sensitive integer not null default 0",
			`create table if not exists meta (key text primary key, value text not null)`,
		],
	},
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

// ---------------------------------------------------------------------------
// baza
// ---------------------------------------------------------------------------

export class AgentDockDb {
	readonly raw: Database;

	constructor(path: string) {
		this.raw = new Database(path, { create: true });
		this.raw.exec("pragma journal_mode = WAL;");
		this.migrate();
	}

	/** Aktualny numer wersji schematu zapisany w pliku bazy. */
	userVersion(): number {
		const row = this.raw.query<{ user_version: number }, []>("pragma user_version").get();
		return row?.user_version ?? 0;
	}

	/** Dopisuje brakujące kolumny do modelu wiersza (bazy sprzed migracji). */
	private appliedVersions(): number {
		return this.userVersion();
	}

	private migrate(): void {
		const from = this.appliedVersions();
		if (from >= SCHEMA_VERSION) return;

		for (const migration of MIGRATIONS) {
			if (migration.version <= from) continue;
			const statements = migration.sql;
			this.raw.transaction(() => {
				for (const statement of statements) {
					try {
						this.raw.exec(statement);
					} catch (err) {
						// `alter table add column` nie zna `if not exists` — kolumna
						// mogła już powstać, jeśli ktoś wcześniej dodał ją ręcznie.
						const message = err instanceof Error ? err.message : String(err);
						if (/duplicate column name/i.test(message)) continue;
						throw new Error(
							`migracja ${migration.version} (${migration.description}) nie powiodła się: ${message}`,
						);
					}
				}
				this.raw.exec(`pragma user_version = ${migration.version}`);
			})();
		}
	}

	close(): void {
		this.raw.close();
	}

	// ---------- projekty ----------

	insertProject(row: ProjectRow): void {
		this.raw
			.prepare(
				"insert into projects (id, name, path, url, default_branch, added_at) values (?, ?, ?, ?, ?, ?)",
			)
			.run(row.id, row.name, row.path, row.url, row.default_branch, row.added_at);
	}

	listProjects(): ProjectRow[] {
		return this.raw.query<ProjectRow, []>("select * from projects order by added_at asc").all();
	}

	getProject(id: string): ProjectRow | null {
		return this.raw.query<ProjectRow, [string]>("select * from projects where id = ?").get(id);
	}

	findProjectByPath(path: string): ProjectRow | null {
		return this.raw
			.query<ProjectRow, [string]>("select * from projects where lower(path) = lower(?)")
			.get(path);
	}

	deleteProject(id: string): void {
		this.raw.prepare("delete from projects where id = ?").run(id);
	}

	/** Oznaczenie projektu jako wrażliwego (router nie wyśle go do chmury). */
	setProjectSensitive(id: string, sensitive: boolean): void {
		this.raw
			.prepare("update projects set sensitive = ? where id = ?")
			.run(sensitive ? 1 : 0, id);
	}

	/** Statystyki routera: ile runów poszło lokalnie, ile do chmury, jaki koszt. */
	routingStats(): { local: number; cloud: number; unrouted: number; cloudCostUsd: number } {
		const rows = this.raw
			.query<{ route_tier: string | null; n: number; cost: number | null }, []>(
				"select route_tier, count(*) as n, sum(cost_usd) as cost from runs group by route_tier",
			)
			.all();
		let local = 0;
		let cloud = 0;
		let unrouted = 0;
		let cloudCostUsd = 0;
		for (const row of rows) {
			if (row.route_tier === "local") local += row.n;
			else if (row.route_tier === "cloud") {
				cloud += row.n;
				cloudCostUsd += row.cost ?? 0;
			} else unrouted += row.n;
		}
		return { local, cloud, unrouted, cloudCostUsd };
	}

	// ---------- runy ----------

	insertRun(row: RunRow): void {
		this.raw
			.prepare(
				`insert into runs (
					id, project_id, agent, prompt, state, branch, worktree, base_commit, pid, exit_code,
					failure_reason, created_at, started_at, ended_at, cost_usd, tokens_in, tokens_out,
					commits_ahead, files_changed, insertions, deletions, pushed, memory_limit_mb,
					timeout_sec, job_kind, push_enabled, delivery_state, push_error, keys_used,
					route_tier, route_model, route_json, route_request
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.id,
				row.project_id,
				row.agent,
				row.prompt,
				row.state,
				row.branch,
				row.worktree,
				row.base_commit,
				row.pid,
				row.exit_code,
				row.failure_reason,
				row.created_at,
				row.started_at,
				row.ended_at,
				row.cost_usd,
				row.tokens_in,
				row.tokens_out,
				row.commits_ahead,
				row.files_changed,
				row.insertions,
				row.deletions,
				row.pushed,
				row.memory_limit_mb,
				row.timeout_sec,
				row.job_kind,
				row.push_enabled ?? 1,
				row.delivery_state ?? null,
				row.push_error ?? null,
				row.keys_used ?? null,
				row.route_tier ?? null,
				row.route_model ?? null,
				row.route_json ?? null,
				row.route_request ?? null,
			);
	}

	updateRun(id: string, patch: Partial<RunRow>): void {
		const keys = Object.keys(patch).filter((k) => k !== "id") as Array<keyof RunRow>;
		if (keys.length === 0) return;
		const sets = keys.map((k) => `${k} = ?`).join(", ");
		const values = keys.map((k) => patch[k] ?? null);
		this.raw.prepare(`update runs set ${sets} where id = ?`).run(...(values as never[]), id);
	}

	getRun(id: string): RunRow | null {
		return this.raw.query<RunRow, [string]>("select * from runs where id = ?").get(id);
	}

	listRuns(limit = 100): RunRow[] {
		return this.raw
			.query<RunRow, [number]>("select * from runs order by created_at desc limit ?")
			.all(limit);
	}

	activeRuns(): RunRow[] {
		return this.raw
			.query<RunRow, []>(
				"select * from runs where state in ('queued','preparing','running','finalizing') order by created_at asc",
			)
			.all();
	}

	/** Najstarszy run w kolejce (albo null). */
	nextQueued(): RunRow | null {
		return this.raw
			.query<RunRow, []>("select * from runs where state = 'queued' order by created_at asc limit 1")
			.get();
	}

	/** Ile runów jest w stanach nieterminalnych (do raportu w /healthz). */
	activeCount(): number {
		const row = this.raw
			.query<{ n: number }, []>(
				"select count(*) as n from runs where state in ('queued','preparing','running','finalizing')",
			)
			.get();
		return row?.n ?? 0;
	}

	stats(): { total: number; byState: Record<string, number>; costUsd: number } {
		const rows = this.raw
			.query<{ state: string; n: number }, []>("select state, count(*) as n from runs group by state")
			.all();
		const cost = this.raw
			.query<{ c: number | null }, []>("select sum(cost_usd) as c from runs")
			.get();
		const byState: Record<string, number> = {};
		let total = 0;
		for (const r of rows) {
			byState[r.state] = r.n;
			total += r.n;
		}
		return { total, byState, costUsd: cost?.c ?? 0 };
	}

	// ---------- zdarzenia ----------

	/** Dopisuje zdarzenie i zwraca jego numer sekwencji. */
	appendEvent(runId: string, kind: string, stream: string | null, text: string): number {
		const next = this.raw
			.query<{ n: number | null }, [string]>("select max(seq) as n from events where run_id = ?")
			.get(runId);
		const seq = (next?.n ?? 0) + 1;
		this.raw
			.prepare("insert into events (run_id, seq, ts, kind, stream, text) values (?, ?, ?, ?, ?, ?)")
			.run(runId, seq, new Date().toISOString(), kind, stream, text);
		return seq;
	}

	listEvents(runId: string, fromSeq = 0): EventRow[] {
		return this.raw
			.query<EventRow, [string, number]>(
				"select * from events where run_id = ? and seq > ? order by seq asc",
			)
			.all(runId, fromSeq);
	}

	countEvents(runId: string): number {
		const row = this.raw
			.query<{ n: number }, [string]>("select count(*) as n from events where run_id = ?")
			.get(runId);
		return row?.n ?? 0;
	}
}
