/**
 * AgentDock / Ouroboros — punkt wejścia.
 *
 *   agentdock                 → start serwera + UI w przeglądarce (domyślne)
 *   agentdock serve           → to samo, jawnie
 *   agentdock demo            → zakłada repo demo, rejestruje projekt i odpala run
 *   agentdock run -p "..." [--project <id|ścieżka>] [--agent demo] [--no-push]
 *   agentdock projects [add <ścieżka|url> | rm <id>]
 *   agentdock agents [add|rm|enable|disable|keys] …     ← Faza 2: role w bazie
 *   agentdock keys [add|rm|enable|disable|rotate] …     ← Faza 1: sejf kluczy API
 *   agentdock runs | show <id> | tail <id> | cancel <id>
 *   agentdock doctor
 *   agentdock --demo-agent    → tryb wewnętrzny: AgentDock jako agent (presety)
 *
 * Runy obsługuje ten proces, który jest „gospodarzem”: serwer (gdy działa) albo
 * CLI (gdy serwer jest wyłączony). Oba piszą do tej samej bazy, więc UI widzi
 * wszystko niezależnie od tego, kto wystartował run.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentBinaryAvailable } from "./agents.ts";
import { DEFAULT_AGENTS, loadConfig, type AgentDockConfig } from "./config.ts";
import { AgentDockDb, SCHEMA_VERSION, type ProjectRow, type RunRow, isTerminal } from "./db.ts";
import { runDemoAgent } from "./demo-agent.ts";
import * as g from "./git.ts";
import { jobObjectsSupported } from "./job.ts";
import { APP_NAME, APP_VERSION, appPaths, ensureDirs, resolveRoot, type AppPaths } from "./paths.ts";
import { addProject } from "./projects.ts";
import { AgentRegistry, isSecretLikeEnvName } from "./registry.ts";
import { probeOllama, resetRouterCaches } from "./router.ts";
import { Runner, type DispatchInput } from "./runner.ts";
import { startServer } from "./server.ts";

import { ApiVault, dpapiAvailable, vaultProtectionMode } from "./vault.ts";

/** Wersja presetów wbudowanych — podbij, gdy dodajesz nowy preset (Faza 3: `ollama-local`). */
const PRESETS_VERSION = 1;

function log(msg: string, extra?: Record<string, unknown>): void {
	const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
	process.stdout.write(`${new Date().toISOString()} ${msg}${suffix}\n`);
}

