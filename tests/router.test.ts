/**
 * Testy Smart Routera (Faza 3):
 *   - heurystyka złożoności (deterministyczna, z jawnymi sygnałami),
 *   - decyzje: auto / wymuszenia (operator, rola, tryb, wrażliwy projekt),
 *   - uczciwość wobec niedostępnego modelu lokalnego (fallback vs blokada),
 *   - integracja z runnerem: zamiana roli, placeholdery `{model}`, env, zapis decyzji.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEFAULT_ROUTING, type RoutingConfig } from "../src/config.ts";
import { decideRoute, scorePrompt, type OllamaStatus, type RouteInput } from "../src/router.ts";
import { eventsText, makeHarness, type Harness } from "./helpers.ts";

const OLLAMA_UP: OllamaStatus = {
	available: true,
	baseUrl: "http://127.0.0.1:11434",
	models: ["qwen2.5-coder:7b"],
	error: null,
};

const OLLAMA_DOWN: OllamaStatus = {
	available: false,
	baseUrl: "http://127.0.0.1:11434",
	models: [],
	error: "ECONNREFUSED",
};

function routeInput(patch: Partial<RouteInput> = {}): RouteInput {
	return {
		prompt: "Sformatuj README.",
		requestedAgent: "claude",
		agentTier: null,
		project: { name: "test", path: "C:\\repo", sensitive: false },
		routing: structuredClone(DEFAULT_ROUTING),
		tierOverride: "auto",
		ollama: OLLAMA_UP,
		fileCount: 20,
		classifierScore: null,
		...patch,
	};
}

describe("heurystyka złożoności", () => {
	test("krótkie zadanie proste wypada nisko i pokazuje sygnał", () => {
		const { score, signals } = scorePrompt("Sformatuj plik NOTATKA.md i dopisz komentarz.");
		expect(score).toBeLessThan(0.35);
		expect(signals.some((s) => s.name === "proste")).toBe(true);
	});

	test("zadanie architektoniczne wypada wysoko", () => {
		const { score, signals } = scorePrompt(
			"Przeprojektuj architekturę modułu autoryzacji w całym projekcie, dodaj migracje i zadbaj o bezpieczeństwo.",
		);
		expect(score).toBeGreaterThan(0.5);
		expect(signals.some((s) => s.name === "złożone")).toBe(true);
	});

	test("długie, wieloetapowe zadanie jest wyżej niż krótkie polecenie", () => {
		const short = scorePrompt("Podsumuj zmiany w README.").score;
		const long = scorePrompt(
			[
				"Zadanie:",
				"1. Przeanalizuj wszystkie pliki w module płatności.",
				"2. Następnie zaproponuj refaktor.",
				"3. Potem dodaj testy.",
				"4. Na koniec zaktualizuj dokumentację i opisz ryzyka.",
			].join("\n"),
		).score;
		expect(long).toBeGreaterThan(short);
	});

	test("wynik jest deterministyczny", () => {
		const prompt = "Dodaj walidację i napisz testy jednostkowe.";
		expect(scorePrompt(prompt).score).toBe(scorePrompt(prompt).score);
	});

	test("rozmiar projektu wpływa łagodnie (duże repo w górę, małe w dół)", () => {
		// Prompt celowo bez słów-kluczy: sprawdzamy sam sygnał rozmiaru,
		// a nie to, że „proste” zadanie dobija do zera.
		const prompt = "Popraw implementację funkcji parse.";
		const small = scorePrompt(prompt, { fileCount: 10 }).score;
		const big = scorePrompt(prompt, { fileCount: 1200 }).score;
		expect(big).toBeGreaterThan(small);
	});
});

describe("decyzje routera", () => {
	test("proste zadanie + dostępna Ollama ⇒ model lokalny z rolą lokalną", () => {
		const decision = decideRoute(routeInput());
		expect(decision.tier).toBe("local");
		expect(decision.tierForced).toBe(false);
		expect(decision.agent).toBe("ollama-local");
		expect(decision.model).toBe(DEFAULT_ROUTING.local.model);
		expect(decision.env.OLLAMA_HOST).toBe("127.0.0.1:11434");
		expect(decision.blocked).toBe(false);
	});

	test("złożone zadanie ⇒ chmura (bez zamiany roli)", () => {
		const decision = decideRoute(
			routeInput({
				prompt: "Przeprojektuj architekturę i zoptymalizuj wydajność całego modułu, dodaj migracje.",
			}),
		);
		expect(decision.tier).toBe("cloud");
		expect(decision.agent).toBeNull();
		expect(decision.reason).toContain("próg");
	});

	test("brak modelu lokalnego ⇒ fallback do chmury z ostrzeżeniem", () => {
		const decision = decideRoute(routeInput({ ollama: OLLAMA_DOWN }));
		expect(decision.tier).toBe("cloud");
		expect(decision.blocked).toBe(false);
		expect(decision.warnings.join(" ")).toContain("model lokalny niedostępny");
	});

	test("wrażliwy projekt wymusza model lokalny, a bez niego BLOKUJE run", () => {
		const decision = decideRoute(
			routeInput({
				project: { name: "tajne", path: "C:\\tajne", sensitive: true },
				ollama: OLLAMA_DOWN,
			}),
		);
		expect(decision.tier).toBe("local");
		expect(decision.tierForced).toBe(true);
		expect(decision.forcedBy).toBe("wrażliwy projekt");
		expect(decision.blocked).toBe(true);
		expect(decision.warnings.join(" ")).toContain("niedostępny");
	});

	test("operator może wymusić chmurę w wrażliwym projekcie — ale dostaje ostrzeżenie", () => {
		const decision = decideRoute(
			routeInput({
				project: { name: "tajne", path: "C:\\tajne", sensitive: true },
				tierOverride: "cloud",
			}),
		);
		expect(decision.tier).toBe("cloud");
		expect(decision.forcedBy).toBe("operator");
		expect(decision.warnings.join(" ")).toContain("wrażliwy");
	});

	test("preferencja roli działa i jest opisana jako wymuszenie", () => {
		const decision = decideRoute(routeInput({ agentTier: "cloud", prompt: "Sformatuj README." }));
		expect(decision.tier).toBe("cloud");
		expect(decision.tierForced).toBe(true);
		expect(decision.forcedBy).toContain("rola");
	});

	test("tryb local-only wymusza model lokalny", () => {
		const routing: RoutingConfig = { ...structuredClone(DEFAULT_ROUTING), mode: "local-only" };
		const decision = decideRoute(routeInput({ routing, prompt: "Przeprojektuj architekturę systemu." }));
		expect(decision.tier).toBe("local");
		expect(decision.forcedBy).toBe("tryb local-only");
	});

	test("klasyfikator modelowy może przebić heurystykę (z ostrzeżeniem o rozbieżności)", () => {
		const decision = decideRoute(routeInput({ prompt: "Sformatuj README.", classifierScore: 0.95 }));
		expect(decision.tier).toBe("cloud");
		expect(decision.score).toBeCloseTo(0.95, 2);
		expect(decision.warnings.join(" ")).toContain("klasyfikator");
	});

	test("serwer Ollamy odpowiada, ale model nie jest pobrany ⇒ poziom lokalny nieosiągalny", () => {
		const decision = decideRoute(
			routeInput({
				ollama: {
					available: true,
					baseUrl: "http://127.0.0.1:11434",
					models: ["qwen3:30b-a3b"],
					error: null,
				},
			}),
		);
		expect(decision.tier).toBe("cloud");
		expect(decision.warnings.join(" ")).toContain("nie jest pobrany");
	});

	test("brak roli lokalnej ⇒ poziom lokalny jest nieosiągalny (wymuszony = blokada)", () => {
		const routing = structuredClone(DEFAULT_ROUTING);
		routing.local.agent = null;
		const decision = decideRoute(routeInput({ routing, tierOverride: "local" }));
		expect(decision.blocked).toBe(true);
		expect(decision.warnings.join(" ")).toContain("nie skonfigurowano roli");
	});
});

describe("integracja routera z runnerem", () => {
	let h: Harness;

	beforeAll(async () => {
		// Sonda „model lokalny odpowiada” — w testach nie potrzebujemy prawdziwej Ollamy.
		h = await makeHarness("router", {
			probeOllama: async (baseUrl) => ({ ...OLLAMA_UP, baseUrl }),
		});
		// Poziom lokalny realizuje wbudowany agent demo (żadnego modelu nie woła),
		// dzięki czemu test sprawdza CAŁĄ ścieżkę: decyzję, zamianę roli, env i zapis.
		h.config.routing.enabled = true;
		// Poziom lokalny realizuje rola mówiąca do modelu lokalnego. W teście
		// jest to agent demo w trybie `--demo-agent` (żadnego modelu nie woła),
		// dzięki czemu sprawdzamy CAŁĄ ścieżkę: decyzję, zamianę roli, placeholder
		// `{model}` i env poziomu — bez potrzeby prawdziwej Ollamy.
		h.config.routing.local.agent = "localmodel";
		h.config.routing.local.env = { OLLAMA_HOST: "127.0.0.1:11434" };
		h.config.routing.local.model = "qwen2.5-coder:7b";
		h.agents.create({
			name: "localmodel",
			command: "{self}",
			args: ["--demo-agent", "--model={model}"],
			stdinPrompt: true,
			tier: "local",
		});
		// Rola „auto” — router może ją zamienić na lokalną przy prostym zadaniu.
		h.agents.create({ name: "autocoder", command: "{self}", args: ["--demo-agent"], stdinPrompt: true });
		// Rola z preferencją chmury — router musi ją zostawić w chmurze.
		h.agents.create({
			name: "cloudcoder",
			command: "{self}",
			args: ["--demo-agent", "--model={model}"],
			stdinPrompt: true,
			tier: "cloud",
		});
	}, 120_000);

	afterAll(() => h?.close());

	test("proste zadanie idzie lokalnie: rola zamieniona, model w argv, env z sejfu poziomu", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "autocoder",
				prompt: "Sformatuj plik i sprawdź [printenv OLLAMA_HOST].",
			}).id,
		);
		const text = eventsText(h, run.id);
		expect(run.state).toBe("succeeded");
		expect(run.route_tier).toBe("local");
		expect(run.route_model).toBe("qwen2.5-coder:7b");
		expect(text).toContain("router:");
		expect(text).toContain("OLLAMA_HOST=obecna");
		// Rola zamieniona na lokalną, a placeholder `{model}` rozwiązany.
		expect(text).toContain("zamieniam rolę autocoder → localmodel");
		expect(text).toContain("--model=qwen2.5-coder:7b");
		expect(run.route_json).toContain("\"tier\":\"local\"");
	});

	test("rola z preferencją chmury zostaje przy chmurze mimo prostego zadania", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "cloudcoder",
				prompt: "Dopisz komentarz w README.",
			}).id,
		);
		expect(run.route_tier).toBe("cloud");
		expect(run.route_json).toContain("rola");
		// Mimo zadania „prostego” rola chmurowa nie została zamieniona na lokalną.
		expect(run.agent).toBe("cloudcoder");
		expect(eventsText(h, run.id)).not.toContain("zamieniam rolę");
	});

	test("zadanie złożone u roli auto ⇒ chmura, bez zamiany roli", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "autocoder",
				prompt:
					"Przeprojektuj architekturę modułu płatności, zoptymalizuj wydajność i dodaj migracje w całym projekcie.",
			}).id,
		);
		expect(run.route_tier).toBe("cloud");
		expect(eventsText(h, run.id)).toContain("→ chmura");
	});

	test("rola wbudowana (demo) nie jest podmieniana przez router", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "demo",
				prompt: "Sformatuj plik i dopisz komentarz.",
			}).id,
		);
		// Router świadomie pomija role wbudowane: żadnej decyzji, żadnej zamiany.
		expect(run.route_tier).toBeNull();
		expect(run.agent).toBe("demo");
		const text = eventsText(h, run.id);
		expect(text).toContain("pomijam rolę wbudowaną");
		expect(text).not.toContain("zamieniam rolę");
	});

	test("wymuszenie --tier local jest respektowane i zapisane w runie", async () => {
		const run = await h.waitTerminal(
			h.runner().dispatch({
				projectId: h.projectId,
				agent: "cloudcoder",
				prompt: "Cokolwiek, byle sprawdzić wymuszenie.",
				tier: "local",
			}).id,
		);
		expect(run.route_tier).toBe("local");
		expect(run.route_request).toBe("local");
		// Operator > rola: nawet rola chmurowa została zamieniona na lokalną.
		expect(eventsText(h, run.id)).toContain("zamieniam rolę cloudcoder → localmodel");
	});

	test("wrażliwy projekt bez modelu lokalnego: run zablokowany, bez worktree", async () => {
		const blocked = await makeHarness("router-blocked", {
			probeOllama: async (baseUrl) => ({ ...OLLAMA_DOWN, baseUrl }),
		});
		try {
			blocked.db.setProjectSensitive(blocked.projectId, true);
			blocked.config.routing.enabled = true;
			blocked.config.routing.local.agent = "localworker";
			blocked.agents.create({
				name: "localworker",
				command: "{self}",
				args: ["--demo-agent"],
				stdinPrompt: true,
			});
			blocked.agents.create({ name: "worker", command: "{self}", args: ["--demo-agent"], stdinPrompt: true });
			const run = await blocked.waitTerminal(
				blocked.runner().dispatch({
					projectId: blocked.projectId,
					agent: "worker",
					prompt: "Dodaj notatkę do repozytorium.",
				}).id,
			);
			expect(run.state).toBe("failed");
			expect(run.failure_reason ?? "").toContain("router zablokował");
			expect(run.route_tier).toBe("local");
			// Zablokowany run nie zostawia po sobie katalogu ani worktree.
			expect(existsSync(`${blocked.paths.worktrees}\\${run.id}`)).toBe(false);
			expect(existsSync(`${blocked.paths.runs}\\${run.id}`)).toBe(false);
			void eventsText(blocked, run.id);
		} finally {
			blocked.close();
		}
	}, 120_000);
});
