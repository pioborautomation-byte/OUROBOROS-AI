/**
 * Rejestracja projektu: lokalne repo (ścieżka) albo URL do sklonowania.
 *
 * Rejestrujemy wyłącznie repo git — bez tego nie ma czego izolować worktree'em.
 * URL-e klonujemy do `<dane>/repos/<nazwa>`, żeby projekty zdalne i lokalne
 * zachowywały się identycznie z punktu widzenia runu.
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import * as g from "./git.ts";
import type { AgentDockDb, ProjectRow } from "./db.ts";
import type { AppPaths } from "./paths.ts";

function newProjectId(): string {
	return `prj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function looksLikeUrl(target: string): boolean {
	return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(target);
}

function repoNameFromUrl(url: string): string {
	const cleaned = url.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
	const tail = cleaned.split(/[/:]/).filter((p) => p !== "").pop() ?? "repo";
	return tail.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export async function addProject(
	db: AgentDockDb,
	paths: AppPaths,
	target: string,
	nameOverride?: string,
): Promise<ProjectRow> {
	let repoPath: string;
	let url: string | null = null;

	if (looksLikeUrl(target)) {
		url = target;
		const name = nameOverride ?? repoNameFromUrl(target);
		repoPath = join(paths.repos, name);
		if (!existsSync(join(repoPath, ".git"))) {
			await g.clone(target, repoPath);
		}
	} else {
		repoPath = isAbsolute(target) ? target : resolve(target);
		if (!existsSync(repoPath)) throw new Error(`ścieżka nie istnieje: ${repoPath}`);
		if (!(await g.isGitRepo(repoPath))) {
			throw new Error(`to nie jest repozytorium git: ${repoPath}`);
		}
	}

	const existing = db.findProjectByPath(repoPath);
	if (existing !== null) return existing;

	const defaultBranch = await g.detectDefaultBranch(repoPath);
	const row: ProjectRow = {
		id: newProjectId(),
		name: nameOverride ?? basename(repoPath) ?? "project",
		path: repoPath,
		url,
		default_branch: defaultBranch,
		added_at: new Date().toISOString(),
		sensitive: 0,
	};
	db.insertProject(row);
	return row;
}
