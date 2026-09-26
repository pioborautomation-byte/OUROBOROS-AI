/**
 * Runner — cykl życia jednego runu.
 *
 *   queued → preparing (worktree, baza) → running (proces w Job Object)
 *          → finalizing (commit szczątków, statystyki, push, sprzątanie)
 *          → succeeded | failed | cancelled
 *
 * Trzy rzeczy, które robimy świadomie tak samo jak warren:
 *   1. parametry runu są zamrożone w wierszu przy dispatchu (późniejsze zmiany
 *      konfiguracji nie mutują runu w locie),
 *   2. wypchnięta gałąź jest gwarantowanym efektem (o ile run nie został
 *      anulowany — wtedy celowo NIE pushujemy, żeby nie wysyłać połowicznej pracy),
 *   3. finalizacja ratuje pracę: cokolwiek agent zostawił w worktree, zostaje
 *      zacommitowane, więc nieudany run nadal ma sensowny artefakt.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDockConfig } from "./config.ts";
import { AgentDockDb, type DeliveryState, type RunRow, type RunState } from "./db.ts";
import * as g from "./git.ts";
import { createRunJob, type RunJob } from "./job.ts";
import type { AppPaths } from "./paths.ts";
import { agentBinaryAvailable, resolveAgent } from "./agents.ts";
import {
	classifyWithOllama,
	countRepoFiles,
	decideRoute,
	probeOllama,
	routeToJson,
	type OllamaStatus,
	type RouteDecision,
	type TierPreference,
} from "./router.ts";
import type { AgentRegistry } from "./registry.ts";
import type { ApiVault, ApiKeyPublic } from "./vault.ts";

const MAX_EVENTS_PER_RUN = 20_000;
const MAX_LINE_CHARS = 20_000;
const ACTIVE_PROCESS_LIMIT = 64;

export interface DispatchInput {
	readonly projectId: string;
	readonly agent: string;
	readonly prompt: string;
	readonly memoryLimitMb?: number;
	readonly timeoutSec?: number;
	/** Czy pushować gałąź na origin po zakończeniu (domyślnie tak). */
	readonly push?: boolean;
	/**
	 * Żądanie poziomu modelu z dispatchu (Faza 3): `auto` (domyślnie) zostawia
	 * decyzję routerowi, `local`/`cloud` wymusza poziom i jest zapisywane w runie.
	 */
	readonly tier?: TierPreference;
}

export interface RunnerEvent {
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly text: string;
}

type Listener = (event: RunnerEvent) => void;

interface ActiveRun {
	readonly runId: string;
	readonly job: RunJob;
	proc: Bun.Subprocess | null;
	readonly worktree: string;
	readonly branch: string;
	readonly baseSha: string;
	readonly projectPath: string;
	readonly push: boolean;
	timedOut: boolean;
	cancelReason: string | null;
	timer: ReturnType<typeof setTimeout> | null;
	eventsEmitted: number;
	truncated: boolean;
}

export interface UsageTotals {
	costUsd: number | null;
	tokensIn: number | null;
	tokensOut: number | null;
}

/** Zależności spoza bazy: sejf kluczy i rejestr agentów (Faza 1 i 2 Ouroborosa). */
export interface RunnerDeps {
	readonly vault: ApiVault;
	readonly agents: AgentRegistry;
	readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
	/**
	 * Sonda modelu lokalnego (Ollama) — seam testowy. Produkcja pomija to pole
	 * i używa prawdziwego `probeOllama` (HTTP na localhost, cache 30 s).
	 */
	readonly probeOllama?: (baseUrl: string) => Promise<OllamaStatus>;
}

