/**
 * Ścieżki danych AgentDock. Wszystko trzymamy w jednym katalogu
 * (%USERPROFILE%\.agentdock albo AGENTDOCK_HOME), żeby „odinstalowanie”
 * sprowadzało się do usunięcia jednego folderu.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "AgentDock";
export const APP_VERSION = "0.1.0";

export interface AppPaths {
	readonly root: string;
	readonly db: string;
	readonly config: string;
	readonly worktrees: string;
	readonly repos: string;
	readonly runs: string;
}

export function resolveRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.AGENTDOCK_HOME?.trim();
	if (override !== undefined && override !== "") return override;
	return join(homedir(), ".agentdock");
}

export function appPaths(root: string): AppPaths {
	return {
		root,
		db: join(root, "agentdock.db"),
		config: join(root, "config.json"),
		worktrees: join(root, "worktrees"),
		repos: join(root, "repos"),
		runs: join(root, "runs"),
	};
}

export function ensureDirs(paths: AppPaths): void {
	for (const dir of [paths.root, paths.worktrees, paths.repos, paths.runs]) {
		mkdirSync(dir, { recursive: true });
	}
}
