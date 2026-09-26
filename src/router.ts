/**
 * Smart Router (Faza 3 Ouroborosa) — bramka decyzyjna „model lokalny czy chmura”.
 *
 * Dlaczego: proste zadania (sformatuj plik, dopisz notatkę, podsumuj diff) nie
 * potrzebują drogiego modelu. Router szacuje złożoność **przed** uruchomieniem
 * agenta, wybiera poziom (`local` / `cloud`) i przekazuje rolę, model oraz
 * zmienne środowiskowe dla tego poziomu.
 *
 * Zasady, które czynią to uczciwym:
 *
 *  1. **Router niczego nie udaje.** Jeśli wybrany jest model lokalny, a Ollama
 *     nie odpowiada, decyzja mówi o tym wprost — przy decyzji wymuszonej run
 *     jest blokowany, przy automatycznej schodzimy do chmury z ostrzeżeniem.
 *  2. **Decyzja jest zapisywana** (`route_json` w wierszu runu + zdarzenie
 *     `lifecycle`), więc zawsze da się odpowiedzieć na pytanie „dlaczego ten
 *     run poszedł tam, gdzie poszedł”.
 *  3. **Klasyfikator domyślny jest deterministyczny** (heurystyka sygnałów),
 *     a modelowy to opcja (`classifier: "ollama"`) z twardym fallbackiem —
 *     brak odpowiedzi modelu nigdy nie wywraca dispatchu.
 *  4. **Wrażliwy projekt nie idzie do chmury.** Projekt oznaczony jako
 *     `sensitive` wymusza poziom lokalny; jeśli model lokalny jest niedostępny,
 *     run kończy się jawnym błędem, a nie cichym wysłaniem kodu na zewnątrz.
 */
import { spawnSync } from "node:child_process";
import type { RoutingConfig, TierConfig } from "./config.ts";

export type Tier = "local" | "cloud";
export type TierPreference = Tier | "auto";

export interface RouteSignal {
	readonly name: string;
	readonly delta: number;
	readonly detail: string;
}

export interface ComplexityScore {
	readonly score: number;
	readonly signals: RouteSignal[];
}

export interface OllamaStatus {
	readonly available: boolean;
	readonly baseUrl: string;
	readonly models: string[];
	readonly error: string | null;
}

export interface RouteInput {
	readonly prompt: string;
	readonly requestedAgent: string;
	/** Preferencja modelu z definicji roli (`agents.tier`). */
	readonly agentTier: Tier | null;
	readonly project: { readonly name: string; readonly path: string; readonly sensitive: boolean };
	readonly routing: RoutingConfig;
	/** Nadpisanie z dispatchu (CLI/API/UI): `auto` = decyzja routera. */
	readonly tierOverride: TierPreference;
	readonly ollama: OllamaStatus;
	/** Liczba plików w repozytorium (opcjonalny sygnał „rozmiar projektu”). */
	readonly fileCount?: number | null;
	/**
	 * Czy dana rola jest realnie wykonywalna (binarka istnieje w PATH).
	 * Bez tego router uznawałby poziom lokalny za wykonalny, choć `aider`
	 * czy `ollama` mogą nie być zainstalowane. Domyślnie: zakładamy dostępność
	 * (wygodne w testach jednostkowych).
	 */
	readonly roleAvailable?: (name: string) => boolean;
	/** Wynik klasyfikatora modelowego (0..1) albo null, gdy niedostępny. */
	readonly classifierScore?: number | null;
}

export interface RouteDecision {
	readonly tier: Tier;
	readonly tierForced: boolean;
	readonly forcedBy: string | null;
	/** Rola efektywna (null = bez zamiany roli). */
	readonly agent: string | null;
	readonly model: string | null;
	readonly provider: string | null;
	readonly env: Record<string, string>;
	readonly score: number;
	readonly threshold: number;
	readonly classifier: "heuristic" | "ollama";
	readonly signals: RouteSignal[];
	readonly reason: string;
	readonly warnings: string[];
	/** Zamiar zadania (Faza 3.5): zmiana repozytorium czy tylko odpowiedź. */
	readonly intent: Intent;
	/** Rodzaj wybranej roli lokalnej: edytująca (`edit`), rozmawiająca (`chat`) albo brak. */
	readonly roleKind: "edit" | "chat" | null;
	/** true = run nie może wystartować (np. wrażliwy projekt bez modelu lokalnego). */
	readonly blocked: boolean;
}

