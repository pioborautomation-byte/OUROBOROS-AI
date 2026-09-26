/**
 * Sejf kluczy API (Faza 1 Ouroborosa).
 *
 * Dlaczego nie zmienne środowiskowe: sekret w środowisku procesu nadrzędnego
 * jest widoczny dla każdego uruchomionego procesu użytkownika i wycieka do
 * zrzutów/logów. Sejf oznacza, że sekret istnieje w postaci jawnej tylko
 * przelotnie — w pamięci procesu przed spawnem agenta.
 *
 * Szyfrowanie: **DPAPI** (`crypt32.dll`, `CryptProtectData`) — natywny Windows
 * mechanizm wiążący szyfrogram z kontem użytkownika. Bez tego samego konta i
 * maszyny odszyfrowanie się nie powiedzie, więc kopia pliku bazy nie wystarczy
 * do odczytu sekretów. Nie przechowujemy żadnego „klucza głównego” na dysku —
 * dokładnie dlatego DPAPI, a nie AES z kluczem obok danych.
 *
 * Gdy DPAPI jest niedostępne (brak Windows / błąd), zapis sekretu jest
 * **odrzucany**, chyba że operator jawnie włączy `AGENTDOCK_INSECURE_SECRETS=1`
 * (wtedy sekret leci jawnie z prefiksem `plain:` i jest widoczny w `doctor`).
 */
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import type { AgentDockDb } from "./db.ts";

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const DATA_BLOB_SIZE = 16;

export interface ApiKeyRow {
	id: string;
	label: string;
	provider: string;
	env_var: string;
	cipher: string;
	hint: string;
	created_at: string;
	last_used_at: string | null;
	disabled: number;
}

/** Klucz bez sekretu — to, co wolno pokazać w UI/API. */
export interface ApiKeyPublic {
	id: string;
	label: string;
	provider: string;
	envVar: string;
	hint: string;
	createdAt: string;
	lastUsedAt: string | null;
	disabled: boolean;
	/** `dpapi` | `plain` (tryb niezabezpieczony) */
	protection: "dpapi" | "plain";
}

interface CryptApi {
	readonly protect: (
		inBlob: unknown,
		desc: unknown,
		entropy: unknown,
		reserved: unknown,
		prompt: unknown,
		flags: number,
		outBlob: unknown,
	) => number;
	readonly unprotect: (
		inBlob: unknown,
		desc: unknown,
		entropy: unknown,
		reserved: unknown,
		prompt: unknown,
		flags: number,
		outBlob: unknown,
	) => number;
	readonly free: (mem: unknown) => unknown;
}

let cryptApi: CryptApi | null | undefined;

/**
 * `CryptProtectData`/`CryptUnprotectData` są w `crypt32.dll`, ale `LocalFree`
 * **nie** — jest w `kernel32.dll`. Próba załadowania wszystkich trzech z jednej
 * biblioteki kończy się `Symbol "LocalFree" not found in "crypt32.dll"`
 * (błąd złapany w testach sejfu).
 */
function loadCryptApi(): CryptApi | null {
	if (cryptApi !== undefined) return cryptApi;
	if (process.platform !== "win32") {
		cryptApi = null;
		return null;
	}
	try {
		const crypt32 = dlopen("crypt32.dll", {
			CryptProtectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
			CryptUnprotectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
		});
		const kernel32 = dlopen("kernel32.dll", {
			LocalFree: { args: ["ptr"], returns: "ptr" },
		});
		cryptApi = {
			protect: crypt32.symbols.CryptProtectData as CryptApi["protect"],
			unprotect: crypt32.symbols.CryptUnprotectData as CryptApi["unprotect"],
			free: kernel32.symbols.LocalFree as CryptApi["free"],
		};
	} catch {
		cryptApi = null;
	}
	return cryptApi;
}

/**
 * Wywołuje DPAPI i zwraca surowe bajty wyniku.
 *
 * Uwaga na czas życia: `input` (tablica JS) musi żyć do końca wywołania —
 * struktura DATA_BLOB trzyma tylko adres, więc gdyby GC zebrał bufor przed
 * powrotem z natywnej funkcji, odczytalibyśmy śmieci. Dlatego `input` jest
 * używany również PO wywołaniu (zerowanie).
 */
