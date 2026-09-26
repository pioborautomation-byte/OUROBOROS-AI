/**
 * Testy jądra AgentDocka: parser usage, Job Object, projekty, config
 * oraz pełny E2E (worktree → agent → commit → push).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENTS, defaultConfig, loadConfig } from "../src/config.ts";
import { AgentDockDb, type RunRow } from "../src/db.ts";
import * as g from "../src/git.ts";
import { buildExtendedLimitInfo, createRunJob, jobObjectsSupported } from "../src/job.ts";
import { appPaths, ensureDirs } from "../src/paths.ts";
import { addProject } from "../src/projects.ts";
import { resolveAgent } from "../src/agents.ts";
import { extractUsage, type UsageTotals } from "../src/runner.ts";
import { eventsText, makeHarness, type Harness } from "./helpers.ts";

describe("extractUsage", () => {
	test("czyta koszt i tokeny z koperty result (claude-code stream-json)", () => {
		const acc: UsageTotals = { costUsd: null, tokensIn: null, tokensOut: null };
		extractUsage(
			'{"type":"result","total_cost_usd":0.5,"usage":{"input_tokens":100,"output_tokens":20}}',
			acc,
		);
		expect(acc.costUsd).toBe(0.5);
		expect(acc.tokensIn).toBe(100);
		expect(acc.tokensOut).toBe(20);
	});

	test("sumuje kolejne koperty i ignoruje śmieci", () => {
		const acc: UsageTotals = { costUsd: null, tokensIn: null, tokensOut: null };
		extractUsage("nie json", acc);
		extractUsage('{"usage":{"input_tokens":10,"output_tokens":1}}', acc);
		extractUsage('{"total_cost_usd":0.25}', acc);
		extractUsage('{"usage":{"input_tokens":5,"output_tokens":2}}', acc);
		expect(acc.tokensIn).toBe(15);
		expect(acc.tokensOut).toBe(3);
		expect(acc.costUsd).toBe(0.25);
	});
});

describe("placeholdery roli", () => {
	test("podstawia {prompt}, {model}, {tier}, {runId} i {promptFile}", () => {
		const resolved = resolveAgent({
			spec: { command: "ollama", args: ["run", "{model}", "{prompt}"] },
			vars: {
				prompt: "Zrób coś pożytecznego",
				model: "qwen2.5-coder:7b",
				tier: "local",
				runId: "run_abc",
				promptFile: "C:\\runs\\run_abc\\prompt.md",
			},
		});
		expect(resolved.argv).toEqual(["ollama", "run", "qwen2.5-coder:7b", "Zrób coś pożytecznego"]);

		const withFile = resolveAgent({
			spec: { command: "agent", args: ["--task-file", "{promptFile}", "--tier", "{tier}"] },
			vars: { promptFile: "C:\\p.md", tier: "cloud" },
		});
		expect(withFile.argv).toEqual(["agent", "--task-file", "C:\\p.md", "--tier", "cloud"]);
	});

	test("nieznany placeholder zostaje bez zmian (widoczny jako błąd konfiguracji)", () => {
		const resolved = resolveAgent({
			spec: { command: "x", args: ["{nieznany}"] },
			vars: {},
		});
		expect(resolved.argv).toEqual(["x", "{nieznany}"]);
	});
});

describe("Job Object (WinAPI)", () => {
	test("flagi limitów są ustawione, gdy poproszono o pamięć i kill-on-close", () => {
		const info = buildExtendedLimitInfo({
			processMemoryBytes: 128 * 1024 * 1024,
			activeProcessLimit: 4,
			killOnClose: true,
		});
		const dv = new DataView(info.buffer);
		const flags = dv.getUint32(16, true);
		expect(flags & 0x100).toBe(0x100); // PROCESS_MEMORY
		expect(flags & 0x8).toBe(0x8); // ACTIVE_PROCESS
		expect(flags & 0x2000).toBe(0x2000); // KILL_ON_JOB_CLOSE
		expect(dv.getUint32(40, true)).toBe(4);
		expect(dv.getBigUint64(112, true)).toBe(BigInt(128 * 1024 * 1024));
	});

	test("na Windows job jest tworzony i przyjmuje limit", () => {
		if (process.platform !== "win32") return;
		expect(jobObjectsSupported()).toBe(true);
		const job = createRunJob({ memoryLimitBytes: 64 * 1024 * 1024 });
		expect(job.kind).toBe("win32-job");
		job.close();
	});
});

describe("projekty i konfiguracja", () => {
	test("odrzuca katalog, który nie jest repozytorium git", async () => {
		const root = mkdtempSync(join(tmpdir(), "agentdock-prj-"));
		const paths = appPaths(root);
		ensureDirs(paths);
		const db = new AgentDockDb(paths.db);
		await expect(addProject(db, paths, root)).rejects.toThrow(/nie jest repozytorium git/);
		db.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	test("config doładowuje nowe agenty wbudowane i zapisuje plik", () => {
		const root = mkdtempSync(join(tmpdir(), "agentdock-cfg-"));
		const configPath = join(root, "config.json");
		writeFileSync(configPath, JSON.stringify({ port: 9999, agents: { moj: { command: "x", args: [] } } }));
		const { config } = loadConfig(configPath);
		expect(config.port).toBe(9999);
		expect(config.agents.moj).toBeDefined();
		expect(config.agents.demo).toBeDefined();
		expect(config.agents.claude).toBeDefined();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
});

describe("end-to-end: dispatch → worktree → agent → commit → push", () => {
	let h: Harness;
	let run: RunRow;

	beforeAll(async () => {
		h = await makeHarness("agentdock-e2e");
		const runner = h.runner();
		run = await h.waitTerminal(
			runner.dispatch({
				projectId: h.projectId,
				agent: "demo",
				prompt: "Dodaj plik NOTATKA.md i opisz zmiany. [commit]",
			}).id,
		);
	}, 120_000);

	afterAll(() => h?.close());

	test("run kończy się sukcesem", () => {
		expect(run.state).toBe("succeeded");
		expect(run.failure_reason).toBeNull();
	});

	test("agent pracował w worktree na własnej gałęzi, worktree posprzątany", () => {
		expect(run.branch).toStartWith("agentdock/run-");
		expect(run.worktree).not.toBeNull();
		expect(existsSync(run.worktree as string)).toBe(false);
	});

	test("są commity i statystyki diffa", () => {
		expect(run.commits_ahead).toBeGreaterThanOrEqual(1);
		expect(run.files_changed).toBeGreaterThanOrEqual(1);
	});

	test("koszt i tokeny pochodzą z logu agenta", () => {
		expect(run.cost_usd).toBeCloseTo(0.00042, 6);
		expect(run.tokens_in).toBe(1200);
		expect(run.tokens_out).toBe(400);
	});

	test("gałąź runu jest wypchnięta na origin", async () => {
		expect(run.pushed).toBe(1);
		expect(run.delivery_state).toBe("pushed");
		const branches = await g.git(["-C", h.origin, "branch", "--format=%(refname:short)"]);
		expect(branches.stdout.split(/\r?\n/)).toContain(run.branch as string);
		const log = await g.git(["-C", h.origin, "log", "--oneline", run.branch as string]);
		expect(log.stdout).toContain("NOTATKA.md");
	});

	test("zdarzenia runu są zapisane i mają rosnącą sekwencję", () => {
		const events = h.db.listEvents(run.id, 0);
		expect(events.length).toBeGreaterThan(5);
		expect(events[0]?.seq).toBe(1);
		expect(eventsText(h, run.id)).toContain("run zakończony: succeeded");
	});

	test("limit pamięci jest zapisany w wierszu runu (Job Object)", () => {
		expect(run.job_kind).toBe("win32-job");
		expect(run.memory_limit_mb).toBe(h.config.memoryLimitMb);
		expect(run.push_enabled).toBe(1);
	});
});