// ---------------------------------------------------------------------------
// heurystyka złożoności
// ---------------------------------------------------------------------------

/** Zadania, które niemal zawsze wygrywa tani model (obniżają wynik). */
export const SIMPLE_KEYWORDS: readonly string[] = [
	"sformatuj",
	"formatuj",
	"prettier",
	"lint",
	"literówk",
	"komentarz",
	"komentarze",
	"podsumuj",
	"streszcz",
	"przetłumacz",
	"tłumacz",
	"notatka",
	"notatkę",
	"notatki",
	"readme",
	"changelog",
	"dopisz",
	"dodaj plik",
	"zmień nazwę",
	"rename",
	"wypisz",
	"lista plików",
	"format",
	"summarize",
	"translate",
	"typo",
];

/** Zadania, które wymagają mocnego modelu (podnoszą wynik). */
export const COMPLEX_KEYWORDS: readonly string[] = [
	"architektur",
	"refaktor",
	"refactor",
	"przeprojektuj",
	"redesign",
	"migracj",
	"migrate",
	"optymaliz",
	"optymalizuj",
	"wydajnoś",
	"performance",
	"bezpieczeństw",
	"security",
	"race condition",
	"współbieżn",
	"concurrency",
	"deadlock",
	"benchmark",
	"cał",
	"wszystkie pliki",
	"wielu plik",
	"integracj",
	"kontrakt",
	"protokół",
	"plan",
	"analiz",
	"audyt",
	"debug",
	"diagnoz",
	"napraw błąd",
	"popraw błąd",
];

const MULTI_STEP_MARKERS: readonly string[] = ["następnie", "potem", "krok ", "kroki", "etap"];

/**
 * Zamiar zadania: czy run ma ZMIENIĆ repozytorium, czy tylko coś opowiedzieć.
 *
 * To rozdzielenie kompetencji z Fazy 3.5: zadanie edytujące potrzebuje roli
 * z narzędziami plikowymi (Aider), a zadanie tylko czytające wystarczy
 * obsłużyć lżejszą rolą rozmawiającą (bez ryzyka ruchów w repo).
 */
export type Intent = "mutate" | "read" | "unknown";

/** Czasowniki/rzeczowniki oznaczające zmianę w repozytorium. */
export const MUTATE_KEYWORDS: readonly string[] = [
	"napisz",
	"dodaj",
	"dopisz",
	"zmień",
	"zmien",
	"popraw",
	"utwórz",
	"utworz",
	"stwórz",
	"stworz",
	"usuń",
	"usun",
	"zaimplementuj",
	"implementuj",
	"zrefaktoruj",
	"refaktoruj",
	"zaktualizuj",
	"update",
	"rename",
	"przenieś",
	"add",
	"create",
	"implement",
	"write",
	"edit",
	"remove",
	"delete",
	"fix",
	"migrate",
	"commituj",
];

/** Czasowniki oznaczające zadanie tylko czytające. */
export const READ_KEYWORDS: readonly string[] = [
	"podsumuj",
	"streszcz",
	"wyjaśnij",
	"wytłumacz",
	"wytlumacz",
	"opisz",
	"przeanalizuj",
	"sprawdź",
	"sprawdz",
	"wylistuj",
	"wypisz",
	"oceń",
	"ocec",
	"porównaj",
	"podaj",
	"odpowiedz",
	"summarize",
	"explain",
	"describe",
	"list",
	"review",
	"inspect",
	"analiza",
	"analizę",
];

/** Wykrywa zamiar zadania (edytujące / czytające / nieokreślone). */
export function detectIntent(prompt: string): Intent {
	const text = prompt.toLowerCase();
	const mutate = countMatches(text, MUTATE_KEYWORDS);
	const read = countMatches(text, READ_KEYWORDS);
	if (mutate.length === 0 && read.length === 0) return "unknown";
	// Przewaga czytających przy remisie: nie ruszamy repozytorium, gdy nie musimy.
	return mutate.length > read.length ? "mutate" : "read";
}

