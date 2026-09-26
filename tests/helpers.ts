/**
 * Wspólny warsztat testowy: tymczasowe repo + bare origin + baza + sejf +
 * rejestr ról + runner. Używany przez `agentdock.test.ts` (jądro) i
 * `ouroboros.test.ts` (Faza 1–2: sejf, role, migracje, dostawa).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_AGENTS, DEFAULT_ROUTING, defaultConfig, type AgentDockConfig } from "../src/config.ts";
import { AgentDockDb, type RunRow, isTerminal } from "../src/db.ts";
import * as g from "../src/git.ts";
import { appPaths, ensureDirs, type AppPaths } from "../src/paths.ts";
import { addProject } from "../src/projects.ts";
import { AgentRegistry } from "../src/registry.ts";
import { Runner } from "../src/runner.ts";
import { ApiVault } from "../src/vault.ts";

export const MAIN_ENTRY = resolve(import.meta.dir, "..", "src", "main.ts");

export interface Harness {
	readonly root: string;
	readonly paths: AppPaths;
	readonly db: AgentDockDb;
	readonly vault: ApiVault;
	readonly agents: AgentRegistry;
	readonly config: AgentDockConfig;
	readonly repo: string;
	readonly origin: string;
	readonly projectId: string;
	runner(): Runner;
	waitTerminal(runId: string, timeoutMs?: number): Promise<RunRow>;
	close(): void;
}

const GIT_IDENTITY = ["-c", "user.name=AgentDock", "-c", "user.email=agentdock@localhost"];

export interface HarnessOptions {
	/** Sonda modelu lokalnego (Ollama) używana przez router w testach. */
	readonly probeOllama?: (baseUrl: string) => Promise<{
		available: boolean;
		baseUrl: string;
		models: string[];
		error: string | null;
	}>;
}

export async function makeHarness(prefix: string, options: HarnessOptions = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
	const paths = appPaths(root);
	ensureDirs(paths);

	const repo = join(root, "repo");
	const origin = join(root, "origin.git");
	mkdirSync(repo, { recursive: true });
	await g.git(["init", "--initial-branch=main"], { cwd: repo });
	writeFileSync(join(repo, "README.md"), "# test\n");
	await g.git(["add", "-A"], { cwd: repo });
	await g.git([...GIT_IDENTITY, "commit", "-m", "init: test repo"], { cwd: repo });
	await g.git(["init", "--bare", "--initial-branch=main", origin]);
	await g.git(["-C", repo, "remote", "add", "origin", origin]);
	await g.git(["-C", repo, "push", "--quiet", "-u", "origin", "main"]);

	const db = new AgentDockDb(paths.db);
	const vault = new ApiVault(db);
	const agents = new AgentRegistry(db, vault);
	agents.seed({ ...DEFAULT_AGENTS });

	const config: AgentDockConfig = {
		...defaultConfig(),
		agents: { ...DEFAULT_AGENTS },
		timeoutSec: 120,
		memoryLimitMb: 1024,
		// W testach jądra router jest WYŁĄCZONY: wynik nie może zależeć od tego,
		// czy na maszynie przypadkiem działa Ollama (u twórcy działa).
		// Testy routera włączają go świadomie i podają własną sondę.
		routing: { ...structuredClone(DEFAULT_ROUTING), enabled: false },
	};
	const project = await addProject(db, paths, repo, "test");

	// W testach `bun test` nie ustawia argv[1] na src/main.ts — wskazujemy plik
	// wejściowy jawnie, żeby wbudowany agent demo dał się odpalić.
	process.env.AGENTDOCK_SELF_ENTRY = MAIN_ENTRY;

	const harness: Harness = {
		root,
		paths,
		db,
		vault,
		agents,
		config,
		repo,
		origin,
		projectId: project.id,
		runner(): Runner {
			return new Runner(db, paths, () => config, {
				vault,
				agents,
				...(options.probeOllama !== undefined ? { probeOllama: options.probeOllama } : {}),
			});
		},
		async waitTerminal(runId: string, timeoutMs = 90_000): Promise<RunRow> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const current = db.getRun(runId);
				if (current !== null && isTerminal(current.state)) return current;
				if (Date.now() > deadline) throw new Error(`run ${runId} nie zakończył się w ${timeoutMs} ms`);
				await Bun.sleep(200);
			}
		},
		close(): void {
			try {
				db.close();
			} catch {
				// baza mogła być już zamknięta
			}
			delete process.env.AGENTDOCK_SELF_ENTRY;
			try {
				// Windows potrafi trzymać uchwyt katalogu chwilę po zamknięciu bazy.
				rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			} catch {
				// zostawiamy katalog w %TEMP%
			}
		},
	};
	return harness;
}

/** Zdarzenia runu jako jeden string (wygodne w asercjach `toContain`). */
export function eventsText(h: Harness, runId: string): string {
	return h.db
		.listEvents(runId, 0)
		.map((e) => e.text)
		.join("\n");
}
