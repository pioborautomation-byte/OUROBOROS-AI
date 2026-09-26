/**
 * HTTP API + UI. Jeden proces obsługuje wszystko: REST dla UI/CLI, SSE dla
 * strumienia zdarzeń i statyczną stronę (bez buildu — jeden plik HTML).
 *
 * Serwer słucha wyłącznie na 127.0.0.1 i wymaga tokenu operatora na /api/*,
 * żeby inna lokalna aplikacja nie mogła sterować runami.
 *
 * Powierzchnia API (stan po Fazie 1 i 2 Ouroborosa):
 *   /healthz, /                        — publiczne
 *   /api/state                         — projekty + agenci + klucze + runy + limity
 *   /api/projects [...]                — rejestr repozytoriów
 *   /api/runs [...]                    — dispatch, podgląd, zdarzenia (SSE), anulowanie
 *   /api/agents [...]                  — CRUD ról (bez restartu serwera)
 *   /api/keys [...]                    — sejf kluczy API (sekrety są tylko do zapisu)
 */
import { agentBinaryAvailable } from "./agents.ts";
import type { AgentDockConfig } from "./config.ts";
import { SCHEMA_VERSION, type AgentDockDb, type RunRow } from "./db.ts";
import { jobObjectsSupported } from "./job.ts";
import { APP_NAME, APP_VERSION, type AppPaths } from "./paths.ts";
import type { AgentRegistry, AgentInput } from "./registry.ts";
import type { Runner } from "./runner.ts";
import { UI_HTML } from "./ui.ts";
import { addProject } from "./projects.ts";
import { probeOllama, resetRouterCaches, type OllamaStatus } from "./router.ts";
import { vaultProtectionMode, type ApiVault } from "./vault.ts";

export interface ServerDeps {
	readonly db: AgentDockDb;
	readonly runner: Runner;
	readonly paths: AppPaths;
	readonly getConfig: () => AgentDockConfig;
	readonly vault: ApiVault;
	readonly agents: AgentRegistry;
	readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function error(message: string, status = 400): Response {
	return json({ error: message }, status);
}

function publicRun(run: RunRow): Record<string, unknown> {
	return {
		id: run.id,
		projectId: run.project_id,
		agent: run.agent,
		prompt: run.prompt,
		state: run.state,
		branch: run.branch,
		baseCommit: run.base_commit,
		createdAt: run.created_at,
		startedAt: run.started_at,
		endedAt: run.ended_at,
		exitCode: run.exit_code,
		failureReason: run.failure_reason,
		costUsd: run.cost_usd,
		tokensIn: run.tokens_in,
		tokensOut: run.tokens_out,
		commitsAhead: run.commits_ahead,
		filesChanged: run.files_changed,
		insertions: run.insertions,
		deletions: run.deletions,
		pushed: run.pushed === 1,
		pushEnabled: run.push_enabled !== 0,
		deliveryState: run.delivery_state,
		pushError: run.push_error,
		routeTier: run.route_tier,
		routeModel: run.route_model,
		routeRequest: run.route_request,
		route: parseRoute(run.route_json),
		keysUsed: run.keys_used === null ? [] : (JSON.parse(run.keys_used) as string[]),
		memoryLimitMb: run.memory_limit_mb,
		timeoutSec: run.timeout_sec,
		jobKind: run.job_kind,
		durationMs:
			run.started_at !== null && run.ended_at !== null
				? new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()
				: null,
	};
}

/** Skrót decyzji routera dla UI (bez pełnej listy sygnałów, żeby nie puchł stan). */
function parseRoute(json: string | null): Record<string, unknown> | null {
	if (json === null || json === "") return null;
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		return {
			tier: parsed.tier,
			forced: parsed.forced,
			forcedBy: parsed.forcedBy,
			effectiveAgent: parsed.effectiveAgent,
			model: parsed.model,
			score: parsed.score,
			threshold: parsed.threshold,
			reason: parsed.reason,
			warnings: parsed.warnings,
			signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 6) : [],
		};
	} catch {
		return null;
	}
}

function authorized(req: Request, url: URL, token: string): boolean {
	if (token === "") return true;
	const header = req.headers.get("authorization");
	if (header !== null && header === `Bearer ${token}`) return true;
	return url.searchParams.get("token") === token;
}

async function readJson<T>(req: Request): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return {} as T;
	}
}