function clamp(value: number, min = 0, max = 1): number {
	return Math.min(max, Math.max(min, value));
}

function countMatches(haystack: string, needles: readonly string[]): string[] {
	const found: string[] = [];
	for (const needle of needles) {
		if (haystack.includes(needle)) found.push(needle);
	}
	return found;
}

/**
 * Deterministyczny szacunek złożoności zadania w skali 0..1.
 * Sygnały są zwracane razem z wynikiem — UI i zdarzenia runu pokazują, co
 * zadecydowało, więc decyzja nie jest „magią”.
 */
export function scorePrompt(prompt: string, facts: { fileCount?: number | null } = {}): ComplexityScore {
	const text = prompt.toLowerCase();
	const signals: RouteSignal[] = [];
	let score = 0;

	// 1. Długość zadania — krótkie polecenia są z reguły proste.
	const chars = prompt.length;
	if (chars <= 120) {
		score -= 0.1;
		signals.push({ name: "długość", delta: -0.1, detail: `${chars} znaków (krótkie polecenie)` });
	} else if (chars <= 600) {
		score += 0.05;
		signals.push({ name: "długość", delta: 0.05, detail: `${chars} znaków (średnie)` });
	} else {
		score += 0.25;
		signals.push({ name: "długość", delta: 0.25, detail: `${chars} znaków (obszerne zadanie)` });
	}

	// 2. Słowa-klucze proste.
	const simple = countMatches(text, SIMPLE_KEYWORDS);
	if (simple.length > 0) {
		const delta = clamp(-0.12 * simple.length, -0.35, 0);
		score += delta;
		signals.push({ name: "proste", delta, detail: `słowa-klucze: ${simple.slice(0, 4).join(", ")}` });
	}

	// 3. Słowa-klucze złożone — najmocniejszy sygnał: zadanie, które samo
	// nazywa architekturę/refaktor/bezpieczeństwo, prawie nigdy nie jest
	// zadaniem dla małego modelu lokalnego.
	const complex = countMatches(text, COMPLEX_KEYWORDS);
	if (complex.length > 0) {
		const delta = clamp(0.18 * complex.length, 0, 0.7);
		score += delta;
		signals.push({ name: "złożone", delta, detail: `słowa-klucze: ${complex.slice(0, 4).join(", ")}` });
	}

	// 4. Struktura wieloetapowa (listy, „następnie”, wiele akapitów).
	const steps = countMatches(text, MULTI_STEP_MARKERS);
	const numbered = (prompt.match(/^\s*\d+[.)]\s/gm) ?? []).length;
	const paragraphs = prompt.split(/\n\s*\n/).filter((p) => p.trim() !== "").length;
	if (steps.length > 0 || numbered >= 3 || paragraphs >= 3) {
		score += 0.15;
		signals.push({
			name: "wieloetapowe",
			delta: 0.15,
			detail: `${steps.length} znaczników kroków, ${numbered} punktów listy, ${paragraphs} akapitów`,
		});
	}

	// 5. Rozmiar projektu — duże repo = większe ryzyko, więc wyżej.
	if (typeof facts.fileCount === "number") {
		if (facts.fileCount >= 500) {
			score += 0.15;
			signals.push({ name: "rozmiar projektu", delta: 0.15, detail: `${facts.fileCount} plików w repo` });
		} else if (facts.fileCount <= 50) {
			score -= 0.1;
			signals.push({ name: "rozmiar projektu", delta: -0.1, detail: `${facts.fileCount} plików w repo (małe)` });
		}
	}

	return { score: clamp(score), signals };
}

// ---------------------------------------------------------------------------
// dostępność modelu lokalnego (Ollama)
// ---------------------------------------------------------------------------

const OLLAMA_CACHE_TTL_MS = 30_000;
const ollamaCache = new Map<string, { at: number; status: OllamaStatus }>();
const fileCountCache = new Map<string, { at: number; count: number | null }>();

/** Czyści cache (używane przez testy i przy ręcznym odświeżeniu w UI). */
export function resetRouterCaches(): void {
	ollamaCache.clear();
	fileCountCache.clear();
}