function dpapiCall(mode: "protect" | "unprotect", input: Uint8Array): Uint8Array | null {
	const lib = loadCryptApi();
	if (lib === null) return null;

	const inStruct = new Uint8Array(DATA_BLOB_SIZE);
	const dvIn = new DataView(inStruct.buffer);
	dvIn.setUint32(0, input.length, true);
	dvIn.setBigUint64(8, BigInt(ptr(input)), true);

	const outStruct = new Uint8Array(DATA_BLOB_SIZE);
	const ok =
		mode === "protect"
			? lib.protect(ptr(inStruct), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(outStruct))
			: lib.unprotect(ptr(inStruct), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(outStruct));

	// Zerujemy wejście niezależnie od wyniku (higiena pamięci + trzymanie bufora przy życiu).
	input.fill(0);

	if (ok === 0) return null;

	const dvOut = new DataView(outStruct.buffer);
	const length = dvOut.getUint32(0, true);
	const address = Number(dvOut.getBigUint64(8, true));
	if (address === 0 || length === 0) return null;

	// Kopia ZANIM zwolnimy pamięć native — `toArrayBuffer` daje widok, nie kopię.
	const result = new Uint8Array(toArrayBuffer(address, 0, length)).slice();
	lib.free(address);
	return result;
}

/** Czy DPAPI jest dostępne (wynik cache'owany po pierwszym teście). */
let available: boolean | undefined;
export function dpapiAvailable(): boolean {
	if (available !== undefined) return available;
	if (loadCryptApi() === null) {
		available = false;
		return available;
	}
	const roundTrip = dpapiCall("unprotect", dpapiCall("protect", new TextEncoder().encode("probe")) ?? new Uint8Array());
	available = roundTrip !== null;
	return available;
}

function insecureAllowed(): boolean {
	return process.env.AGENTDOCK_INSECURE_SECRETS === "1";
}

/** Tryb ochrony sekretów w tej instalacji — do raportowania w UI/`doctor`. */
export function vaultProtectionMode(): "dpapi" | "plain" | "unavailable" {
	if (dpapiAvailable()) return "dpapi";
	return insecureAllowed() ? "plain" : "unavailable";
}

export function protectSecret(secret: string): { cipher: string; protection: "dpapi" | "plain" } {
	const bytes = new TextEncoder().encode(secret);
	const encrypted = dpapiCall("protect", bytes);
	if (encrypted !== null) {
		return { cipher: Buffer.from(encrypted).toString("base64"), protection: "dpapi" };
	}
	if (!insecureAllowed()) {
		throw new Error(
			"nie mogę zaszyfrować sekretu (DPAPI niedostępne) — odmawiam zapisu jawnego. " +
				"Ustaw AGENTDOCK_INSECURE_SECRETS=1, jeśli świadomie akceptujesz zapis bez szyfrowania.",
		);
	}
	return { cipher: `plain:${Buffer.from(bytes).toString("base64")}`, protection: "plain" };
}

export function unprotectSecret(cipher: string): string | null {
	if (cipher.startsWith("plain:")) {
		return Buffer.from(cipher.slice("plain:".length), "base64").toString("utf8");
	}
	const decrypted = dpapiCall("unprotect", new Uint8Array(Buffer.from(cipher, "base64")));
	return decrypted === null ? null : new TextDecoder().decode(decrypted);
}