/** Wyciąga koszt/tokeny z linii stream-json (claude-code i pokrewne). */
export function extractUsage(line: string, acc: UsageTotals): void {
	if (!line.startsWith("{")) return;
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof obj !== "object" || obj === null) return;
	const rec = obj as Record<string, unknown>;
	const usage = (rec.usage ?? (rec.message as Record<string, unknown> | undefined)?.usage) as
		| Record<string, unknown>
		| undefined;
	if (usage !== undefined) {
		const inTok = usage.input_tokens ?? usage.inputTokens;
		const outTok = usage.output_tokens ?? usage.outputTokens;
		if (typeof inTok === "number") acc.tokensIn = (acc.tokensIn ?? 0) + inTok;
		if (typeof outTok === "number") acc.tokensOut = (acc.tokensOut ?? 0) + outTok;
	}
	const cost = rec.total_cost_usd ?? rec.cost_usd ?? rec.costUsd;
	if (typeof cost === "number" && Number.isFinite(cost)) {
		acc.costUsd = (acc.costUsd ?? 0) + cost;
	}
}

function newRunId(): string {
	return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function pumpLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buf = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				onLine(buf.slice(0, idx).replace(/\r$/, ""));
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
			if (buf.length > MAX_LINE_CHARS) {
				onLine(buf.slice(0, MAX_LINE_CHARS));
				buf = "";
			}
		}
		buf += decoder.decode();
		if (buf !== "") onLine(buf.replace(/\r$/, ""));
	} finally {
		reader.releaseLock();
	}
}

export class Runner {
	private readonly active = new Map<string, ActiveRun>();
	/** Runy przejęte przez tick(), ale jeszcze nie wpisane do `active`
	 *  (przygotowanie worktree jest asynchroniczne). Bez tego limitu
	 *  równoległości dałoby się przekroczyć, bo licznik rośnie dopiero
	 *  po przygotowaniu workspace'u. */
	private readonly starting = new Set<string>();
	private readonly listeners = new Map<string, Set<Listener>>();
	private draining = false;

	/** Sejf kluczy — współdzielony z API/UI (ten sam obiekt, jedna prawda o kluczach). */
	readonly vault: ApiVault;
	/** Rejestr agentów — role czytane z bazy przy każdym dispatchu. */
	readonly agents: AgentRegistry;

	constructor(
		private readonly db: AgentDockDb,
		private readonly paths: AppPaths,
		private readonly getConfig: () => AgentDockConfig,
		deps: RunnerDeps,
	) {
		this.vault = deps.vault;
		this.agents = deps.agents;
		this.log = deps.log ?? (() => {});
		this.probeOllama = deps.probeOllama ?? ((baseUrl) => probeOllama(baseUrl));
	}

	private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
	private readonly probeOllama: (baseUrl: string) => Promise<OllamaStatus>;

	// ---------- API ----------

	dispatch(input: DispatchInput): RunRow {
		const project = this.db.getProject(input.projectId);
		if (project === null) throw new Error(`nie ma projektu ${input.projectId}`);
		const config = this.getConfig();
		// Role czyta rejestr (baza), nie plik — agent dodany sekundę temu
		// jest już wykonywalny, bez restartu serwera.
		const agent = this.agents.get(input.agent);
		if (agent === null) {
			const available = this.agents.list().map((a) => a.name).join(", ");
			throw new Error(`nieznany agent "${input.agent}" (dostępni: ${available})`);
		}
		if (!agent.enabled) throw new Error(`agent "${input.agent}" jest wyłączony`);
		if (input.prompt.trim() === "") throw new Error("prompt nie może być pusty");

		const run: RunRow = {
			id: newRunId(),
			project_id: project.id,
			agent: input.agent,
			prompt: input.prompt,
			state: "queued",
			branch: null,
			worktree: null,
			base_commit: null,
			pid: null,
			exit_code: null,
			failure_reason: null,
			created_at: new Date().toISOString(),
			started_at: null,
			ended_at: null,
			cost_usd: null,
			tokens_in: null,
			tokens_out: null,
			commits_ahead: null,
			files_changed: null,
			insertions: null,
			deletions: null,
			pushed: null,
			memory_limit_mb: input.memoryLimitMb ?? config.memoryLimitMb,
			timeout_sec: input.timeoutSec ?? config.timeoutSec,
			job_kind: null,
			push_enabled: input.push === false ? 0 : 1,
			delivery_state: null,
			push_error: null,
			keys_used: null,
			route_tier: null,
			route_model: null,
			route_json: null,
			route_request: input.tier ?? "auto",
		};
		this.db.insertRun(run);
		this.emit(run.id, "lifecycle", `run zakolejkowany (agent: ${run.agent}, projekt: ${project.name})`);
		this.tick();
		return this.db.getRun(run.id) ?? run;
	}