export function startServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
	const { db, runner, paths, getConfig, vault, agents } = deps;
	const config = getConfig();

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: config.port,
		// SSE trzyma połączenie otwarte — podtrzymujemy je keepalive'em.
		idleTimeout: 120,
		async fetch(req, srv): Promise<Response> {
			const url = new URL(req.url);
			const path = url.pathname;

			// ---- powierzchnia publiczna ----
			if (path === "/healthz") {
				return json({
					ok: true,
					app: APP_NAME,
					version: APP_VERSION,
					active: runner.activeCount(),
					db: "sqlite",
					schemaVersion: SCHEMA_VERSION,
					jobObjects: jobObjectsSupported(),
					vault: vaultProtectionMode(),
					agents: agents.list().length,
				});
			}
			if (path === "/" || path === "/index.html" || path === "/setup") {
				return new Response(UI_HTML, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			// ---- API (token) ----
			if (path.startsWith("/api/")) {
				if (!authorized(req, url, config.token)) return error("brak lub zły token operatora", 401);
				void srv;

				if (path === "/api/state" && req.method === "GET") {
					const cfg = getConfig();
					const projects = db.listProjects().map((p) => ({
						id: p.id,
						name: p.name,
						path: p.path,
						url: p.url,
						defaultBranch: p.default_branch,
						addedAt: p.added_at,
						sensitive: p.sensitive === 1,
					}));
					const agentDefs = agents.list().map((spec) => ({
						name: spec.name,
						description: spec.description,
						command: spec.command,
						args: spec.args,
						stdinPrompt: spec.stdinPrompt,
						env: spec.env,
						builtin: spec.builtin,
						enabled: spec.enabled,
						keyIds: spec.keyIds,
						keyLabels: spec.keys.map((k) => k.label),
						available: agentBinaryAvailable(spec),
						tier: spec.tier,
					}));
					return json({
						projects,
						agents: agentDefs,
						keys: vault.list(),
						vault: { protection: vaultProtectionMode() },
						runs: db.listRuns(100).map(publicRun),
						stats: db.stats(),
						limits: {
							maxConcurrent: cfg.maxConcurrent,
							memoryLimitMb: cfg.memoryLimitMb,
							timeoutSec: cfg.timeoutSec,
							jobObjects: jobObjectsSupported(),
						},
						routing: {
							enabled: cfg.routing.enabled,
							mode: cfg.routing.mode,
							classifier: cfg.routing.classifier,
							threshold: cfg.routing.threshold,
							localAgent: cfg.routing.local.agent,
							localModel: cfg.routing.local.model,
							localBaseUrl: cfg.routing.local.baseUrl,
							stats: db.routingStats(),
						},
						paths: { root: paths.root, worktrees: paths.worktrees, runs: paths.runs },
						version: APP_VERSION,
						schemaVersion: SCHEMA_VERSION,
					});
				}

				// ---------- router (Faza 3) ----------
				if (path === "/api/routing" && req.method === "GET") {
					const cfg = getConfig();
					if (url.searchParams.get("fresh") === "1") resetRouterCaches();
					const ollama: OllamaStatus = await probeOllama(cfg.routing.local.baseUrl);
					return json({
						config: {
							enabled: cfg.routing.enabled,
							mode: cfg.routing.mode,
							classifier: cfg.routing.classifier,
							threshold: cfg.routing.threshold,
							local: cfg.routing.local,
							cloud: cfg.routing.cloud,
						},
						ollama,
						stats: db.routingStats(),
					});
				}

				// ---------- projekty ----------
				if (path === "/api/projects" && req.method === "POST") {
					const body = await readJson<{ path?: string; url?: string; name?: string }>(req);
					const target = (body.path ?? body.url ?? "").trim();
					if (target === "") return error("podaj `path` (lokalne repo) albo `url` (do sklonowania)");
					try {
						const project = await addProject(db, paths, target, body.name);
						return json({ project }, 201);
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err));
					}
				}

				const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
				if (projectMatch !== null && req.method === "DELETE") {
					db.deleteProject(decodeURIComponent(projectMatch[1] as string));
					return json({ ok: true });
				}
				if (projectMatch !== null && (req.method === "PUT" || req.method === "PATCH")) {
					const id = decodeURIComponent(projectMatch[1] as string);
					if (db.getProject(id) === null) return error("nie ma takiego projektu", 404);
					const body = await readJson<{ sensitive?: boolean }>(req);
					if (typeof body.sensitive === "boolean") db.setProjectSensitive(id, body.sensitive);
					return json({ ok: true, sensitive: db.getProject(id)?.sensitive === 1 });
				}

				// ---------- agenci (rejestr ról) ----------
				if (path === "/api/agents" && req.method === "GET") {
					return json({ agents: agents.list() });
				}
				if (path === "/api/agents" && req.method === "POST") {
					const body = await readJson<AgentInput>(req);
					try {
						return json({ agent: agents.create(body) }, 201);
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err));
					}
				}

				const agentKeysMatch = /^\/api\/agents\/([^/]+)\/keys$/.exec(path);
				if (agentKeysMatch !== null && req.method === "PUT") {
					const name = decodeURIComponent(agentKeysMatch[1] as string);
					const body = await readJson<{ keyIds?: string[] }>(req);
					try {
						return json({ agent: agents.setKeys(name, body.keyIds ?? []) });
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err));
					}
				}

				const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path);
				if (agentMatch !== null) {
					const name = decodeURIComponent(agentMatch[1] as string);
					if (req.method === "GET") {
						const agent = agents.get(name);
						return agent === null ? error("nie ma takiego agenta", 404) : json({ agent });
					}
					if (req.method === "PUT" || req.method === "PATCH") {
						const body = await readJson<Partial<AgentInput>>(req);
						try {
							return json({ agent: agents.update(name, body) });
						} catch (err) {
							return error(err instanceof Error ? err.message : String(err));
						}
					}
					if (req.method === "DELETE") {
						try {
							agents.remove(name);
							return json({ ok: true });
						} catch (err) {
							return error(err instanceof Error ? err.message : String(err));
						}
					}
				}

				// ---------- sejf kluczy API ----------
				if (path === "/api/keys" && req.method === "GET") {
					return json({ keys: vault.list(), protection: vaultProtectionMode() });
				}
				if (path === "/api/keys" && req.method === "POST") {
					const body = await readJson<{
						label?: string;
						provider?: string;
						envVar?: string;
						secret?: string;
					}>(req);
					try {
						return json(
							{
								key: vault.create({
									label: String(body.label ?? ""),
									provider: String(body.provider ?? "other"),
									envVar: String(body.envVar ?? ""),
									secret: String(body.secret ?? ""),
								}),
							},
							201,
						);
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err));
					}
				}

				const keyMatch = /^\/api\/keys\/([^/]+)$/.exec(path);
				if (keyMatch !== null) {
					const id = decodeURIComponent(keyMatch[1] as string);
					if (req.method === "PUT" || req.method === "PATCH") {
						const body = await readJson<{
							label?: string;
							provider?: string;
							envVar?: string;
							secret?: string;
							disabled?: boolean;
						}>(req);
						try {
							return json({ key: vault.update(id, body) });
						} catch (err) {
							return error(err instanceof Error ? err.message : String(err));
						}
					}
					if (req.method === "DELETE") {
						vault.remove(id);
						return json({ ok: true });
					}
				}

				// ---------- runy ----------
				if (path === "/api/runs" && req.method === "POST") {
					const body = await readJson<{
						projectId?: string;
						agent?: string;
						prompt?: string;
						memoryLimitMb?: number;
						timeoutSec?: number;
						push?: boolean;
						tier?: "local" | "cloud" | "auto";
					}>(req);
					try {
						const run = runner.dispatch({
							projectId: String(body.projectId ?? ""),
							agent: String(body.agent ?? ""),
							prompt: String(body.prompt ?? ""),
							...(typeof body.memoryLimitMb === "number" ? { memoryLimitMb: body.memoryLimitMb } : {}),
							...(typeof body.timeoutSec === "number" ? { timeoutSec: body.timeoutSec } : {}),
						...(typeof body.push === "boolean" ? { push: body.push } : {}),
						...(body.tier === "local" || body.tier === "cloud" || body.tier === "auto"
							? { tier: body.tier }
							: {}),
					});
						return json({ run: publicRun(run) }, 201);
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err));
					}
				}

				const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
				if (eventsMatch !== null && req.method === "GET") {
					const runId = decodeURIComponent(eventsMatch[1] as string);
					const from = Number.parseInt(url.searchParams.get("from") ?? "0", 10) || 0;
					return sseResponse(runner, db, runId, from, req.signal);
				}

				const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
				if (cancelMatch !== null && req.method === "POST") {
					const runId = decodeURIComponent(cancelMatch[1] as string);
					const ok = runner.cancel(runId);
					return ok ? json({ ok: true }) : error("run nie jest aktywny", 409);
				}

				const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
				if (runMatch !== null && req.method === "GET") {
					const runId = decodeURIComponent(runMatch[1] as string);
					const run = db.getRun(runId);
					if (run === null) return error("nie ma takiego runu", 404);
					return json({
						run: publicRun(run),
						events: db.listEvents(runId, 0).map((e) => ({
							seq: e.seq,
							ts: e.ts,
							kind: e.kind,
							stream: e.stream,
							text: e.text,
						})),
					});
				}
			}

			return error("nie ma takiej trasy", 404);
		},
	});

	return server;
}

