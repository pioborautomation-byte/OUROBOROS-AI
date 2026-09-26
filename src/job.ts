/**
 * Windows Job Object — natywny mechanizm, który daje runom realne granice:
 *
 *   - `JOB_OBJECT_LIMIT_PROCESS_MEMORY` — limit pamięci na proces (odpowiednik
 *     cgroup memory.max w warrenie): agresor OOM-uje własny run, nie maszynę,
 *   - `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` — maksymalna liczba procesów w jobie
 *     (obrona przed „agent odpalił 500 procesów”),
 *   - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — zamknięcie uchwytu ubija CAŁE
 *     drzewo procesów, więc po runie nie zostają sieroty.
 *
 * Wywołania WinAPI idą przez `bun:ffi` (kernel32.dll). Gdy FFI albo platforma
 * są niedostępne, obiekt degraduje się do no-opu: runy nadal działają, ale bez
 * limitów systemowych — aplikacja raportuje to w UI (`job_kind: "none"`).
 *
 * Znane ograniczenie: proces jest przypisywany do joba chwilę PO starcie
 * (Bun.spawn nie umie tworzyć procesu zawieszonego), więc teoretycznie może
 * zdążyć odpalić dziecko przed przypisaniem. W praktyce to milisekundy.
 */
import { dlopen } from "bun:ffi";

/** Typ zwracany przez `dlopen` (w tej wersji Bun nie eksportuje nazwy `Lib`). */
type LoadedLib = ReturnType<typeof dlopen>;

const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;

/** InfoClass: JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64: 144 bajty). */
const JobObjectExtendedLimitInformation = 9;
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_TERMINATE = 0x1;
const EXTENDED_LIMIT_INFO_SIZE = 144;

interface Kernel32 {
	symbols: {
		CreateJobObjectW: (attrs: null, name: null) => unknown;
		SetInformationJobObject: (job: unknown, cls: number, info: Uint8Array, len: number) => number;
		OpenProcess: (access: number, inherit: number, pid: number) => unknown;
		AssignProcessToJobObject: (job: unknown, proc: unknown) => number;
		TerminateJobObject: (job: unknown, code: number) => number;
		CloseHandle: (h: unknown) => number;
	};
}

let cached: LoadedLib | null | undefined;

function kernel32(): Kernel32 | null {
	if (cached !== undefined) return (cached as Kernel32 | null) ?? null;
	if (process.platform !== "win32") {
		cached = null;
		return null;
	}
	try {
		cached = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
			SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
			OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
			AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
			TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
			CloseHandle: { args: ["ptr"], returns: "i32" },
		}) as unknown as LoadedLib;
	} catch {
		cached = null;
	}
	return (cached as Kernel32 | null) ?? null;
}

/** Czy limity Job Object są dostępne w tym procesie/systemie. */
export function jobObjectsSupported(): boolean {
	return kernel32() !== null;
}

/** Buduje strukturę JOBOBJECT_EXTENDED_LIMIT_INFORMATION (layout x64). */
export function buildExtendedLimitInfo(opts: {
	activeProcessLimit?: number;
	processMemoryBytes?: number;
	killOnClose: boolean;
	dieOnUnhandledException?: boolean;
}): Uint8Array {
	const buf = new Uint8Array(EXTENDED_LIMIT_INFO_SIZE);
	const dv = new DataView(buf.buffer);
	let flags = 0;
	if (opts.activeProcessLimit !== undefined) {
		flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
		dv.setUint32(40, opts.activeProcessLimit, true);
	}
	if (opts.processMemoryBytes !== undefined) {
		flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
		dv.setBigUint64(112, BigInt(opts.processMemoryBytes), true);
	}
	if (opts.dieOnUnhandledException) flags |= JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
	if (opts.killOnClose) flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
	dv.setUint32(16, flags, true);
	return buf;
}

export interface RunJob {
	/** "win32-job" gdy limity działają, "none" gdy system ich nie wspiera. */
	readonly kind: "win32-job" | "none";
	/** Przypina proces (i tym samym jego przyszłe dzieci) do joba. */
	assign(pid: number): boolean;
	/** Ubija całe drzewo procesów w jobie. */
	terminate(exitCode?: number): void;
	/** Zwalnia uchwyt (kill-on-close dobija resztę). */
	close(): void;
}

export function createRunJob(opts: {
	memoryLimitBytes?: number;
	activeProcessLimit?: number;
}): RunJob {
	const k32 = kernel32();
	if (k32 === null) {
		return { kind: "none", assign: () => false, terminate: () => {}, close: () => {} };
	}

	const job = k32.symbols.CreateJobObjectW(null, null);
	if (!job) {
		return { kind: "none", assign: () => false, terminate: () => {}, close: () => {} };
	}

	const info = buildExtendedLimitInfo({
		...(opts.memoryLimitBytes !== undefined ? { processMemoryBytes: opts.memoryLimitBytes } : {}),
		...(opts.activeProcessLimit !== undefined ? { activeProcessLimit: opts.activeProcessLimit } : {}),
		killOnClose: true,
	});
	const configured =
		k32.symbols.SetInformationJobObject(
			job,
			JobObjectExtendedLimitInformation,
			info,
			info.byteLength,
		) !== 0;

	let closed = false;
	return {
		kind: configured ? "win32-job" : "none",
		assign(pid: number): boolean {
			if (closed) return false;
			const handle = k32.symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
			if (!handle) return false;
			const ok = k32.symbols.AssignProcessToJobObject(job, handle) !== 0;
			// Uchwyt procesu nie jest już potrzebny — job trzyma własną referencję.
			k32.symbols.CloseHandle(handle);
			return ok;
		},
		terminate(exitCode = 1): void {
			if (closed) return;
			k32.symbols.TerminateJobObject(job, exitCode);
		},
		close(): void {
			if (closed) return;
			closed = true;
			k32.symbols.CloseHandle(job);
		},
	};
}
