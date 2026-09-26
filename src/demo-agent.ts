/**
 * Wbudowany agent demo — deterministyczny „agent kodujący” bez modelu.
 *
 * Istnieje po to, żeby dało się sprawdzić CAŁY cykl życia runu (workspace,
 * Job Object, strumień zdarzeń, commit, push, statystyki kosztu) bez żadnego
 * klucza API. Emituje linie w formacie claude-code `stream-json`, więc parser
 * usage/cost w runnerze jest testowany na realnym kształcie danych.
 *
 * Knobs w prompcie (wszystkie opcjonalne):
 *   [sleep_ms=N]     — praca w tle z heartbeatami (test cancel/timeout)
 *   [mem_mb=N]       — alokuje N MB i trzyma (test limitu pamięci z Job Object)
 *   [fail]           — kończy się kodem 1 (test ścieżki porażki)
 *   [commit]         — agent sam commituje swoją zmianę (test „agent commituje”)
 *   [silent]         — nie wypisuje nic (test runu bez wyjścia)
 *   [printenv NAME]  — raportuje OBECNOŚĆ zmiennej (bez wartości!) — dowód
 *                      wstrzyknięcia sekretu z sejfu i braku przecieków
 */
const KNOWN_MODEL_COST = 0.00042;

interface Knobs {
	sleepMs: number;
	memMb: number;
	fail: boolean;
	commit: boolean;
	silent: boolean;
	/** Nazwy zmiennych do zaraportowania (obecność + długość, nigdy wartość). */
	printEnv: string[];
}

function parseKnobs(prompt: string): Knobs {
	const num = (re: RegExp): number => {
		const m = re.exec(prompt);
		if (m === null) return 0;
		const n = Number.parseInt(m[1] as string, 10);
		return Number.isFinite(n) ? n : 0;
	};
	const printEnv: string[] = [];
	const printEnvPattern = /\[printenv\s+([A-Za-z_][A-Za-z0-9_]*)\]/g;
	for (;;) {
		const match = printEnvPattern.exec(prompt);
		if (match === null) break;
		printEnv.push(match[1] as string);
	}
	return {
		sleepMs: num(/\[sleep_ms=(\d+)\]/),
		memMb: num(/\[mem_mb=(\d+)\]/),
		fail: /\[fail\]/.test(prompt),
		commit: /\[commit\]/.test(prompt),
		silent: /\[silent\]/.test(prompt),
		printEnv,
	};
}

function emit(line: string, silent: boolean): void {
	if (silent) return;
	process.stdout.write(`${line}\n`);
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	try {
		return await new Response(process.stdin as unknown as ReadableStream<Uint8Array>).text();
	} catch {
		return "";
	}
}

async function runGit(args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		windowsHide: true,
	});
	await proc.exited;
}

export async function runDemoAgent(): Promise<number> {
	const prompt = (await readStdin()).trim();
	const knobs = parseKnobs(prompt);
	const runId = process.env.AGENTDOCK_RUN_ID ?? "local";
	const workspace = process.cwd();
	const started = Date.now();

	emit(
		JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: `demo-${runId}`,
			model: "agentdock-demo",
			cwd: workspace,
		}),
		knobs.silent,
	);
	emit(
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: `Czytam zadanie i planuję zmiany.\nZadanie: ${prompt.slice(0, 200) || "(puste)"}`,
					},
				],
			},
		}),
		knobs.silent,
	);

	// „Analiza”: kilka linii zwykłego tekstu na stderr (tak robi większość CLI).
	process.stderr.write("demo-agent: analizuję repozytorium\n");

	// Dowód wstrzyknięcia sekretów: raportujemy wyłącznie obecność i długość.
	for (const name of knobs.printEnv) {
		const value = process.env[name];
		process.stderr.write(
			`demo-agent: ${name}=${value === undefined ? "BRAK" : `obecna (długość ${value.length})`}\n`,
		);
	}

	if (knobs.memMb > 0) {
		const blocks: Uint8Array[] = [];
		for (let i = 0; i < knobs.memMb; i++) {
			blocks.push(new Uint8Array(1024 * 1024));
			process.stderr.write(`demo-agent: alokowane ${i + 1} MB\n`);
			await Bun.sleep(5);
		}
		// Trzymamy alokację do końca, żeby limit pamięci był mierzalny.
		emit(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `trzymam ${knobs.memMb} MB` }] } }), knobs.silent);
	}

	// Realna „praca”: plik w workspace, który finalizacja zacommituje.
	if (!knobs.silent) {
		await Bun.write(
			`${workspace}/agentdock-output/run-${runId}.md`,
			`# Raport agenta demo\n\nRun: ${runId}\nCzas: ${new Date().toISOString()}\n\n## Zadanie\n\n${prompt}\n`,
		);
		process.stderr.write("demo-agent: zapisano agentdock-output/raport\n");
	}

	if (knobs.commit) {
		await runGit(["add", "-A"]);
		await runGit([
			"-c",
			"user.name=AgentDock",
			"-c",
			"user.email=agentdock@localhost",
			"commit",
			"-m",
			`demo-agent: ${prompt.slice(0, 60) || "praca agenta"}`,
		]);
		process.stderr.write("demo-agent: commit wykonany przez agenta\n");
	}

	if (knobs.sleepMs > 0) {
		const seconds = Math.ceil(knobs.sleepMs / 1000);
		for (let i = 1; i <= seconds; i++) {
			await Bun.sleep(1000);
			emit(
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: `heartbeat ${i}/${seconds}` }] },
				}),
				knobs.silent,
			);
		}
	}

	const elapsed = (Date.now() - started) / 1000;
	emit(
		JSON.stringify({
			type: "result",
			subtype: knobs.fail ? "error" : "success",
			is_error: knobs.fail,
			duration_ms: Math.round(elapsed * 1000),
			total_cost_usd: KNOWN_MODEL_COST,
			usage: {
				input_tokens: 1200,
				output_tokens: 400,
				cache_read_input_tokens: 5000,
				cache_creation_input_tokens: 200,
			},
		}),
		knobs.silent,
	);

	return knobs.fail ? 1 : 0;
}