export async function probeOllama(baseUrl: string, timeoutMs = 900): Promise<OllamaStatus> {
	const cached = ollamaCache.get(baseUrl);
	if (cached !== undefined && Date.now() - cached.at < OLLAMA_CACHE_TTL_MS) return cached.status;

	let status: OllamaStatus;
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			status = { available: false, baseUrl, models: [], error: `HTTP ${res.status}` };
		} else {
			const body = (await res.json()) as { models?: Array<{ name?: string }> };
			const models = (body.models ?? [])
				.map((m) => m.name)
				.filter((name): name is string => typeof name === "string" && name !== "");
			status = { available: true, baseUrl, models, error: null };
		}
	} catch (err) {
		status = {
			available: false,
			baseUrl,
			models: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
	ollamaCache.set(baseUrl, { at: Date.now(), status });
	return status;
}

/** Liczba plików w repo (sygnał rozmiaru); `null`, gdy nie da się policzyć. */
export function countRepoFiles(repoPath: string): number | null {
	const cached = fileCountCache.get(repoPath);
	if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.count;
	let count: number | null = null;
	try {
		const res = spawnSync("git", ["-C", repoPath, "ls-files"], {
			encoding: "utf8",
			timeout: 5_000,
			windowsHide: true,
		});
		if (res.status === 0 && typeof res.stdout === "string") {
			count = res.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").length;
		}
	} catch {
		count = null;
	}
	fileCountCache.set(repoPath, { at: Date.now(), count });
	return count;
}

/**
 * Klasyfikator modelowy: pyta lokalny model o ocenę złożoności 0..100.
 * Zwraca `null` przy każdej niepewności (brak modelu, błąd, śmieci w odpowiedzi)
 * — wołający wtedy korzysta z heurystyki.
 */
export async function classifyWithOllama(
	prompt: string,
	routing: RoutingConfig,
	probe: (baseUrl: string) => Promise<OllamaStatus> = probeOllama,
): Promise<number | null> {
	const status = await probe(routing.local.baseUrl);
	if (!status.available) return null;
	const instruction = [
		"Oceń złożoność zadania programistycznego w skali 0-100.",
		"0 = trywialne (formatowanie, notatka, literówka),",
		"100 = wymaga architektury, refaktoru, analizy wielu plików.",
		"Odpowiedz WYŁĄCZNIE liczbą.",
		"",
		`Zadanie: ${prompt.slice(0, 4000)}`,
	].join("\n");
	try {
		const res = await fetch(`${routing.local.baseUrl.replace(/\/+$/, "")}/api/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: routing.classifyModel,
				prompt: instruction,
				stream: false,
				options: { temperature: 0 },
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { response?: string };
		const match = /-?\d+/.exec(body.response ?? "");
		if (match === null) return null;
		const value = Number.parseInt(match[0], 10);
		if (!Number.isFinite(value)) return null;
		return clamp(value / 100);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// decyzja
// ---------------------------------------------------------------------------

function tierEnv(tier: Tier, routing: RoutingConfig): Record<string, string> {
	return tier === "local" ? { ...routing.local.env } : { ...routing.cloud.env };
}

interface PickedLocalAgent {
	readonly role: string | null;
	readonly kind: "edit" | "chat" | null;
	readonly usable: boolean;
	readonly why: string;
}

/**
 * Wybiera rolę lokalną: łańcuch kandydatów do zadań edytujących, a dla zadań
 * tylko czytających — skonfigurowaną rolę rozmawiającą (`chatAgent`).
 *
 * Kolejność kandydatów ma znaczenie: pierwsza rola, której **binarka faktycznie
 * istnieje**, wygrywa. Dzięki temu instalacja bez Aidera nadal działa (choć bez
 * edycji plików), a komunikaty są konkretne.
 */
export function pickLocalAgent(
	input: RouteInput,
	intent: Intent,
): PickedLocalAgent {
	const { agents, chatAgent } = input.routing.local;
	const available = input.roleAvailable ?? (() => true);

	if (intent === "read" && chatAgent !== null && available(chatAgent)) {
		return { role: chatAgent, kind: "chat", usable: true, why: "" };
	}

	const tried: string[] = [];
	for (const candidate of agents) {
		if (!available(candidate)) {
			tried.push(candidate);
			continue;
		}
		return {
			role: candidate,
			kind: candidate === chatAgent ? "chat" : "edit",
			usable: true,
			why: "",
		};
	}

	if (agents.length === 0) {
		return {
			role: null,
			kind: null,
			usable: false,
			why: "nie skonfigurowano roli dla modelu lokalnego (routing.local.agents)",
		};
	}
	return {
		role: null,
		kind: null,
		usable: false,
		why: `żadna rola lokalna nie jest dostępna (sprawdzone: ${tried.join(", ")}) — doinstaluj narzędzie (np. \`aider\`)`,
	};
}

function usableLocal(input: RouteInput, intent: Intent): PickedLocalAgent {
	const picked = pickLocalAgent(input, intent);
	if (!picked.usable) return picked;
	if (!input.ollama.available) {
		return {
			...picked,
			usable: false,
			why: `model lokalny nie odpowiada (${input.ollama.baseUrl}: ${input.ollama.error ?? "brak odpowiedzi"})`,
		};
	}
	// Serwer odpowiada, ale czy model jest faktycznie pobrany? Bez tej kontroli
	// `ollama run <brakujący model>` zaczyna ciche pobieranie (gigabajty) albo
	// kończy się błędem dopiero w połowie runu — złapane na maszynie, gdzie
	// Ollama działa, ale skonfigurowanego modelu nie było.
	const model = input.routing.local.model;
	if (model !== null && model !== "" && !hasModel(input.ollama.models, model)) {
		const available = input.ollama.models.slice(0, 3).join(", ") || "brak pobranych modeli";
		return {
			...picked,
			usable: false,
			why: `model \"${model}\" nie jest pobrany (dostępne: ${available}) — uruchom \`ollama pull ${model}\``,
		};
	}
	return picked;
}

/** Czy lista modeli Ollamy zawiera skonfigurowany model (z tolerancją tagu). */
export function hasModel(models: readonly string[], wanted: string): boolean {
	const base = wanted.split(":")[0]?.toLowerCase() ?? wanted.toLowerCase();
	const want = wanted.toLowerCase();
	return models.some((name) => {
		const lower = name.toLowerCase();
		return lower === want || lower.startsWith(`${want}:`) || lower.split(":")[0] === base;
	});
}

function describe(decision: {
	tier: Tier;
	score: number;
	threshold: number;
	forced: boolean;
	forcedBy: string | null;
	signals: RouteSignal[];
}): string {
	const top = decision.signals
		.filter((s) => s.delta !== 0)
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
		.slice(0, 2)
		.map((s) => `${s.name}: ${s.detail}`);
	const where = decision.tier === "local" ? "model lokalny" : "chmura";
	if (decision.forced) {
		return `wymuszone (${decision.forcedBy ?? "?"}) → ${where}`;
	}
	return `wynik złożoności ${decision.score.toFixed(2)} ${decision.tier === "local" ? "<" : ">="} próg ${decision.threshold.toFixed(2)} → ${where}${top.length > 0 ? ` [${top.join("; ")}]` : ""}`;
}

/**
 * Podejmuje decyzję o poziomie modelu. Kolejność wymuszeń:
 * operator (per-run) > wrażliwy projekt > preferencja roli > tryb globalny.
 * Konflikt „operator wymusza chmurę w wrażliwym projekcie” zostaje jako
 * ostrzeżenie (operator jest dorosły), ale nigdy nie zdarza się po cichu.
 */
export function decideRoute(input: RouteInput): RouteDecision {
	const routing = input.routing;
	const { score, signals } = scorePrompt(input.prompt, { fileCount: input.fileCount ?? null });
	const effectiveScore =
		typeof input.classifierScore === "number" && Number.isFinite(input.classifierScore)
			? clamp(input.classifierScore)
			: score;
	const warnings: string[] = [];

	let tier: Tier;
	let tierForced = false;
	let forcedBy: string | null = null;

	if (input.tierOverride !== "auto") {
		tier = input.tierOverride;
		tierForced = true;
		forcedBy = "operator";
		if (tier === "cloud" && input.project.sensitive) {
			warnings.push(
				`projekt "${input.project.name}" jest oznaczony jako wrażliwy, a operator wymusił chmurę — kod opuści tę maszynę`,
			);
		}
	} else if (input.project.sensitive) {
		tier = "local";
		tierForced = true;
		forcedBy = "wrażliwy projekt";
	} else if (input.agentTier !== null) {
		tier = input.agentTier;
		tierForced = true;
		forcedBy = `rola (${input.requestedAgent})`;
	} else if (routing.mode !== "auto") {
		tier = routing.mode === "local-only" ? "local" : "cloud";
		tierForced = true;
		forcedBy = `tryb ${routing.mode}`;
	} else {
		tier = effectiveScore >= routing.threshold ? "cloud" : "local";
	}

	// Zamiar zadania decyduje, KTÓRA rola lokalna jest właściwa (Faza 3.5):
	// edytująca (Aider) dla zmian w repo, rozmawiająca dla odpowiedzi tekstowej.
	const intent = detectIntent(input.prompt);
	let pickedRole: string | null = null;
	let roleKind: "edit" | "chat" | null = null;

	// Dostępność modelu lokalnego rozstrzyga, czy decyzja jest wykonalna.
	// Rolę wybieramy tutaj, bo tier może się jeszcze zmienić (fallback do chmury).
	let blocked = false;
	if (tier === "local") {
		const local = usableLocal(input, intent);
		pickedRole = local.role;
		roleKind = local.kind;
		if (!local.usable) {
			pickedRole = null;
			roleKind = null;
			if (tierForced) {
				blocked = true;
				warnings.push(
					`wymuszony model lokalny jest niedostępny: ${local.why} — run nie może wystartować bezpiecznie`,
				);
			} else {
				tier = "cloud";
				warnings.push(`model lokalny niedostępny (${local.why}) — schodzę do chmury`);
			}
		}
	}

	const chosenRole = tier === "local" ? pickedRole : routing.cloud.agent;
	const agent = chosenRole !== null && chosenRole !== input.requestedAgent ? chosenRole : null;
	const model = tier === "local" ? routing.local.model : routing.cloud.model;
	const provider = tier === "local" ? routing.local.provider : routing.cloud.provider;
	if (tier === "cloud") roleKind = null;

	const roleNote =
		pickedRole !== null && tier === "local"
			? ` · rola ${roleKind === "chat" ? "czytająca" : "edytująca"}: ${pickedRole}`
			: "";
	const reason = `${describe({ tier, score: effectiveScore, threshold: routing.threshold, forced: tierForced, forcedBy, signals })}${roleNote}`;
	if (input.classifierScore !== null && input.classifierScore !== undefined && input.classifierScore !== score) {
		warnings.push(
			`klasyfikator modelowy zwrócił ${input.classifierScore.toFixed(2)} (heurystyka: ${score.toFixed(2)})`,
		);
	}

	return {
		tier,
		tierForced,
		forcedBy,
		agent,
		model,
		provider,
		env: tierEnv(tier, routing),
		score: effectiveScore,
		threshold: routing.threshold,
		classifier: routing.classifier,
		signals,
		reason,
		warnings,
		intent,
		roleKind,
		blocked,
	};
}

/** Zapis decyzji do `route_json` (audyt) + skrót dla UI. */
export function routeToJson(decision: RouteDecision, extras: { effectiveAgent: string; localAgent: boolean }): string {
	return JSON.stringify({
		tier: decision.tier,
		forced: decision.tierForced,
		forcedBy: decision.forcedBy,
		requestedAgent: extras.effectiveAgent,
		agent: decision.agent,
		effectiveAgent: decision.agent ?? extras.effectiveAgent,
		model: decision.model,
		provider: decision.provider,
		score: Number(decision.score.toFixed(4)),
		threshold: decision.threshold,
		classifier: decision.classifier,
		intent: decision.intent,
		roleKind: decision.roleKind,
		signals: decision.signals,
		reason: decision.reason,
		warnings: decision.warnings,
		blocked: decision.blocked,
	});
}