function newKeyId(): string {
	return `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function publicKey(row: ApiKeyRow): ApiKeyPublic {
	return {
		id: row.id,
		label: row.label,
		provider: row.provider,
		envVar: row.env_var,
		hint: row.hint,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		disabled: row.disabled === 1,
		protection: row.cipher.startsWith("plain:") ? "plain" : "dpapi",
	};
}

export interface CreateKeyInput {
	readonly label: string;
	readonly provider: string;
	readonly envVar: string;
	readonly secret: string;
}

const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ApiVault {
	constructor(private readonly db: AgentDockDb) {}

	list(): ApiKeyPublic[] {
		const rows = this.db.raw
			.query<ApiKeyRow, []>("select * from api_keys order by created_at asc")
			.all();
		return rows.map(publicKey);
	}

	get(id: string): ApiKeyRow | null {
		return this.db.raw.query<ApiKeyRow, [string]>("select * from api_keys where id = ?").get(id);
	}

	/** Klucze przypisane do agenta (bez sekretów). */
	keysForAgent(agentName: string): ApiKeyPublic[] {
		const rows = this.db.raw
			.query<ApiKeyRow, [string]>(
				`select k.* from api_keys k
				 join agent_keys ak on ak.key_id = k.id
				 where ak.agent_name = ? order by k.created_at asc`,
			)
			.all(agentName);
		return rows.map(publicKey);
	}

	create(input: CreateKeyInput): ApiKeyPublic {
		const label = input.label.trim();
		const envVar = input.envVar.trim().toUpperCase();
		const secret = input.secret.trim();
		if (label === "") throw new Error("etykieta klucza nie może być pusta");
		if (!ENV_VAR_PATTERN.test(envVar)) {
			throw new Error(`nazwa zmiennej "${input.envVar}" nie jest poprawną nazwą zmiennej środowiskowej`);
		}
		if (secret === "") throw new Error("sekret nie może być pusty");
		const { cipher } = protectSecret(secret);
		const row: ApiKeyRow = {
			id: newKeyId(),
			label,
			provider: input.provider.trim() === "" ? "other" : input.provider.trim(),
			env_var: envVar,
			cipher,
			hint: secret.slice(-4),
			created_at: new Date().toISOString(),
			last_used_at: null,
			disabled: 0,
		};
		this.db.raw
			.prepare(
				`insert into api_keys (id, label, provider, env_var, cipher, hint, created_at, last_used_at, disabled)
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(row.id, row.label, row.provider, row.env_var, row.cipher, row.hint, row.created_at, row.last_used_at, row.disabled);
		return publicKey(row);
	}

	/** Podmiana metadanych i/lub sekretu (rotacja). */
	update(
		id: string,
		patch: { label?: string; provider?: string; envVar?: string; secret?: string; disabled?: boolean },
	): ApiKeyPublic {
		const row = this.get(id);
		if (row === null) throw new Error(`nie ma klucza ${id}`);
		const next: ApiKeyRow = { ...row };

		if (patch.label !== undefined) {
			if (patch.label.trim() === "") throw new Error("etykieta klucza nie może być pusta");
			next.label = patch.label.trim();
		}
		if (patch.provider !== undefined) next.provider = patch.provider.trim() || "other";
		if (patch.envVar !== undefined) {
			const envVar = patch.envVar.trim().toUpperCase();
			if (!ENV_VAR_PATTERN.test(envVar)) throw new Error(`nazwa zmiennej "${patch.envVar}" jest niepoprawna`);
			next.env_var = envVar;
		}
		if (patch.secret !== undefined) {
			if (patch.secret.trim() === "") throw new Error("nowy sekret nie może być pusty");
			next.cipher = protectSecret(patch.secret.trim()).cipher;
			next.hint = patch.secret.trim().slice(-4);
		}
		if (patch.disabled !== undefined) next.disabled = patch.disabled ? 1 : 0;

		this.db.raw
			.prepare(
				"update api_keys set label = ?, provider = ?, env_var = ?, cipher = ?, hint = ?, disabled = ? where id = ?",
			)
			.run(next.label, next.provider, next.env_var, next.cipher, next.hint, next.disabled, id);
		return publicKey(next);
	}

	remove(id: string): void {
		this.db.raw.prepare("delete from agent_keys where key_id = ?").run(id);
		this.db.raw.prepare("delete from api_keys where id = ?").run(id);
	}

	assign(agentName: string, keyId: string): void {
		if (this.get(keyId) === null) throw new Error(`nie ma klucza ${keyId}`);
		this.db.raw
			.prepare("insert or ignore into agent_keys (agent_name, key_id) values (?, ?)")
			.run(agentName, keyId);
	}

	unassign(agentName: string, keyId: string): void {
		this.db.raw
			.prepare("delete from agent_keys where agent_name = ? and key_id = ?")
			.run(agentName, keyId);
	}

	/**
	 * Odszyfrowuje sekret klucza i odnotowuje użycie.
	 * Zwraca `null`, gdy klucz jest wyłączony albo nie da się go odszyfrować
	 * (np. baza skopiowana z innej maszyny/konta) — wołający decyduje, co z tym zrobić.
	 */
	useSecret(id: string): string | null {
		const row = this.get(id);
		if (row === null || row.disabled === 1) return null;
		const secret = unprotectSecret(row.cipher);
		if (secret === null) return null;
		this.db.raw
			.prepare("update api_keys set last_used_at = ? where id = ?")
			.run(new Date().toISOString(), id);
		return secret;
	}

	/** Sekrety dla agenta: nazwa zmiennej → wartość (tylko klucze aktywne i odszyfrowywalne). */
	secretsForAgent(agentName: string): {
		env: Record<string, string>;
		usedLabels: string[];
		problems: string[];
	} {
		const keys = this.keysForAgent(agentName);
		const env: Record<string, string> = {};
		const usedLabels: string[] = [];
		const problems: string[] = [];
		for (const key of keys) {
			if (key.disabled) {
				problems.push(`${key.label}: klucz wyłączony`);
				continue;
			}
			const secret = this.useSecret(key.id);
			if (secret === null) {
				problems.push(`${key.label}: nie mogę odszyfrować (inna maszyna/konto?)`);
				continue;
			}
			env[key.envVar] = secret;
			usedLabels.push(key.label);
		}
		return { env, usedLabels, problems };
	}
}