	/** Anuluje run: ubija drzewo procesów i oznacza powód. */
	cancel(runId: string, reason = "anulowany przez operatora"): boolean {
		const active = this.active.get(runId);
		if (active === undefined) {
			const run = this.db.getRun(runId);
			if (run !== null && run.state === "queued") {
				this.db.updateRun(runId, {
					state: "cancelled",
					ended_at: new Date().toISOString(),
					failure_reason: reason,
				});
				this.emit(runId, "lifecycle", `anulowano przed startem: ${reason}`);
				return true;
			}
			return false;
		}
		active.cancelReason = reason;
		this.emit(runId, "lifecycle", `anulowanie: ${reason}`);
		this.terminate(active);
		return true;
	}

	subscribe(runId: string, listener: Listener): () => void {
		let set = this.listeners.get(runId);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(runId, set);
		}
		set.add(listener);
		return () => {
			const current = this.listeners.get(runId);
			if (current === undefined) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(runId);
		};
	}

	activeCount(): number {
		return this.active.size + this.starting.size;
	}

	/** Czeka, aż wszystkie aktywne runy się zakończą (graceful shutdown). */
	async drain(): Promise<void> {
		this.draining = true;
		const started = Date.now();
		while (this.active.size + this.starting.size > 0 && Date.now() - started < 15_000) {
			await Bun.sleep(200);
		}
		for (const active of this.active.values()) {
			this.terminate(active);
		}
	}

	/**
	 * Po restarcie aplikacji żaden run nie może zostać „w połowie”: procesy
	 * nie żyją, więc oznaczamy je jako przerwane (worktree zostaje na dysku
	 * do ręcznego obejrzenia).
	 */
	recover(): number {
		const stale = this.db.activeRuns();
		for (const run of stale) {
			this.db.updateRun(run.id, {
				state: "failed",
				ended_at: new Date().toISOString(),
				failure_reason: "przerwany przez restart aplikacji",
			});
			this.emit(run.id, "lifecycle", "run przerwany przez restart aplikacji");
		}
		return stale.length;
	}

	// ---------- wnętrze ----------

	private tick(): void {
		if (this.draining) return;
		const config = this.getConfig();
		while (this.active.size + this.starting.size < Math.max(1, config.maxConcurrent)) {
			const next = this.db.nextQueued();
			if (next === null) return;
			// Przejście queued → preparing MUSI być synchroniczne, inaczej tick
			// z dwóch miejsc wystartuje ten sam run dwukrotnie.
			this.starting.add(next.id);
			this.db.updateRun(next.id, { state: "preparing", started_at: new Date().toISOString() });
			void this.execute(this.db.getRun(next.id) ?? next)
				.catch((err) => {
					this.fail(next.id, err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					this.starting.delete(next.id);
				});
		}
	}

	private fail(runId: string, reason: string): void {
		this.db.updateRun(runId, {
			state: "failed",
			ended_at: new Date().toISOString(),
			failure_reason: reason,
		});
		this.emit(runId, "lifecycle", `run nieudany: ${reason}`);
	}

	private terminate(active: ActiveRun): void {
		active.job.terminate(1);
		try {
			active.proc?.kill();
		} catch {
			// proces mógł już nie żyć
		}
	}

	private emit(runId: string, kind: string, text: string, stream: string | null = null): void {
		const active = this.active.get(runId);
		if (active !== undefined) {
			if (active.eventsEmitted >= MAX_EVENTS_PER_RUN) {
				if (!active.truncated) {
					active.truncated = true;
					const seq = this.db.appendEvent(
						runId,
						"lifecycle",
						null,
						`limit ${MAX_EVENTS_PER_RUN} zdarzeń osiągnięty — dalsze linie nie są zapisywane`,
					);
					this.broadcast({ runId, seq, ts: new Date().toISOString(), kind: "lifecycle", stream: null, text: "limit zdarzeń osiągnięty" });
				}
				return;
			}
			active.eventsEmitted += 1;
		}
		const safe = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
		const seq = this.db.appendEvent(runId, kind, stream, safe);
		this.appendTranscript(runId, seq, kind, stream, safe);
		this.broadcast({
			runId,
			seq,
			ts: new Date().toISOString(),
			kind,
			stream,
			text: safe,
		});
	}

	private broadcast(event: RunnerEvent): void {
		const set = this.listeners.get(event.runId);
		if (set === undefined) return;
		for (const listener of set) {
			try {
				listener(event);
			} catch {
				// martwy subskrybent nie może psuć runu
			}
		}
	}

	private transcriptPath(runId: string): string {
		return join(this.paths.runs, runId, "transcript.log");
	}

	private appendTranscript(
		runId: string,
		seq: number,
		kind: string,
		stream: string | null,
		text: string,
	): void {
		try {
			appendFileSync(
				this.transcriptPath(runId),
				`${JSON.stringify({ seq, kind, stream, text })}\n`,
				"utf8",
			);
		} catch {
			// log pomocniczy — brak zapisu nie może wywalić runu
		}
	}

	private async execute(run: RunRow): Promise<void> {
		const project = this.db.getProject(run.project_id);
		if (project === null) {
			this.fail(run.id, "projekt zniknął z rejestru");
			return;
		}
		const config = this.getConfig();

		// ---------- Smart Router (Faza 3): decyzja PRZED tworzeniem workspace'u ----------
		// Robimy to tutaj, a nie po przygotowaniu worktree, z dwóch powodów:
		//   1. run zablokowany (np. wrażliwy projekt bez modelu lokalnego) nie
		//      zostawia po sobie katalogu ani gałęzi,
		//   2. decyzja jest podejmowana dokładnie w momencie, w którym run rusza
		//      (a nie w chwili zlecenia), więc informacja o dostępności modelu
		//      lokalnego jest świeża.
		let route: RouteDecision | null = null;
		const requestedAgent = run.agent;
		let effectiveAgent = requestedAgent;
		if (config.routing.enabled) {
			const requestedSpec = this.agents.spec(requestedAgent);
			// Rola wbudowana (`demo`, `ollama-local`) to świadomy wybór operatora
			// — router jej nie podmienia i nie podejmuje dla niej decyzji. Bez tej
			// reguły prosty prompt na agencie demo uciekałby do roli lokalnej, czyli
			// do innego zachowania, niż operator zlecił (błąd złapany na maszynie,
			// gdzie Ollama faktycznie działa).
			const operatorForced = ((run.route_request as string | null) ?? "auto") !== "auto";
			if (requestedSpec?.builtin === true && !operatorForced) {
				this.emit(
					run.id,
					"lifecycle",
					`router: pomijam rolę wbudowaną "${requestedAgent}" (świadomy wybór operatora)`,
				);
			} else {
				const ollama = await this.probeOllama(config.routing.local.baseUrl);
				const classifierScore =
					config.routing.classifier === "ollama"
						? await classifyWithOllama(run.prompt, config.routing, this.probeOllama)
						: null;
				const decision = decideRoute({
					prompt: run.prompt,
					requestedAgent,
					agentTier: requestedSpec?.tier ?? null,
					project: {
						name: project.name,
						path: project.path,
						sensitive: project.sensitive === 1,
					},
					routing: config.routing,
					tierOverride: (run.route_request as TierPreference | null) ?? "auto",
					ollama,
					fileCount: countRepoFiles(project.path),
					// Rola lokalna musi być realnie wykonywalna — inaczej router
					// obiecywałby poziom lokalny, którego nie ma czym zrealizować.
					roleAvailable: (name: string) => {
						const spec = this.agents.spec(name);
						return spec !== null && agentBinaryAvailable(spec);
					},
					classifierScore,
				});
				if (decision.agent !== null) effectiveAgent = decision.agent;
				route = decision;

				// Zapis decyzji + zdarzenia robimy od razu: run zablokowany nie może
				// zostawić po sobie katalogu runu ani worktree.
				this.db.updateRun(run.id, {
					route_tier: decision.tier,
					route_model: decision.model,
					route_json: routeToJson(decision, {
						effectiveAgent,
						localAgent: decision.tier === "local",
					}),
				});
				this.emit(
					run.id,
					"lifecycle",
					`router: ${decision.reason}${decision.model !== null ? ` · model: ${decision.model}` : ""}`,
				);
				for (const warning of decision.warnings) {
					this.emit(run.id, "lifecycle", `router: ${warning}`);
				}
				if (effectiveAgent !== requestedAgent) {
					this.emit(
						run.id,
						"lifecycle",
						`router: zamieniam rolę ${requestedAgent} → ${effectiveAgent} (poziom ${decision.tier})`,
					);
				}
				if (decision.blocked) {
					this.fail(run.id, `router zablokował run: ${decision.warnings[0] ?? decision.reason}`);
					return;
				}
			}
		}

		const runDir = join(this.paths.runs, run.id);
		mkdirSync(runDir, { recursive: true });

		const promptFile = join(runDir, "prompt.md");
		writeFileSync(promptFile, run.prompt, "utf8");
		const gitConfig = join(runDir, "gitconfig");
		// Pliki „śmieciowe” narzędzi (Aider zostawia `.aider.chat.history.md`,
		// `.aider.tags.cache` itd.). Wykluczamy je per-run plikiem exclude
		// wskazanym w konfiguracji gita — działa i dla agenta, i dla naszego
		// commita ratunkowego, więc leftovers nie trafiają do gałęzi runu.
		const excludeFile = join(runDir, "git-exclude");
		writeFileSync(excludeFile, [".aider*", ".ouroboros*", ".agentdock*", "", ].join("\n"), "utf8");
		const author = project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40) || "project";
		writeFileSync(
			gitConfig,
			[
				"[user]",
				`\tname = AgentDock`,
				`\temail = agentdock@localhost`,
				"[init]",
				"\tdefaultBranch = " + project.default_branch,
				"[safe]",
				"\tdirectory = *",
				"[core]",
				"\tautocrlf = false",
				`\texcludesFile = ${excludeFile.replace(/\\/g, "/")}`,
				"",
			].join("\n"),
			"utf8",
		);

		this.emit(run.id, "lifecycle", `projekt: ${project.path}`);
		this.emit(run.id, "lifecycle", `przygotowuję bazę (${project.default_branch})…`);

		const base = await g.prepareBase(project.path, project.default_branch);
		const branch = `${config.branchPrefix}${run.id.replace(/^run_/, "")}`;
		const worktree = join(this.paths.worktrees, run.id);
		mkdirSync(worktree, { recursive: true });

		await g.worktreeAdd(project.path, worktree, branch, base.ref);
		this.db.updateRun(run.id, { branch, worktree, base_commit: base.sha });
		this.emit(run.id, "lifecycle", `worktree gotowy: ${worktree} (gałąź ${branch})`);
		this.emit(run.id, "lifecycle", `baza: ${base.ref} @ ${base.sha.slice(0, 10)}${base.fetched ? " (świeży fetch)" : ""}`);

		const spec = this.agents.spec(effectiveAgent);
		if (spec === null) {
			this.fail(run.id, `agent "${effectiveAgent}" nie istnieje albo jest wyłączony`);
			return;
		}

		// Sekrety pochodzą WYŁĄCZNIE z sejfu (Faza 1). Do zdarzeń trafiają
		// etykiety kluczy, nigdy wartości.
		const secrets = this.vault.secretsForAgent(effectiveAgent);
		for (const problem of secrets.problems) this.emit(run.id, "lifecycle", `sejf: ${problem}`);
		this.db.updateRun(run.id, { keys_used: JSON.stringify(secrets.usedLabels) });
		if (secrets.usedLabels.length > 0) {
			this.emit(run.id, "lifecycle", `klucze z sejfu: ${secrets.usedLabels.join(", ")}`);
		}

		const resolved = resolveAgent({
			spec,
			vars: {
				runId: run.id,
				project: project.name,
				workspace: worktree,
				promptFile,
				gitConfigGlobal: gitConfig,
				gitAuthor: `${author} (AgentDock)`,
				gitEmail: "agentdock@localhost",
				// `{prompt}`: pełna treść zadania do argumentu roli (np. `ollama run
				// {model} {prompt}`). Bez tego presety używające `{prompt}` w argumentach
				// dostawały dosłowny tekst `{prompt}` — błąd złapany w Fazie 3 na
				// prawdziwym runie z modelem lokalnym.
				prompt: run.prompt,
				// Placeholdery routera (Faza 3): `{model}` i `{tier}` w argach roli.
				model: route?.model ?? "",
				tier: route?.tier ?? "auto",
			},
			secrets: secrets.env,
			extraEnv: route?.env ?? {},
		});
		for (const problem of resolved.problems) this.emit(run.id, "lifecycle", problem);

		this.emit(run.id, "lifecycle", `uruchamiam agenta: ${resolved.argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

		const memoryLimitBytes = (run.memory_limit_mb ?? config.memoryLimitMb) * 1024 * 1024;
		const job = createRunJob({ memoryLimitBytes, activeProcessLimit: ACTIVE_PROCESS_LIMIT });
		const active: ActiveRun = {
			runId: run.id,
			job,
			proc: null,
			worktree,
			branch,
			baseSha: base.sha,
			projectPath: project.path,
			push: true,
			timedOut: false,
			cancelReason: null,
			timer: null,
			eventsEmitted: 0,
			truncated: false,
		};
		this.active.set(run.id, active);
		// Od tego momentu run liczy się w `active`, nie w `starting` — inaczej
		// licznik równoległości liczyłby go podwójnie.
		this.starting.delete(run.id);

		const usage: UsageTotals = { costUsd: null, tokensIn: null, tokensOut: null };
		let exitCode: number | null = null;
		try {
			const proc = Bun.spawn(resolved.argv, {
				cwd: worktree,
				env: resolved.env,
				stdin: resolved.stdinPrompt ? "pipe" : "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			active.proc = proc;
			this.db.updateRun(run.id, { state: "running", pid: proc.pid, job_kind: job.kind });
			this.emit(run.id, "lifecycle", `run wystartował (pid ${proc.pid}, limity: ${job.kind}, ${run.memory_limit_mb} MB)`);

			const assigned = job.assign(proc.pid);
			if (job.kind === "win32-job" && !assigned) {
				this.emit(run.id, "lifecycle", "UWAGA: nie udało się przypisać procesu do Job Object — limity nie działają");
			}

			const timeoutSec = run.timeout_sec ?? config.timeoutSec;
			if (timeoutSec > 0) {
				active.timer = setTimeout(() => {
					active.timedOut = true;
					this.emit(run.id, "lifecycle", `przekroczony limit czasu (${timeoutSec}s) — ubijam run`);
					this.terminate(active);
				}, timeoutSec * 1000);
			}

			const stdoutDone = pumpLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
				extractUsage(line, usage);
				this.emit(run.id, "stdout", line, "stdout");
			});
			const stderrDone = pumpLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
				extractUsage(line, usage);
				this.emit(run.id, "stderr", line, "stderr");
			});

			if (resolved.stdinPrompt && proc.stdin !== undefined) {
				proc.stdin.write(run.prompt);
				await proc.stdin.end();
			}

			exitCode = await proc.exited;
			await Promise.all([stdoutDone, stderrDone]);
		} catch (err) {
			this.emit(
				run.id,
				"lifecycle",
				`błąd uruchomienia agenta: ${err instanceof Error ? err.message : String(err)}`,
			);
			exitCode = exitCode ?? -1;
		} finally {
			if (active.timer !== null) clearTimeout(active.timer);
		}

		// ---------- finalizacja ----------
		this.db.updateRun(run.id, { state: "finalizing", exit_code: exitCode });
		this.emit(run.id, "lifecycle", "finalizacja: commit szczątków, statystyki, push");

		let commitsAhead = 0;
		let filesChanged = 0;
		let insertions = 0;
		let deletions = 0;
		let pushed: boolean | null = null;
		let pushMessage = "";
		let pushError: string | null = null;
		let deliveryState: DeliveryState = "not_attempted";

		try {
			const commit = await g.commitAll(
				worktree,
				`agentdock: ${run.prompt.split("\n")[0]?.slice(0, 72) ?? "praca agenta"}`,
				{ name: `${author} (AgentDock)`, email: "agentdock@localhost" },
				{ excludesFile },
			);
			if (commit.committed) {
				this.emit(run.id, "lifecycle", `zacommitowano niezacommitowane zmiany agenta (${commit.sha?.slice(0, 10)})`);
			}
			commitsAhead = await g.commitsAhead(worktree, base.sha);
			const stat = await g.diffStat(worktree, base.sha);
			filesChanged = stat.filesChanged;
			insertions = stat.insertions;
			deletions = stat.deletions;

			// Stan dostawy jest teraz jawny: odróżniamy „nie było czego pushować”
			// od „push się nie udał” i od „operator wyłączył push dla tego runu”.
			const cancelled = active.cancelReason !== null;
			if (cancelled) {
				deliveryState = "skipped_cancelled";
				this.emit(run.id, "lifecycle", "run anulowany — gałąź zostaje lokalnie (bez pusha)");
			} else if (commitsAhead <= 0) {
				deliveryState = "skipped_no_commits";
				this.emit(run.id, "lifecycle", "brak commitów w gałęzi runu — nie ma czego pushować");
			} else if (run.push_enabled === 0) {
				deliveryState = "skipped_disabled";
				this.emit(run.id, "lifecycle", "push wyłączony dla tego runu (push=false) — gałąź zostaje lokalnie");
			} else {
				const result = await g.pushBranch(worktree, branch);
				pushed = result.pushed;
				pushMessage = result.message;
				if (result.pushed) {
					deliveryState = "pushed";
					this.emit(run.id, "lifecycle", `gałąź ${branch} wypchnięta na origin`);
				} else {
					deliveryState = "failed";
					pushError = result.message;
					this.emit(run.id, "lifecycle", `push nie udał się: ${result.message}`);
				}
			}

			const removed = await g.worktreeRemove(project.path, worktree);
			if (removed.code !== 0) {
				this.emit(run.id, "lifecycle", `nie udało się usunąć worktree: ${removed.stderr || removed.stdout}`);
			} else {
				this.emit(run.id, "lifecycle", "worktree posprzątany (gałąź zostaje w repo)");
			}
			await g.pruneWorktrees(project.path);
		} catch (err) {
			this.emit(
				run.id,
				"lifecycle",
				`błąd finalizacji: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		let state: RunState;
		let failureReason: string | null = null;
		if (active.cancelReason !== null) {
			state = "cancelled";
			failureReason = active.cancelReason;
		} else if (active.timedOut) {
			state = "failed";
			failureReason = `przekroczony limit czasu (${run.timeout_sec}s)`;
		} else if (exitCode !== 0) {
			state = "failed";
			failureReason = `agent zakończył się kodem ${exitCode}`;
		} else {
			state = "succeeded";
		}

		this.db.updateRun(run.id, {
			state,
			ended_at: new Date().toISOString(),
			failure_reason: failureReason,
			cost_usd: usage.costUsd,
			tokens_in: usage.tokensIn,
			tokens_out: usage.tokensOut,
			commits_ahead: commitsAhead,
			files_changed: filesChanged,
			insertions,
			deletions,
			pushed: pushed === null ? 0 : pushed ? 1 : 0,
			job_kind: job.kind,
			delivery_state: deliveryState,
			push_error: pushError,
		});
		this.emit(
			run.id,
			"lifecycle",
			`run zakończony: ${state}${failureReason !== null ? ` (${failureReason})` : ""}` +
				` | commity: ${commitsAhead}, pliki: ${filesChanged} (+${insertions}/-${deletions})` +
				` | koszt: ${usage.costUsd === null ? "n/d" : `$${usage.costUsd.toFixed(4)}`}` +
				` | dostawa: ${deliveryState}` +
				(pushMessage !== "" ? ` (${pushMessage})` : ""),
		);

		job.close();
		this.active.delete(run.id);
		this.log("run finished", { runId: run.id, state, commitsAhead, pushed, deliveryState });
		this.tick();
	}
}