/** Strumień zdarzeń jednego runu: najpierw zaległe, potem na żywo. */
function sseResponse(
	runner: Runner,
	db: AgentDockDb,
	runId: string,
	fromSeq: number,
	signal: AbortSignal,
): Response {
	const run = db.getRun(runId);
	if (run === null) return error("nie ma takiego runu", 404);

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (payload: string): void => {
				try {
					controller.enqueue(encoder.encode(payload));
				} catch {
					// klient odszedł — sprząta `cancel`
				}
			};
			send(`event: hello\ndata: ${JSON.stringify({ runId, from: fromSeq })}\n\n`);

			for (const e of db.listEvents(runId, fromSeq)) {
				send(
					`data: ${JSON.stringify({ seq: e.seq, ts: e.ts, kind: e.kind, stream: e.stream, text: e.text })}\n\n`,
				);
			}

			unsubscribe = runner.subscribe(runId, (event) => {
				send(`data: ${JSON.stringify(event)}\n\n`);
			});
			keepalive = setInterval(() => send(": keepalive\n\n"), 20_000);

			signal.addEventListener("abort", () => {
				unsubscribe?.();
				if (keepalive !== null) clearInterval(keepalive);
				try {
					controller.close();
				} catch {
					// już zamknięty
				}
			});
		},
		cancel() {
			unsubscribe?.();
			if (keepalive !== null) clearInterval(keepalive);
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		},
	});
}
