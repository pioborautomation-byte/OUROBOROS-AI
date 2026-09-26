/**
 * Warstwa Git: klon/rejestracja projektu, worktree per run, commit, push.
 *
 * Run nigdy nie pracuje na Twoim checkoutcie — dostaje `git worktree` na
 * własnej gałęzi, więc równoległe runy nie walczą o pliki, a „coś poszło nie
 * tak” da się wyrzucić razem z worktree. Gałąź zostaje w repo (na wypadek
 * gdyby commit był wartościowy), nawet po sprzątnięciu katalogu.
 */
import { existsSync } from "node:fs";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

function gitBin(): string {
	return Bun.which("git") ?? "git";
}

export async function git(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
	const proc = Bun.spawn([gitBin(), ...args], {
		cwd: opts.cwd,
		env: opts.env !== undefined ? { ...process.env, ...opts.env } : (process.env as Record<string, string>),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function gitOrThrow(
	args: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
	const res = await git(args, opts);
	if (res.code !== 0) {
		throw new Error(`git ${args[0]} failed (${res.code}): ${res.stderr || res.stdout}`);
	}
	return res.stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
	if (!existsSync(dir)) return false;
	const res = await git(["-C", dir, "rev-parse", "--git-dir"]);
	return res.code === 0;
}

export async function currentBranch(dir: string): Promise<string> {
	return gitOrThrow(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Wykrywa gałąź domyślną: origin/HEAD, potem main/master, potem bieżąca. */
export async function detectDefaultBranch(dir: string): Promise<string> {
	const head = await git(["-C", dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head.code === 0 && head.stdout.includes("/")) return head.stdout.split("/").slice(1).join("/");
	for (const candidate of ["main", "master"]) {
		const res = await git(["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
		if (res.code === 0) return candidate;
	}
	const cur = await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
	return cur.code === 0 && cur.stdout !== "" ? cur.stdout : "main";
}

export async function revParse(dir: string, ref: string): Promise<string> {
	return gitOrThrow(["-C", dir, "rev-parse", ref]);
}

export async function hasRemote(dir: string, name = "origin"): Promise<boolean> {
	const res = await git(["-C", dir, "remote", "get-url", name]);
	return res.code === 0 && res.stdout !== "";
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
	const res = await git(["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	return res.code === 0;
}

/** Najświeższy stan bazy: fetch (best-effort) + rozwiązanie refa na SHA. */
export async function prepareBase(
	dir: string,
	baseBranch: string,
): Promise<{ ref: string; sha: string; fetched: boolean }> {
	let fetched = false;
	if (await hasRemote(dir)) {
		const res = await git(["-C", dir, "fetch", "--quiet", "origin", baseBranch]);
		fetched = res.code === 0;
		const remoteRef = `origin/${baseBranch}`;
		const ok = await git(["-C", dir, "rev-parse", "--verify", "--quiet", remoteRef]);
		if (ok.code === 0) {
			const sha = await revParse(dir, remoteRef);
			return { ref: remoteRef, sha, fetched };
		}
	}
	const sha = await revParse(dir, baseBranch);
	return { ref: baseBranch, sha, fetched };
}

export async function worktreeAdd(
	repo: string,
	worktree: string,
	branch: string,
	baseRef: string,
): Promise<void> {
	await gitOrThrow(["-C", repo, "worktree", "add", "-b", branch, worktree, baseRef]);
}

export async function worktreeRemove(repo: string, worktree: string): Promise<ExecResult> {
	return git(["-C", repo, "worktree", "remove", "--force", worktree]);
}

export async function pruneWorktrees(repo: string): Promise<void> {
	await git(["-C", repo, "worktree", "prune"]);
}

export async function statusPorcelain(
	worktree: string,
	opts: { excludesFile?: string } = {},
): Promise<string> {
	return gitOrThrow([
		...(opts.excludesFile !== undefined ? ["-c", `core.excludesFile=${opts.excludesFile}`] : []),
		"-C",
		worktree,
		"status",
		"--porcelain",
	]);
}

export interface CommitResult {
	committed: boolean;
	sha: string | null;
}

/**
 * Commituje wszystko, co zostało w worktree (salvage). No-op gdy czysto.
 *
 * `opts.excludesFile` pozwala wykluczyć pliki robocze narzędzi (np. `.aider*`)
 * również z NASZEGO commita — agent dostaje tę ścieżkę przez per-run
 * `GIT_CONFIG_GLOBAL`, ale salvage idzie osobnym procesem, więc trzeba ją
 * podać jawnie. Bez tego leftovers Aidera trafiłyby do gałęzi runu.
 */
export async function commitAll(
	worktree: string,
	message: string,
	identity: { name: string; email: string },
	opts: { excludesFile?: string } = {},
): Promise<CommitResult> {
	const dirty = await statusPorcelain(worktree, opts);
	if (dirty === "") return { committed: false, sha: null };
	await gitOrThrow([
		...(opts.excludesFile !== undefined ? ["-c", `core.excludesFile=${opts.excludesFile}`] : []),
		"-C",
		worktree,
		"add",
		"-A",
	]);
	const env = {
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
	};
	await gitOrThrow(["-C", worktree, "commit", "-m", message], { env });
	const sha = await revParse(worktree, "HEAD");
	return { committed: true, sha };
}

export async function commitsAhead(worktree: string, baseSha: string): Promise<number> {
	const out = await gitOrThrow(["-C", worktree, "rev-list", "--count", `${baseSha}..HEAD`]);
	const n = Number.parseInt(out, 10);
	return Number.isFinite(n) ? n : 0;
}

export interface DiffStat {
	filesChanged: number;
	insertions: number;
	deletions: number;
}

export async function diffStat(worktree: string, baseSha: string): Promise<DiffStat> {
	const out = await git(["-C", worktree, "diff", "--shortstat", `${baseSha}..HEAD`]);
	const text = out.stdout;
	const files = /(\d+) files? changed/.exec(text);
	const ins = /(\d+) insertions?/.exec(text);
	const del = /(\d+) deletions?/.exec(text);
	return {
		filesChanged: files ? Number.parseInt(files[1] as string, 10) : 0,
		insertions: ins ? Number.parseInt(ins[1] as string, 10) : 0,
		deletions: del ? Number.parseInt(del[1] as string, 10) : 0,
	};
}

export interface PushResult {
	pushed: boolean;
	message: string;
}

/** Push gałęzi runu na origin (jeśli istnieje). Nigdy nie rzuca. */
export async function pushBranch(worktree: string, branch: string): Promise<PushResult> {
	if (!(await hasRemote(worktree))) {
		return { pushed: false, message: "brak remote 'origin' — gałąź została tylko lokalnie" };
	}
	const res = await git(["-C", worktree, "push", "--quiet", "-u", "origin", branch], {
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
	if (res.code !== 0) {
		return { pushed: false, message: res.stderr || res.stdout || `git push exit ${res.code}` };
	}
	return { pushed: true, message: "wypchnięto na origin" };
}

export async function clone(url: string, dest: string): Promise<void> {
	await gitOrThrow(
		["clone", "--quiet", url, dest],
		{ env: { GIT_TERMINAL_PROMPT: "0" } },
	);
}
