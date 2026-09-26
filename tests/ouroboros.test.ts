/**
 * Testy Ouroborosa, Faza 0–2:
 *   - migracje schematu (stara baza AgentDocka musi przejść bez utraty danych),
 *   - sejf kluczy API (DPAPI: zapis, brak wycieku, rotacja, wyłączenie),
 *   - rejestr ról (CRUD w bazie, ochrona agenta wbudowanego, zakaz „sekretów” w env),
 *   - izolacja sekretów (wstrzyknięcie z sejfu + brak przecieku zmiennych hosta),
 *   - jawna dostawa (push=false ⇒ `skipped_disabled`, gałąź zostaje lokalnie).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDockDb, MIGRATIONS, SCHEMA_VERSION } from "../src/db.ts";
import * as g from "../src/git.ts";
import { dpapiAvailable } from "../src/vault.ts";
import { eventsText, makeHarness, type Harness } from "./helpers.ts";

const SECRET = "sekret-abcdefghij"; // 17 znaków

describe("migracje schematu (Faza 0)", () => {
	test("stara baza z user_version = 0 migruje się bez utraty danych", () => {
		const root = mkdtempSync(join(tmpdir(), "ouroboros-migr-"));
		const legacyPath = join(root, "legacy.db");

		// Budujemy bazę „z epoki AgentDocka”: schemat v1, dane, user_version = 0.
		const legacy = new Database(legacyPath, { create: true });
		for (const statement of MIGRATIONS[0]!.sql) legacy.exec(statement);
		legacy.exec(
			"insert into projects (id, name, path, url, default_branch, added_at) values ('prj_old', 'old', 'C:\\repo', null, 'main', '2026-01-01T00:00:00.000Z')",
		);
		legacy.exec(
			"insert into runs (id, project_id, agent, prompt, state, created_at) values ('run_old', 'prj_old', 'demo', 'stary run', 'succeeded', '2026-01-01T00:00:00.000Z')",
		);
		legacy.exec(
			"insert into events (run_id, seq, ts, kind, stream, text) values ('run_old', 1, '2026-01-01T00:00:00.000Z', 'lifecycle', null, 'start')",
		);
		legacy.exec("pragma user_version = 0");
		legacy.close();

		const db = new AgentDockDb(legacyPath);
		expect(db.userVersion()).toBe(SCHEMA_VERSION);

		// Dane z epoki v1 przetrwały.
		const oldRun = db.getRun("run_old");
		expect(oldRun?.prompt).toBe("stary run");
		expect(db.listProjects().map((p) => p.id)).toEqual(["prj_old"]);
		expect(db.listEvents("run_old", 0).length).toBe(1);

		// Nowe kolumny mają sensowne wartości domyślne.
		expect(oldRun?.push_enabled).toBe(1);
		expect(oldRun?.delivery_state).toBeNull();
		expect(oldRun?.keys_used).toBeNull();

		// Nowe tabele istnieją.
		expect(db.raw.query("select count(*) as n from api_keys").get()).toEqual({ n: 0 });
		expect(db.raw.query("select count(*) as n from agents").get()).toEqual({ n: 0 });
		expect(db.raw.query("select count(*) as n from agent_keys").get()).toEqual({ n: 0 });
		db.close();

		// Ponowne otwarcie jest no-opem (idempotencja).
		const again = new AgentDockDb(legacyPath);
		expect(again.userVersion()).toBe(SCHEMA_VERSION);
		again.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
});

describe("Faza 1 i 2 na wspólnym warsztacie", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await makeHarness("ouroboros");
	}, 120_000);

	afterAll(() => h?.close());

	// ---------------------------------------------------------------- sejf
	test("DPAPI jest dostępne (Windows)", () => {
		if (process.platform !== "win32") return;
		expect(dpapiAvailable()).toBe(true);
	});

	test("sejf: zapis, brak wycieku sekretu, odszyfrowanie, znacznik użycia", () => {
		const key = h.vault.create({
			label: "anthropic-test",
			provider: "anthropic",
			envVar: "ANTHROPIC_API_KEY",
			secret: "sk-ant-test-1234567890",
		});
		expect(key.hint).toBe("7890");
		expect(key.protection).toBe("dpapi");
		expect(key.envVar).toBe("ANTHROPIC_API_KEY");

		// Sekret nie może pojawić się w tym, co widzi API/UI…
		expect(JSON.stringify(h.vault.list())).not.toContain("sk-ant-test-1234567890");
		// …ani w samym szyfrogramie w bazie.
		const row = h.vault.get(key.id);
		expect(row?.cipher).not.toContain("sk-ant-test");
		expect(row?.cipher.startsWith("plain:")).toBe(false);

		expect(h.vault.useSecret(key.id)).toBe("sk-ant-test-1234567890");
		expect(h.vault.list().find((k) => k.id === key.id)?.lastUsedAt).not.toBeNull();
	});

	test("sejf: rotacja, wyłączenie, odmowa przy złej nazwie zmiennej", () => {
		const key = h.vault.create({
			label: "rotacja",
			provider: "openai",
			envVar: "OPENAI_API_KEY",
			secret: "sk-old-1111",
		});
		const rotated = h.vault.update(key.id, { secret: "sk-new-2222" });
		expect(rotated.hint).toBe("2222");
		expect(h.vault.useSecret(key.id)).toBe("sk-new-2222");

		h.vault.update(key.id, { disabled: true });
		expect(h.vault.useSecret(key.id)).toBeNull();
		expect(h.vault.list().find((k) => k.id === key.id)?.disabled).toBe(true);

		expect(() =>
			h.vault.create({ label: "zła", provider: "other", envVar: "ZŁA NAZWA", secret: "x" }),
		).toThrow(/nie jest poprawną nazwą zmiennej/);
	});

	test("sejf: usunięcie klucza odwiązuje go od ról", () => {
		const key = h.vault.create({
			label: "do-usuniecia",
			provider: "other",
			envVar: "SOME_TOOL_TOKEN",
			secret: "abc",
		});
		h.agents.create({ name: "tmp-agent", command: "{self}", args: ["--demo-agent"] });
		h.agents.setKeys("tmp-agent", [key.id]);
		expect(h.agents.get("tmp-agent")?.keys.length).toBe(1);

		h.vault.remove(key.id);
		expect(h.agents.get("tmp-agent")?.keys.length).toBe(0);
		h.agents.remove("tmp-agent");
	});

	// ------------------------------------------------------------- role
	test("rejestr ról: zasiew z presetów, ochrona agenta wbudowanego", () => {
		const names = h.agents.list().map((a) => a.name);
		expect(names).toContain("demo");
		expect(names).toContain("claude");
		expect(h.agents.get("demo")?.builtin).toBe(true);
		expect(() => h.agents.remove("demo")).toThrow(/wbudowany/);
	});

	test("rejestr ról: CRUD działa, a rola jest wykonywalna natychmiast (bez restartu)", async () => {
		const created = h.agents.create({
			name: "researcher",
			description: "zbiera notatki",
			command: "{self}",
			args: ["--demo-agent"],
			stdinPrompt: true,
		});
		expect(created.name).toBe("researcher");
		expect(created.builtin).toBe(false);

		// „Hot reload”: dispatch zaraz po utworzeniu roli — bez restartu procesu.
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "researcher",
				prompt: "Notatka badawcza [commit]",
			}).id,
		);
		expect(run.state).toBe("succeeded");

		const updated = h.agents.update("researcher", { description: "zmieniony opis", stdinPrompt: false });
		expect(updated.description).toBe("zmieniony opis");
		expect(updated.stdinPrompt).toBe(false);

		h.agents.remove("researcher");
		expect(h.agents.get("researcher")).toBeNull();
	});

	test("rejestr ról: sekretopodobna nazwa w `env` jest odrzucana", () => {
		expect(() =>
			h.agents.create({ name: "zly", command: "x", args: [], env: ["ANTHROPIC_API_KEY"] }),
		).toThrow(/wygląda na sekret/);
		expect(() => h.agents.create({ name: "zly2", command: "", args: [] })).toThrow(/niepuste `command`/);
		expect(() => h.agents.create({ name: "-zla nazwa", command: "x", args: [] })).toThrow(/niepoprawna/);
	});

	// --------------------------------------------------- izolacja sekretów
	test("sejf wstrzykuje sekret, a nieprzypisana zmienna hosta nie przecieka", async () => {
		const key = h.vault.create({
			label: "vault-inject",
			provider: "other",
			envVar: "OUROBOROS_TEST_SECRET",
			secret: SECRET,
		});
		h.agents.create({
			name: "envcheck",
			description: "sprawdza obecność zmiennych",
			command: "{self}",
			args: ["--demo-agent"],
			stdinPrompt: true,
		});
		h.agents.setKeys("envcheck", [key.id]);
		process.env.OUROBOROS_HOST_LEAK = "host-secret-value";
		try {
			const run = await h.waitTerminal(
				h.runner().dispatch({
					projectId: h.projectId,
					agent: "envcheck",
					prompt: "[printenv OUROBOROS_TEST_SECRET] [printenv OUROBOROS_HOST_LEAK]",
					push: false,
				}).id,
			);
			const text = eventsText(h, run.id);

			expect(text).toContain(`OUROBOROS_TEST_SECRET=obecna (długość ${SECRET.length})`);
			expect(text).toContain("OUROBOROS_HOST_LEAK=BRAK");
			expect(text).toContain("klucze z sejfu: vault-inject");
			expect(run.keys_used).toBe(JSON.stringify(["vault-inject"]));

			// Nigdzie w zdarzeniach nie ma wartości sekretu ani wartości hosta.
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain("host-secret-value");
		} finally {
			delete process.env.OUROBOROS_HOST_LEAK;
		}
	});

	// ------------------------------------------------------------- dostawa
	test("push=false: stan dostawy jawny, gałąź zostaje lokalnie", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "demo",
				prompt: "Notatka bez pusha [commit]",
				push: false,
			}).id,
		);
		expect(run.state).toBe("succeeded");
		expect(run.pushed).toBe(0);
		expect(run.delivery_state).toBe("skipped_disabled");
		expect(run.commits_ahead).toBeGreaterThanOrEqual(1);

		const originBranches = await g.git(["-C", h.origin, "branch", "--format=%(refname:short)"]);
		expect(originBranches.stdout.split(/\r?\n/)).not.toContain(run.branch as string);
		const localBranches = await g.git(["-C", h.repo, "branch", "--format=%(refname:short)"]);
		expect(localBranches.stdout).toContain(run.branch as string);
	});

	test("push włączony: `delivery_state = pushed`", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "demo",
				prompt: "Notatka z pushem [commit]",
			}).id,
		);
		expect(run.delivery_state).toBe("pushed");
		expect(run.pushed).toBe(1);
	});
});