// ---------------------------------------------------------------------------
// tryb wewnętrzny: ten sam plik wykonywalny działa jako agent demo
// ---------------------------------------------------------------------------
//
// Sprawdzamy WYŁĄCZNIE pierwszą pozycję argumentów, nigdy „gdziekolwiek
// w argv”: `agents add … --args "--demo-agent"` musi utworzyć rolę, a nie
// uruchomić agenta (błąd złapany podczas weryfikacji Fazy 2).
//   dev:      [bun, src/main.ts, "--demo-agent"]        → argv[2]
//   skompilowane: [agentdock.exe, "--demo-agent"]        → argv[1]
if (process.argv[1] === "--demo-agent" || process.argv[2] === "--demo-agent") {
	process.exit(await runDemoAgent());
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------
interface Boot {
	readonly paths: AppPaths;
	readonly config: AgentDockConfig;
	readonly db: AgentDockDb;
	readonly vault: ApiVault;
	readonly agents: AgentRegistry;
}

function bootstrap(): Boot {
	const paths = appPaths(resolveRoot());
	ensureDirs(paths);
	const { config } = loadConfig(paths.config);
	// Konstruktor bazy wykonuje migracje (Faza 0) — stara baza z epoki
	// AgentDocka przechodzi je bez utraty danych.
	const db = new AgentDockDb(paths.db);
	const vault = new ApiVault(db);
	const agents = new AgentRegistry(db, vault);
	// Zasiew ról z presetów + config.json, ale wyłącznie gdy rejestr jest pusty.
	const seeded = agents.seed({ ...DEFAULT_AGENTS, ...config.agents });
	if (seeded > 0) log(`rejestr agentów: zasiano ${seeded} ról (presety + config.json)`);
	// Nowe presety wbudowane (np. `ollama-local` z Fazy 3) dochodzą raz na wersję.
	const synced = agents.syncPresets(DEFAULT_AGENTS, PRESETS_VERSION);
	if (synced > 0) log(`rejestr agentów: dodano ${synced} nowych presetów wbudowanych`);
	return { paths, config, db, vault, agents };
}

function pidFilePath(root: string): string {
	return join(root, "agentdock.pid");
}

function openBrowser(url: string): void {
	const cmd =
		process.platform === "win32"
			? ["cmd", "/c", "start", "", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
	} catch {
		// brak przeglądarki nie może wywalić serwera — URL i tak jest wypisany
	}
}

async function serverAlive(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
		return res.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// gospodarz runów: HTTP (serwer działa) albo in-process (serwer wyłączony)
// ---------------------------------------------------------------------------
interface Host {
	readonly kind: "http" | "local";
	dispatch(input: DispatchInput): Promise<string>;
	cancel(runId: string): Promise<void>;
	close(): void;
}

function httpHost(config: AgentDockConfig): Host {
	const base = `http://127.0.0.1:${config.port}`;
	const call = async (path: string, method: string, body?: unknown): Promise<unknown> => {
		let res: Response;
		try {
			res = await fetch(`${base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${config.token}`,
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		} catch {
			throw new Error(`brak połączenia z AgentDock na ${base}`);
		}
		const text = await res.text();
		const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
		if (!res.ok) {
			throw new Error(typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`);
		}
		return parsed;
	};
	return {
		kind: "http",
		async dispatch(input) {
			const res = (await call("/api/runs", "POST", input)) as { run: { id: string } };
			return res.run.id;
		},
		async cancel(runId) {
			await call(`/api/runs/${runId}/cancel`, "POST");
		},
		close() {},
	};
}

function localHost(boot: Boot): Host & { runner: Runner } {
	const runner = new Runner(boot.db, boot.paths, () => boot.config, {
		vault: boot.vault,
		agents: boot.agents,
		log,
	});
	runner.recover();
	return {
		kind: "local",
		runner,
		async dispatch(input) {
			return runner.dispatch(input).id;
		},
		async cancel(runId) {
			if (!runner.cancel(runId)) throw new Error(`run ${runId} nie jest aktywny w tym procesie`);
		},
		close() {
			boot.db.close();
		},
	};
}

// ---------------------------------------------------------------------------
// serwer
// ---------------------------------------------------------------------------
async function serve(args: { open: boolean; port?: number }): Promise<void> {
	const boot = bootstrap();
	const { paths, config, db, vault, agents } = boot;
	if (args.port !== undefined) config.port = args.port;

	const runner = new Runner(db, paths, () => config, { vault, agents, log });
	const recovered = runner.recover();

	const server = startServer({
		db,
		runner,
		paths,
		getConfig: () => config,
		vault,
		agents,
		log,
	});
	writeFileSync(pidFilePath(paths.root), String(process.pid), "utf8");

	const url = `http://127.0.0.1:${config.port}`;
	const uiUrl = `${url}/?token=${encodeURIComponent(config.token)}`;
	const protection = vaultProtectionMode();

	log(`${APP_NAME} v${APP_VERSION} działa`, {
		url,
		data: paths.root,
		schemaVersion: SCHEMA_VERSION,
		jobObjects: jobObjectsSupported(),
		vault: protection,
		agents: agents.list().length,
		keys: vault.list().length,
		maxConcurrent: config.maxConcurrent,
		recoveredRuns: recovered,
	});
	process.stdout.write(
		`\n  UI:      ${url}\n  token:   ${config.token}\n  dane:    ${paths.root}\n` +
			`  schemat: v${SCHEMA_VERSION}    sejf: ${protection} (${vault.list().length} kluczy)    role: ${agents.list().length}\n` +
			`  limity:  ${config.memoryLimitMb} MB / ${config.timeoutSec}s / równolegle ${config.maxConcurrent}` +
			`${jobObjectsSupported() ? " (Job Objects aktywne)" : " (BEZ limitów systemowych)"}\n` +
			(recovered > 0 ? `  uwaga:   ${recovered} run(y) z poprzedniej sesji oznaczono jako przerwane\n` : "") +
			"\n  Zatrzymanie: Ctrl-C (albo `agentdock.cmd stop`).\n\n",
	);
	if (args.open) openBrowser(uiUrl);

	const shutdown = async (): Promise<void> => {
		process.stdout.write("\nzatrzymuję AgentDock…\n");
		await runner.drain();
		server.stop(true);
		rmSync(pidFilePath(paths.root), { force: true });
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// repo demo + pierwszy run
// ---------------------------------------------------------------------------
async function ensureDemoRepo(db: AgentDockDb, paths: AppPaths): Promise<ProjectRow> {
	const dir = join(paths.root, "demo");
	const repo = join(dir, "repo");
	const origin = join(dir, "origin.git");
	mkdirSync(dir, { recursive: true });

	if (!existsSync(join(repo, ".git"))) {
		mkdirSync(repo, { recursive: true });
		await g.git(["init", "--initial-branch=main"], { cwd: repo });
		writeFileSync(
			join(repo, "README.md"),
			[
				"# AgentDock demo",
				"",
				"Repo-zabawka do sprawdzenia pełnego cyklu runu bez klucza do modelu:",
				"worktree → agent → commit → push na lokalny origin (origin.git obok).",
				"",
			].join("\n"),
			"utf8",
		);
		const identity = ["-c", "user.name=AgentDock", "-c", "user.email=agentdock@localhost"];
		await g.git(["add", "-A"], { cwd: repo });
		await g.git([...identity, "commit", "-m", "init: repo demo"], { cwd: repo });
	}
	if (!existsSync(join(origin, "HEAD"))) {
		await g.git(["init", "--bare", "--initial-branch=main", origin]);
	}
	const remote = await g.git(["-C", repo, "remote", "get-url", "origin"]);
	if (remote.code !== 0) {
		await g.git(["-C", repo, "remote", "add", "origin", origin]);
	}
	await g.git(["-C", repo, "push", "--quiet", "-u", "origin", "main"], {
		env: { GIT_TERMINAL_PROMPT: "0" },
	});

	const existing = db.findProjectByPath(repo);
	return existing ?? (await addProject(db, paths, repo, "demo"));
}

function formatRunLine(run: RunRow): string {
	const duration =
		run.started_at !== null && run.ended_at !== null
			? `${Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
			: "—";
	const delivery = run.delivery_state === null ? "" : ` ${run.delivery_state}`;
	const route = run.route_tier === null ? "" : ` [${run.route_tier}]`;
	return [
		run.id.padEnd(22),
		String(run.state).padEnd(10),
		`${run.agent}${route}`.padEnd(18),
		duration.padStart(6),
		`${run.commits_ahead ?? 0} commit`,
		run.cost_usd === null ? "—" : `$${run.cost_usd.toFixed(4)}`,
		`${run.branch ?? ""}${delivery}`,
	].join("  ");
}

/** Jednolinijkowy opis decyzji routera (Faza 3) do `agentdock show`. */
function describeRoute(run: RunRow): string {
	if (run.route_tier === null) return "nieaktywny (routing wyłączony lub run z epoki przed Fazą 3)";
	let detail = "";
	try {
		const parsed = JSON.parse(run.route_json ?? "{}") as Record<string, unknown>;
		const parts: string[] = [];
		if (typeof parsed.reason === "string") parts.push(parsed.reason);
		if (parsed.forced === true && typeof parsed.forcedBy === "string") parts.push(`wymuszone przez: ${parsed.forcedBy}`);
		if (typeof parsed.effectiveAgent === "string") parts.push(`rola efektywna: ${parsed.effectiveAgent}`);
		const warnings = Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [];
		if (warnings.length > 0) parts.push(`ostrzeżenia: ${warnings.join("; ")}`);
		detail = parts.join(" · ");
	} catch {
		detail = run.route_json ?? "";
	}
	return `${run.route_tier}${run.route_model !== null ? ` (${run.route_model})` : ""} — ${detail}`;
}

/** Czeka na stan terminalny, wypisując nowe zdarzenia z bazy (działa między procesami). */
async function followRun(db: AgentDockDb, runId: string, follow: boolean): Promise<RunRow> {
	let from = 0;
	for (;;) {
		for (const event of db.listEvents(runId, from)) {
			from = event.seq;
			if (follow) {
				const tag = event.kind === "lifecycle" ? "·" : event.stream === "stderr" ? "!" : ">";
				process.stdout.write(`${tag} ${event.text}\n`);
			}
		}
		const run = db.getRun(runId);
		if (run === null) throw new Error(`nie ma runu ${runId}`);
		if (isTerminal(run.state)) return run;
		await Bun.sleep(500);
	}
}

async function hostFor(boot: Boot): Promise<Host> {
	if (await serverAlive(boot.config.port)) return httpHost(boot.config);
	process.stdout.write(
		"uwaga: serwer AgentDock nie działa — ten run obsłuży proces CLI " +
			"(UI nie zobaczy go na żywo, dopóki nie włączysz aplikacji).\n",
	);
	return localHost(boot);
}

async function demo(): Promise<void> {
	const boot = bootstrap();
	const { paths, db, vault } = boot;
	const project = await ensureDemoRepo(db, paths);
	process.stdout.write(`projekt demo: ${project.id} (${project.path})\n`);
	if (vault.list().length === 0) {
		process.stdout.write(
			"wskazówka: sejf kluczy jest pusty — agent `demo` nie potrzebuje modelu, " +
				'ale prawdziwe role (claude/codex) wymagają klucza: agentdock.cmd cli keys add <etykieta> --env ANTHROPIC_API_KEY\n',
		);
	}

	const host = await hostFor(boot);
	const runId = await host.dispatch({
		projectId: project.id,
		agent: "demo",
		prompt:
			"Dodaj plik NOTATKA.md z krótkim opisem repozytorium i wypisz, co zmieniłeś. [commit]",
	});
	process.stdout.write(`run ${runId} wystartował — oglądam przebieg:\n\n`);

	const run = await followRun(db, runId, true);
	process.stdout.write(`\n${formatRunLine(run)}\n`);

	const origin = join(paths.root, "demo", "origin.git");
	const branches = await g.git(["-C", origin, "branch", "--format=%(refname:short)"]);
	process.stdout.write(`\ngałęzie w origin:\n${branches.stdout}\n`);
	if (run.branch !== null) {
		const show = await g.git(["-C", origin, "log", "--oneline", "-2", run.branch]);
		process.stdout.write(`\nhistoria gałęzi ${run.branch}:\n${show.stdout}\n`);
	}
	if (host.kind === "http") {
		process.stdout.write(`\nUI: http://127.0.0.1:${boot.config.port}\n`);
	} else {
		host.close();
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
	const prefixed = args.find((a) => a.startsWith(`${name}=`));
	return prefixed !== undefined ? prefixed.slice(name.length + 1) : undefined;
}

function printHelp(): void {
	process.stdout.write(
		[
			`${APP_NAME} v${APP_VERSION} — lokalne runy agentów kodujących na Windows`,
			"",
			"  agentdock                                  start UI (domyślnie)",
			"  agentdock serve [--port N] [--no-open]     start serwera bez otwierania przeglądarki",
			"  agentdock demo                             repo demo + run agenta demo (bez klucza API)",
			'  agentdock run -p "<zadanie>" [--project <id|ścieżka>] [--agent demo] [--memory MB] [--timeout S] [--no-push] [--tier auto|local|cloud]',
			"  agentdock routing                          stan Smart Routera (konfiguracja + sonda Ollamy + statystyki)",
			"  agentdock projects [add <ścieżka|url> | rm <id>]",
			"  agentdock agents                           lista ról (rejestr w bazie)",
			'  agentdock agents add <nazwa> --command <cmd> [--args "a|b"] [--stdin] [--env "A,B"] [--description "..."]',
			"  agentdock agents rm|enable|disable <nazwa>",
			"  agentdock agents keys <nazwa> <key-id>…    przypisz klucze z sejfu do roli",
			"  agentdock keys                             lista kluczy (bez sekretów)",
			'  agentdock keys add <etykieta> --env <ZMIENNA> [--provider <p>] [--secret <s>]',
			"  agentdock keys rotate|enable|disable|rm <key-id> [--secret <s>]",
			"  agentdock runs [--limit N]",
			"  agentdock show <run-id> | tail <run-id> | cancel <run-id>",
			"  agentdock doctor",
			"",
		].join("\n"),
	);
}

/** Sekret do zapisu: `--secret`, inaczej z stdin (rurka), inaczej błąd. */
async function resolveSecretInput(args: string[]): Promise<string> {
	const inline = flag(args, "--secret");
	if (inline !== undefined && inline !== "") return inline;
	if (process.stdin.isTTY) {
		throw new Error(
			"podaj sekret przez --secret <wartość> albo przez potok: echo <sekret> | agentdock keys add …",
		);
	}
	const piped = (await new Response(process.stdin as unknown as ReadableStream<Uint8Array>).text()).trim();
	if (piped === "") throw new Error("nie dostałem sekretu (pusty stdin)");
	return piped;
}

async function doctor(): Promise<number> {
	const paths = appPaths(resolveRoot());
	ensureDirs(paths);
	const boot = bootstrap();
	const { config, db, vault, agents } = boot;
	let problems = 0;
	const report = (ok: boolean, label: string, detail: string, fatal = true): void => {
		process.stdout.write(`${ok ? "  OK  " : fatal ? " BŁĄD " : "  --  "} ${label.padEnd(22)} ${detail}\n`);
		if (!ok && fatal) problems += 1;
	};

	process.stdout.write(`\n${APP_NAME} doctor\n\n`);
	report(Bun.which("git") !== null, "git", Bun.which("git") ?? "brak w PATH (wymagany)");
	report(
		jobObjectsSupported(),
		"Job Objects",
		jobObjectsSupported()
			? "limity pamięci + ubijanie całego drzewa procesów"
			: "niedostępne — runy bez limitów systemowych",
	);
	report(existsSync(paths.config), "config.json", paths.config);
	report(db.userVersion() === SCHEMA_VERSION, "schemat bazy", `user_version = ${db.userVersion()} (oczekiwane ${SCHEMA_VERSION})`);

	const protection = vaultProtectionMode();
	report(
		protection !== "unavailable",
		"sejf kluczy API",
		protection === "dpapi"
			? `DPAPI aktywne, ${vault.list().length} kluczy`
			: protection === "plain"
				? `UWAGA: tryb jawny (AGENTDOCK_INSECURE_SECRETS=1), ${vault.list().length} kluczy`
				: "DPAPI niedostępne — nie zapiszę sekretów",
	);

	const roles = agents.list();
	report(roles.length > 0, "rejestr ról", `${roles.length} agentów: ${roles.map((a) => a.name).join(", ")}`);

	for (const spec of roles) {
		const available = agentBinaryAvailable(spec);
		report(
			available,
			`agent: ${spec.name}`,
			available
				? spec.builtin
					? "wbudowany (bez klucza API)"
					: `${Bun.which(spec.command)}${spec.keys.length > 0 ? `, klucze: ${spec.keys.map((k) => k.label).join(", ")}` : ", bez kluczy w sejfie"}`
				: `brak "${spec.command}" w PATH — doinstaluj, jeśli chcesz go używać`,
			spec.builtin === true,
		);
		const secretLike = spec.env.filter((name) => isSecretLikeEnvName(name));
		if (secretLike.length > 0) {
			process.stdout.write(
				`  --   agent: ${spec.name}`.padEnd(34) +
					`w liście env ma nazwy sekretopodobne (${secretLike.join(", ")}) — przenieś do sejfu i przypisz do roli\n`,
			);
		}
	}

	if (!dpapiAvailable() && protection !== "plain") {
		process.stdout.write(
			"       wskazówka: bez DPAPI klucze API nie będą zapisywane; użyj Windows albo AGENTDOCK_INSECURE_SECRETS=1\n",
		);
	}

	// ---------- Smart Router (Faza 3) ----------
	const routing = config.routing;
	report(
		routing.enabled,
		"router",
		routing.enabled
			? `tryb ${routing.mode}, klasyfikator ${routing.classifier}, próg ${routing.threshold}`
			: "wyłączony (routing.enabled = false) — runy nie dostają decyzji o modelu",
		false,
	);
	if (routing.enabled) {
		const ollama = await probeOllama(routing.local.baseUrl);
		report(
			ollama.available,
			"model lokalny",
			ollama.available
				? `${routing.local.baseUrl} · modele: ${ollama.models.length > 0 ? ollama.models.slice(0, 4).join(", ") : "(brak pobranych modeli)"}`
				: `${routing.local.baseUrl} nie odpowiada (${ollama.error ?? "brak odpowiedzi"}) — proste zadania pójdą do chmury z ostrzeżeniem`,
			false,
		);
		if (routing.local.agent !== null) {
			const localSpec = agents.get(routing.local.agent);
			report(
				localSpec !== null,
				"rola lokalna",
				localSpec === null
					? `brak roli "${routing.local.agent}" — router nie może zrealizować poziomu local`
					: `${localSpec.name} → ${localSpec.command}${Bun.which(localSpec.command) === null ? " (brak binarki w PATH)" : ""}`,
				false,
			);
		}
		const stats = db.routingStats();
		process.stdout.write(
			`  --   router: statystyki        ` +
				`lokalnie: ${stats.local}, chmura: ${stats.cloud}, bez routingu: ${stats.unrouted}, koszt chmury: $${stats.cloudCostUsd.toFixed(4)}\n`,
		);
	}

	if (await serverAlive(config.port)) {
		report(true, "serwer", `działa na porcie ${config.port}`);
	} else {
		report(false, "serwer", `nie odpowiada na porcie ${config.port} — uruchom: agentdock.cmd start`, false);
	}
	db.close();
	process.stdout.write(
		problems === 0 ? "\nWszystko gotowe.\n\n" : `\n${problems} problem(y) — patrz wyżej.\n\n`,
	);
	return problems === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI: agenci i klucze
// ---------------------------------------------------------------------------
function cliAgents(boot: Boot, args: string[]): number {
	const { db, vault, agents } = boot;
	const sub = args[1];

	if (sub === "add") {
		const name = args[2] ?? "";
		const command = flag(args, "--command");
		if (command === undefined || command === "") {
			process.stderr.write('podaj komendę: agents add <nazwa> --command "claude" [--args "a|b"]\n');
			db.close();
			return 2;
		}
		const argsRaw = flag(args, "--args");
		const envRaw = flag(args, "--env");
		try {
			const created = agents.create({
				name,
				command,
				description: flag(args, "--description") ?? "",
				args: argsRaw === undefined ? [] : argsRaw.split("|").map((a) => a.trim()),
				stdinPrompt: args.includes("--stdin"),
				env: envRaw === undefined ? [] : envRaw.split(",").map((e) => e.trim()),
			});
			process.stdout.write(`dodano rolę ${created.name} (${created.command})\n`);
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	if (sub === "rm") {
		try {
			agents.remove(args[2] ?? "");
			process.stdout.write(`usunięto rolę ${args[2] ?? ""}\n`);
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	if (sub === "enable" || sub === "disable") {
		try {
			agents.update(args[2] ?? "", { enabled: sub === "enable" });
			process.stdout.write(`${sub === "enable" ? "włączono" : "wyłączono"} rolę ${args[2] ?? ""}\n`);
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	if (sub === "keys") {
		const name = args[2] ?? "";
		const keyIds = args.slice(3).filter((a) => !a.startsWith("--"));
		try {
			const updated = agents.setKeys(name, keyIds);
			process.stdout.write(
				`rola ${updated.name}: ${updated.keys.length === 0 ? "bez kluczy" : updated.keys.map((k) => `${k.label} (${k.envVar})`).join(", ")}\n`,
			);
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	// domyślnie: lista
	for (const spec of agents.list()) {
		const keys = spec.keys.length === 0 ? "—" : spec.keys.map((k) => k.label).join(", ");
		const flags = [spec.builtin ? "wbudowany" : "własny", spec.enabled ? "aktywny" : "wyłączony"];
		process.stdout.write(
			`${spec.name.padEnd(16)} ${spec.command.padEnd(18)} ${flags.join("/").padEnd(20)} klucze: ${keys}\n`,
		);
	}
	void vault;
	db.close();
	return 0;
}

async function cliKeys(boot: Boot, args: string[]): Promise<number> {
	const { db, vault } = boot;
	const sub = args[1];

	if (sub === "add") {
		const label = args[2] ?? "";
		const envVar = flag(args, "--env") ?? "";
		try {
			const secret = await resolveSecretInput(args);
			const created = vault.create({
				label,
				provider: flag(args, "--provider") ?? "other",
				envVar,
				secret,
			});
			process.stdout.write(
				`dodano klucz ${created.id} — ${created.label} → ${created.envVar} (${created.protection}, końcówka …${created.hint})\n`,
			);
			process.stdout.write('przypisz go do roli: agentdock agents keys <rola> ' + created.id + "\n");
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	if (sub === "rotate") {
		const id = args[2] ?? "";
		try {
			const secret = await resolveSecretInput(args);
			const updated = vault.update(id, { secret });
			process.stdout.write(`zrotowano klucz ${updated.id} (…${updated.hint})\n`);
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	if (sub === "enable" || sub === "disable") {
		try {
			const updated = vault.update(args[2] ?? "", { disabled: sub === "disable" });
			process.stdout.write(`${sub === "disable" ? "wyłączono" : "włączono"} klucz ${updated.id}\n`);
			db.close();
			return 0;
		} catch (err) {
			process.stderr.write(`błąd: ${err instanceof Error ? err.message : String(err)}\n`);
			db.close();
			return 1;
		}
	}

	if (sub === "rm") {
		vault.remove(args[2] ?? "");
		process.stdout.write(`usunięto klucz ${args[2] ?? ""}\n`);
		db.close();
		return 0;
	}

	const rows = vault.list();
	if (rows.length === 0) {
		process.stdout.write(
			"sejf jest pusty — dodaj klucz: agentdock keys add anthropic --env ANTHROPIC_API_KEY --provider anthropic\n",
		);
	}
	for (const key of rows) {
		const used = key.lastUsedAt === null ? "nigdy" : key.lastUsedAt.slice(0, 19).replace("T", " ");
		process.stdout.write(
			`${key.id.padEnd(14)} ${key.label.padEnd(20)} ${key.provider.padEnd(10)} ${key.envVar.padEnd(24)} …${key.hint}  ${key.disabled ? "wyłączony" : "aktywny"}  użyty: ${used}\n`,
		);
	}
	db.close();
	return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const command = args[0] ?? "serve";

	if (command === "--help" || command === "-h" || command === "help") {
		printHelp();
		return 0;
	}
	if (command === "--version" || command === "-v" || command === "version") {
		process.stdout.write(`${APP_NAME} ${APP_VERSION}\n`);
		return 0;
	}
	if (command === "doctor") return doctor();

	if (command === "serve" || command === "start") {
		const portRaw = flag(args, "--port");
		await serve({
			open: !args.includes("--no-open"),
			...(portRaw !== undefined ? { port: Number.parseInt(portRaw, 10) } : {}),
		});
		return 0;
	}

	if (command === "routing") {
		const boot = bootstrap();
		const { config, db } = boot;
		if (args.includes("--fresh")) resetRouterCaches();
		const r = config.routing;
		process.stdout.write(
			`\nSmart Router: ${r.enabled ? "włączony" : "WYŁĄCZONY"} · tryb ${r.mode} · klasyfikator ${r.classifier} · próg ${r.threshold}\n` +
				`  poziom lokalny: rola ${r.local.agent ?? "(brak)"} · model ${r.local.model ?? "(domyślny roli)"} · ${r.local.baseUrl}\n` +
				`  poziom chmurowy: rola ${r.cloud.agent ?? "(bez zamiany)"} · model ${r.cloud.model ?? "(domyślny roli)"}\n\n`,
		);
		const ollama = await probeOllama(r.local.baseUrl);
		process.stdout.write(
			ollama.available
				? `  Ollama: odpowiada (${ollama.models.length} modeli: ${ollama.models.slice(0, 6).join(", ") || "—"})\n\n`
				: `  Ollama: brak odpowiedzi (${ollama.error ?? "—"}) — proste zadania pójdą do chmury z ostrzeżeniem\n\n`,
		);
		const stats = db.routingStats();
		process.stdout.write(
			`  runy: lokalnie ${stats.local} · chmura ${stats.cloud} · bez routingu ${stats.unrouted}\n` +
				`  koszt w chmurze: $${stats.cloudCostUsd.toFixed(4)}\n\n`,
		);
		db.close();
		return 0;
	}

	if (command === "demo") {
		await demo();
		return 0;
	}

	if (command === "agents") {
		const boot = bootstrap();
		return cliAgents(boot, args);
	}

	if (command === "keys") {
		const boot = bootstrap();
		return cliKeys(boot, args);
	}

	if (command === "run") {
		const boot = bootstrap();
		const { paths, db } = boot;
		const prompt = flag(args, "-p") ?? flag(args, "--prompt") ?? "";
		if (prompt.trim() === "") {
			process.stderr.write('podaj zadanie: agentdock run -p "co ma zrobić agent"\n');
			return 2;
		}
		let projectId = flag(args, "--project") ?? "";
		if (projectId === "") {
			const projects = db.listProjects();
			if (projects.length === 0) {
				process.stderr.write("brak projektów — dodaj: agentdock projects add <ścieżka|url>\n");
				return 2;
			}
			projectId = (projects[0] as ProjectRow).id;
		} else if (db.getProject(projectId) === null) {
			const project = await addProject(db, paths, resolve(projectId));
			projectId = project.id;
		}
		const memory = flag(args, "--memory");
		const timeout = flag(args, "--timeout");
		const tierRaw = flag(args, "--tier");
		if (tierRaw !== undefined && !["auto", "local", "cloud"].includes(tierRaw)) {
			process.stderr.write(`--tier musi być auto|local|cloud (dostałem "${tierRaw}")\n`);
			return 2;
		}
		const host = await hostFor(boot);
		const runId = await host.dispatch({
			projectId,
			agent: flag(args, "--agent") ?? "demo",
			prompt,
			...(memory !== undefined ? { memoryLimitMb: Number.parseInt(memory, 10) } : {}),
			...(timeout !== undefined ? { timeoutSec: Number.parseInt(timeout, 10) } : {}),
			...(args.includes("--no-push") ? { push: false } : {}),
			...(tierRaw !== undefined ? { tier: tierRaw as "auto" | "local" | "cloud" } : {}),
		});
		process.stdout.write(`run ${runId} wystartował\n`);
		const run = args.includes("--no-follow")
			? (db.getRun(runId) as RunRow)
			: await followRun(db, runId, true);
		process.stdout.write(`\n${formatRunLine(run)}\n`);
		if (run.failure_reason !== null) process.stdout.write(`powód: ${run.failure_reason}\n`);
		if (run.push_error !== null) process.stdout.write(`push: ${run.push_error}\n`);
		if (host.kind === "local") host.close();
		return run.state === "succeeded" ? 0 : 1;
	}

	if (command === "projects") {
		const boot = bootstrap();
		const { paths, db } = boot;
		const sub = args[1];
		if (sub === "add") {
			const target = args[2];
			if (target === undefined) {
				process.stderr.write("podaj ścieżkę albo URL\n");
				return 2;
			}
			const project = await addProject(db, paths, target);
			process.stdout.write(
				`dodano projekt ${project.id} (${project.path}, gałąź ${project.default_branch})\n`,
			);
			db.close();
			return 0;
		}
		if (sub === "rm") {
			db.deleteProject(args[2] ?? "");
			process.stdout.write(`usunięto projekt ${args[2] ?? ""}\n`);
			db.close();
			return 0;
		}
		for (const p of db.listProjects()) {
			process.stdout.write(`${p.id.padEnd(14)} ${p.name}  ${p.path}  (${p.default_branch})\n`);
		}
		db.close();
		return 0;
	}

	if (command === "runs") {
		const { db } = bootstrap();
		const limitRaw = flag(args, "--limit");
		const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 20;
		for (const run of db.listRuns(Number.isFinite(limit) ? limit : 20)) {
			process.stdout.write(`${formatRunLine(run)}\n`);
		}
		db.close();
		return 0;
	}

	if (command === "show" || command === "tail") {
		const { db } = bootstrap();
		const runId = args[1] ?? "";
		const run = await followRun(db, runId, command === "tail");
		process.stdout.write(`\n${formatRunLine(run)}\n`);
		if (command === "show") {
			process.stdout.write(
				`gałąź:   ${run.branch ?? "—"}\npliki:   ${run.files_changed ?? 0} (+${run.insertions ?? 0}/-${run.deletions ?? 0})\n` +
					`dostawa: ${run.delivery_state ?? "—"}${run.push_error !== null ? ` (${run.push_error})` : ""}\n` +
					`klucze:  ${run.keys_used ?? "[]"}\n` +
					`router:  ${describeRoute(run)}\n` +
					`błąd:    ${run.failure_reason ?? "—"}\nprompt:  ${run.prompt.slice(0, 200)}\n`,
			);
		}
		db.close();
		return 0;
	}

	if (command === "cancel") {
		const boot = bootstrap();
		const host = await hostFor(boot);
		await host.cancel(args[1] ?? "");
		process.stdout.write(`anulowano ${args[1] ?? ""}\n`);
		if (host.kind === "local") host.close();
		return 0;
	}

	process.stderr.write(`nieznane polecenie: ${command}\n\n`);
	printHelp();
	return 2;
}

process.exit(await main());
