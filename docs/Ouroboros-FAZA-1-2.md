# Ouroboros — raport z wdrożenia Fazy 0–2

| | |
|---|---|
| **Dokument** | raport implementacyjny: co z Master Briefu jest już w kodzie, z dowodami |
| **Data** | 2026-09-24 |
| **Zakres** | Faza 0 (migracje schematu), Faza 1 (sejf kluczy API), Faza 2 (dynamiczny rejestr ról) |
| **Baza** | AgentDock 0.1.0 (silnik natywny Windows: Bun + Job Object + worktree + SQLite) |
| **Wynik testów** | **24/24 pass** (2 pliki, 92 asercje, ~7,4 s) |
| **Dokumenty pokrewne** | [`AgentDock-DOKUMENTACJA.md`](AgentDock-DOKUMENTACJA.md), [`AgentDock-BRIEF-DLA-LLM.md`](AgentDock-BRIEF-DLA-LLM.md) |

---

## 0. Mapa briefu: co jest zrobione

| Element Master Briefu | Stan | Dowód |
|---|---|---|
| **Faza 1** — migracja schematu SQLite („wymagane, by bezpiecznie rozwijać projekt”) | **ZAIMPLEMENTOWANE** | `pragma user_version` = 3; migracja realnej bazy z 14 runami bez utraty danych; test automatyczny na bazie „z epoki v1” |
| **Faza 1** — tabela `api_keys` szyfrowana lokalnie | **ZAIMPLEMENTOWANE** | DPAPI (`CryptProtectData`, `crypt32.dll` przez `bun:ffi`); brak jawnych wystąpień sekretu w pliku bazy |
| **Faza 1** — rezygnacja z wstrzykiwania sekretów przez zmienne środowiskowe hosta | **ZAIMPLEMENTOWANE** | sekrety tylko z sejfu; nazwy sekretopodobne w `env` roli odrzucane; test „nieprzypisana zmienna hosta nie przecieka” |
| **Faza 1** — interfejs w UI do zarządzania kluczami | **ZAIMPLEMENTOWANE** | zakładka „Klucze API”: dodawanie, rotacja, wyłączanie, usuwanie, przypisania |
| **Faza 2** — agenci przeniesieni z `config.json` do tabeli `agents` | **ZAIMPLEMENTOWANE** | rejestr w bazie + jednorazowy zasiew z presetów/`config.json` |
| **Faza 2** — API CRUD ról, dodawanie bez restartu serwera | **ZAIMPLEMENTOWANE** | `GET/POST/PUT/DELETE /api/agents`, `PUT /api/agents/:name/keys`; test „rola wykonywalna natychmiast” |
| Faza 3 — Smart Router / Estimator | do zrobienia | plan w §9.1 |
| Faza 4 — narzędzia zewnętrzne (web) | do zrobienia | plan w §9.2 |
| Faza 5 — orkiestracja roju (blackboard) | do zrobienia | plan w §9.3 |
| (dodatkowo, poza briefem) prawda o dostawie: `push_enabled`/`delivery_state`/`push_error` + audyt `keys_used` | **ZAIMPLEMENTOWANE** | kolumny w `runs`; `push=false` ⇒ `skipped_disabled` |

---

## 1. Faza 0 — migracje schematu

### 1.1 Problem

AgentDock tworzył tabele przez `create table if not exists` i nie miał żadnego wersjonowania. Dodanie kolumny do istniejącej bazy u użytkownika kończyło się albo cichym błędem, albo ręczną ingerencją w plik. Wszystkie kolejne fazy (sejf, role, orkiestracja) wymagają zmian schematu, więc to musiał być krok pierwszy.

### 1.2 Rozwiązanie

`src/db.ts` trzyma uporządkowaną listę migracji i numer wersji w `pragma user_version`:

```ts
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, description: "bazowy schemat (projekty, runy, zdarzenia) — zgodny z epoką AgentDocka", sql: [ … ] },
  { version: 2, description: "sejf kluczy API + rejestr agentów (dynamiczne role)",             sql: [ … ] },
  { version: 3, description: "prawda o dostawie + audyt kluczy w runie",                        sql: [ … ] },
];
export const SCHEMA_VERSION = 3;
```

Reguły, które czynią to bezpiecznym:

1. **Krok 1 jest idempotentny** (`create table if not exists`) — dzięki temu stara baza (user_version = 0, tabele już istnieją) przechodzi go bez błędu i „dogania” numerację.
2. **Cała migracja jest w transakcji**; błąd ⇒ rollback i wyjątek z nazwą kroku. Lepiej odmówić startu niż pracować na wpół zmigrowanej bazie.
3. `alter table … add column` nie zna `if not exists` — dlatego łapiemy konkretny błąd `duplicate column name` i traktujemy go jako „już jest”.
4. **Numer wersji jest zapisywany na końcu kroku**, więc przerwanie w połowie nie zostawia fałszywego „done”.

### 1.3 Dowód na realnej bazie

Migracja uruchomionej instancji z historią 14 runów:

```text
  OK   schemat bazy           user_version = 3 (oczekiwane 3)

runy: 15 | zdarzenia: 471 | role: 5 | klucze: 1
kolumny runs: … pushed, memory_limit_mb, timeout_sec, job_kind,
              push_enabled, delivery_state, push_error, keys_used
tabele: agent_keys, agents, api_keys, events, projects, runs
```

Test automatyczny (`tests/ouroboros.test.ts`) buduje bazę „z epoki v1” (schemat kroku 1 + wiersze), ustawia `user_version = 0`, otwiera ją nowym kodem i sprawdza: wersja = 3, dane nietknięte (prompt starego runu, projekt, zdarzenie), nowe kolumny z sensownymi domyślnymi (`push_enabled = 1`), nowe tabele istnieją, ponowne otwarcie jest no-opem.

---

## 2. Faza 1 — sejf kluczy API (API Vault)

### 2.1 Model bezpieczeństwa

Wcześniej sekret szedł do agenta ze środowiska procesu nadrzędnego (`ANTHROPIC_API_KEY` w `config.json` → `process.env`). Wada: każdy proces użytkownika widzi to środowisko, a sekret wycieka do zrzutów i logów.

Teraz:

```text
    UI/CLI                 sejf (SQLite + DPAPI)                 proces agenta
┌───────────┐   zapis   ┌────────────────────────┐  odczyt   ┌───────────────────┐
│ etykieta  │──────────►│ api_keys.cipher        │──────────►│ env[ENV_VAR] = …  │
│ zmienna   │           │ (DPAPI blob, base64)   │  (tylko   │ (życie = życie    │
│ sekret    │           │ hint = ostatnie 4 znaki│   na czas │  procesu runu)    │
└───────────┘           └────────────────────────┘   spawnu) └───────────────────┘
        ▲                                                            │
        └──────────── przypisania: agent_keys(agent_name, key_id) ────┘
```

Kluczowe własności:

- **Sekret nigdy nie opuszcza procesu** — API i UI widzą tylko etykietę, dostawcę, nazwę zmiennej i końcówkę (`hint = ostatnie 4 znaki`).
- **Sekret istnieje jawnie tylko przelotnie**: odszyfrowanie następuje na chwilę przed `Bun.spawn`, a bufor wejściowy jest zerowany po wywołaniu DPAPI.
- **Brak „klucza głównego” na dysku** — DPAPI wiąże szyfrogram z kontem użytkownika i maszyną. Kopia pliku bazy na innym komputerze nie wystarczy do odczytu sekretów.
- **Odmowa zamiast udawania**: gdy DPAPI jest niedostępne, zapis sekretu jest blokowany (chyba że operator jawnie włączy `AGENTDOCK_INSECURE_SECRETS=1`, wtedy prefiks `plain:` i ostrzeżenie w `doctor`/UI).
- **Audyt**: klucz dostaje `last_used_at` przy każdym użyciu, a run zapisuje `keys_used` (etykiety, nie wartości).

### 2.2 Implementacja DPAPI (szczegóły, które kosztowały czas)

`src/vault.ts`, `dlopen` przez `bun:ffi`:

```ts
const crypt32  = dlopen("crypt32.dll",  { CryptProtectData: …, CryptUnprotectData: … });
const kernel32 = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } });
```

Trzy pułapki, które trzeba było rozwiązać (wszystkie złapane przez testy):

1. **`LocalFree` nie jest eksportowany z `crypt32.dll`** — próba załadowania wszystkich trzech funkcji z jednej biblioteki kończy się `Symbol "LocalFree" not found in "crypt32.dll"`. `LocalFree` pochodzi z `kernel32.dll`.
2. **Struktura `DATA_BLOB`** to na x64 16 bajtów: `DWORD cbData` @0, 4 bajty paddingu, `BYTE* pbData` @8 (wpisywane przez `setBigUint64` ze wskaźnika `ptr(buf)`).
3. **Widok vs kopia**: `toArrayBuffer(addr, 0, len)` zwraca *widok* na pamięć natywną, więc kopię (`slice()`) trzeba zrobić **przed** `LocalFree` — inaczej czytamy zwolnioną pamięć.
4. Bufor wejściowy musi żyć do końca wywołania natywnego (struktura trzyma tylko adres) — dlatego jest używany również po wywołaniu (zerowanie).

Format szyfrogramu to standardowy blob DPAPI — rozpoznawalny po nagłówku `AQAAANCMnd8BFdER` w base64.

### 2.3 Schemat i API

```sql
create table api_keys (
  id text primary key, label text not null, provider text not null, env_var text not null,
  cipher text not null, hint text not null default '',
  created_at text not null, last_used_at text, disabled integer not null default 0
);
create table agent_keys (agent_name text not null, key_id text not null,
  primary key (agent_name, key_id));
```

| Operacja | HTTP | CLI |
|---|---|---|
| lista (bez sekretów) | `GET /api/keys` | `agentdock keys` |
| dodanie | `POST /api/keys {label, provider, envVar, secret}` | `agentdock keys add <etykieta> --env <ZMIENNA> [--provider] [--secret]` |
| rotacja | `PUT /api/keys/:id {secret}` | `agentdock keys rotate <id> [--secret]` |
| wyłączenie/włączenie | `PUT /api/keys/:id {disabled}` | `agentdock keys disable\|enable <id>` |
| usunięcie (odwiązuje od ról) | `DELETE /api/keys/:id` | `agentdock keys rm <id>` |

Dostawca jest etykietą operacyjną (`anthropic`, `openai`, `google`, `ollama`, `other`); o tym, gdzie klucz trafia, decyduje **nazwa zmiennej środowiskowej** — dlatego `ollama` (lokalny model) wpisuje się w ten sam mechanizm bez żadnego specjalnego kodu.

### 2.4 UI

Zakładka **Klucze API**: tabela (etykieta, dostawca, zmienna, końcówka, tryb ochrony, przypisania do ról, ostatnie użycie, stan) + akcje `rotuj / wyłącz / usuń` oraz formularz dodawania. Zaznaczenie „Przypisany do” pokazuje, które role mają dostęp — czyli dokładnie ten „prosty menedżer API” z briefu.

---

## 3. Faza 2 — dynamiczny rejestr ról

### 3.1 Zmiana modelu

| | Przed (AgentDock) | Teraz (Ouroboros) |
|---|---|---|
| Definicja roli | `config.json` → `agents` | tabela `agents` w SQLite |
| Zmiana roli | edycja pliku + restart | API/UI/CLI, **od razu** |
| Sekrety roli | lista nazw zmiennych z hosta | przypisania z sejfu (`agent_keys`) |
| Źródło prawdy | plik | baza (`config.json` = jednorazowy zasiew) |

Dodanie roli „w locie” działa, bo `Runner.dispatch()` i `Runner.execute()` czytają definicję z rejestru **w momencie dispatchu** (`agents.spec(name)`), a nie z migawki konfiguracji wziętej przy starcie procesu.

### 3.2 Zasady walidacji (wymuszone w kodzie)

| Reguła | Powód |
|---|---|
| nazwa `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` | nazwa jest kluczem w bazie i trafia do URL/CLI |
| `command` niepuste, ≤ 512 znaków; argument ≤ 4096 znaków | sensowny limit, brak „wstrzyknięcia” przez gigantyczny argv |
| zmienne w `env` muszą być poprawnymi nazwami i **nie mogą wyglądać na sekrety** (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`) | sekrety wyłącznie z sejfu — inaczej dałoby się obejść Fazę 1 przez config |
| agent `builtin` (demo) nie może być usunięty | to ścieżka bez kluczy API, używana przez demo i testy |
| rola wyłączona (`enabled = 0`) nie może zostać uruchomiona | dispatch zwraca jawny błąd |

### 3.3 API i CLI

| Operacja | HTTP | CLI |
|---|---|---|
| lista ról | `GET /api/agents` | `agentdock agents` |
| dodanie | `POST /api/agents` | `agentdock agents add <nazwa> --command "…" [--args "a\|b"] [--stdin] [--env "A,B"] [--description "…"]` |
| edycja | `PUT /api/agents/:name` | — (UI) |
| usunięcie | `DELETE /api/agents/:name` | `agentdock agents rm <nazwa>` |
| włącz/wyłącz | `PUT /api/agents/:name {enabled}` | `agentdock agents enable\|disable <nazwa>` |
| przypisz klucze | `PUT /api/agents/:name/keys {keyIds}` | `agentdock agents keys <nazwa> <key-id>…` |

### 3.4 UI

Zakładka **Role agentów**: formularz (nazwa, komenda, opis, argumenty — jeden na linię, zmienne niesekretne, **multi-select kluczy z sejfu**, stdin, aktywna) + tabela rejestru z akcjami. Kolumna „Klucze” pokazuje realne przypisania, a plakietki ostrzegają, gdy binarki nie ma w PATH.

---

## 4. Zmiany w istniejącym jądrze

| Plik | Zmiana |
|---|---|
| `src/db.ts` | migracje + `SCHEMA_VERSION`; `RunRow` z `push_enabled`, `delivery_state`, `push_error`, `keys_used`; typ `DeliveryState` |
| `src/vault.ts` **(nowy)** | sejf: DPAPI, `protectSecret`/`unprotectSecret`, `ApiVault` (CRUD, przypisania, `secretsForAgent`, `useSecret`), `vaultProtectionMode()` |
| `src/registry.ts` **(nowy)** | `AgentRegistry`: CRUD ról, `spec()` dla runnera, `seed()` z presetów/`config.json`, walidacje i zakaz sekretów w `env` |
| `src/agents.ts` | `resolveAgent({ spec, vars, secrets, extraEnv })` + `buildRunEnv(...)` — sekrety z sejfu, pomijanie nazw sekretopodobnych z ostrzeżeniem; `agentBinaryAvailable(spec)` |
| `src/runner.ts` | `RunnerDeps { vault, agents }`; walidacja roli przez rejestr; log „klucze z sejfu: …” + zapis `keys_used`; jawna dostawa (`skipped_no_commits` / `skipped_cancelled` / `skipped_disabled` / `pushed` / `failed` + `push_error`) |
| `src/server.ts` | `/api/state` (role, klucze, tryb sejfu), `/api/agents*`, `/api/keys*`, `publicRun` z polami dostawy i `keysUsed`; `/healthz` z `schemaVersion`, `vault`, `agents` |
| `src/ui.ts` | trzy zakładki (Runy / Role / Klucze), delegacja zdarzeń `data-act` zamiast generowanych `onclick`, formularze ról i kluczy, rotacja sekretu |
| `src/main.ts` | bootstrap z sejfem i rejestrem + zasiew; `doctor` (schemat, sejf, role, ostrzeżenia o sekretach w `env`); CLI `agents`/`keys`; `run --no-push`; tryb `--demo-agent` wykrywany **pozycyjnie** |
| `src/demo-agent.ts` | knob `[printenv NAZWA]` — raportuje obecność i długość zmiennej (nigdy wartość): narzędzie dowodowe |
| `tests/helpers.ts` **(nowy)** | wspólny warsztat testowy (repo + bare origin + baza + sejf + rejestr + runner) |
| `tests/ouroboros.test.ts` **(nowy)** | 11 testów Fazy 0–2 |
| `tests/agentdock.test.ts` | dostosowane do nowego API runnera; +3 asercje |

---

## 5. Testy i dowody

### 5.1 Automatyczne: 24/24 pass (~7,4 s)

Nowe testy (Faza 0–2):

| Test | Co sprawdza |
|---|---|
| migracje: stara baza z `user_version = 0` migruje się bez utraty danych | trwałość danych + nowe kolumny/tabele + idempotencja |
| DPAPI jest dostępne (Windows) | realne wywołanie WinAPI |
| sejf: zapis, brak wycieku, odszyfrowanie, znacznik użycia | brak sekretu w `list()`, w szyfrogramie i w zwrotce API |
| sejf: rotacja, wyłączenie, odmowa przy złej nazwie zmiennej | cykl życia klucza |
| sejf: usunięcie klucza odwiązuje go od ról | spójność `agent_keys` |
| rejestr ról: zasiew z presetów, ochrona agenta wbudowanego | migracja config → baza |
| rejestr ról: CRUD + rola wykonywalna **natychmiast** | hot reload bez restartu |
| rejestr ról: sekretopodobna nazwa w `env` odrzucona | wymuszenie Fazy 1 |
| **sejf wstrzykuje sekret, a nieprzypisana zmienna hosta nie przecieka** | `OUROBOROS_TEST_SECRET=obecna (długość 17)`, `OUROBOROS_HOST_LEAK=BRAK`, brak wartości w zdarzeniach |
| push=false ⇒ `skipped_disabled`, gałąź tylko lokalnie | jawna dostawa |
| push włączony ⇒ `pushed` | brak regresji |

### 5.2 Dowód na żywo (instancja użytkownika, nie testy)

```text
$ echo -n "sekret-demo-12" | agentdock keys add demo-secret --env OUROBOROS_DEMO_SECRET --provider other
dodano klucz key_muffdh4raoyp — demo-secret → OUROBOROS_DEMO_SECRET (dpapi, końcówka …o-12)

$ agentdock agents add envproof --command "{self}" --args "--demo-agent" --stdin
dodano rolę envproof ({self})

$ agentdock agents keys envproof key_muffdh4raoyp
rola envproof: demo-secret (OUROBOROS_DEMO_SECRET)

$ agentdock run -p "Sprawdź środowisko. [printenv OUROBOROS_DEMO_SECRET] [printenv ANTHROPIC_API_KEY] [commit]" --agent envproof
· klucze z sejfu: demo-secret
! demo-agent: OUROBOROS_DEMO_SECRET=obecna (długość 14)
! demo-agent: ANTHROPIC_API_KEY=BRAK
! demo-agent: OPENAI_API_KEY=BRAK
· run zakończony: succeeded | commity: 1, pliki: 2 (+12/-4) | dostawa: pushed
```

Dodatkowo: `grep` po pliku bazy nie znajduje jawnego sekretu; `/healthz` raportuje `schemaVersion: 3`, `vault: "dpapi"`, `agents: 4`; UI serwuje 3 zakładki, a jego JavaScript przechodzi kontrolę składni.

Weryfikacja w **wersji skompilowanej** (`agentdock.exe`, 86,2 MB) — bo FFI + DPAPI w pojedynczym pliku wykonywalnym to osobne ryzyko:

```text
$ ./agentdock.exe doctor          → schemat v3, sejf DPAPI (1 klucz), 5 ról
$ ./agentdock.exe run -p "… [printenv OUROBOROS_DEMO_SECRET] [printenv ANTHROPIC_API_KEY] [commit]" --agent envproof
  [6]  lifecycle: klucze z sejfu: demo-secret
  [12] stderr: demo-agent: OUROBOROS_DEMO_SECRET=obecna (długość 14)
  [13] stderr: demo-agent: ANTHROPIC_API_KEY=BRAK
  [20] lifecycle: run zakończony: succeeded | commity: 1, pliki: 2 (+12/-4) | dostawa: pushed
```

### 5.3 Rejestr błędów złapanych w tej fazie

| # | Objaw | Przyczyna | Poprawka |
|---|---|---|---|
| 1 | `Symbol "LocalFree" not found in "crypt32.dll"` | `LocalFree` jest eksportowany z `kernel32.dll`, nie z `crypt32.dll` | rozdzielone `dlopen` na dwie biblioteki |
| 2 | `agents add … --args "--demo-agent"` uruchamiał agenta demo zamiast tworzyć rolę | tryb wewnętrzny wykrywany przez `argv.includes("--demo-agent")` | wykrywanie **tylko pozycyjnie** (`argv[1]` dla `.exe`, `argv[2]` dla `bun run`) |
| 3 | `TS2305: Module "bun:ffi" has no exported member 'Lib'` | ta wersja Bun nie eksportuje typu `Lib` | `type LoadedLib = ReturnType<typeof dlopen>` |
| 4 | test jądra padał na asercji domyślnego limitu pamięci | harness testowy używa własnego limitu (1024 MB) | asercja względem `h.config.memoryLimitMb` |
| 5 | `bun: command not found: tsc` | brak `typescript` w devDependencies | `bun add -d typescript`; `bun run typecheck` działa i jest czysty |
| 6 | w katalogu projektu powstał `agentdock-output/run-local.md` | efekt uboczny błędu #2 (agent demo uruchomiony w cwd) | usunięte; problem nie wróci po poprawce #2 |

---

## 6. Kompatybilność wsteczna i migracja użytkownika

1. **`config.json` nadal istnieje**, ale jest tylko *źródłem zasiewu* ról (przy pierwszym starcie po migracji) oraz miejscem na ustawienia globalne. Po zasiewie źródłem prawdy jest baza.
2. **Role z `config.json` z listą sekretów w `env`** (w tej instalacji: `claude`, `codex`, `aider`) zostały zaimportowane, ale przy uruchomieniu runu takie zmienne są **pomijane z ostrzeżeniem w zdarzeniach**, a `doctor` wypisuje:
   ```text
   --   agent: claude    w liście env ma nazwy sekretopodobne (ANTHROPIC_API_KEY, …) — przenieś do sejfu i przypisz do roli
   ```
   To celowa, widoczna ścieżka migracji: klucz → `keys add` → `agents keys`.
3. **Zero utraty historii**: 14 runów sprzed migracji jest nadal czytelnych; mają `delivery_state = null` (nie było wtedy takiego pojęcia) i `pushed` z epoki poprzedniej.
4. **`runs/`, `worktrees/`, transkrypty** — bez zmian formatu; nowe pola dopisują się do wiersza.

---

## 7. Ograniczenia tego etapu (świadome)

| Luka | Konsekwencja | Kierunek |
|---|---|---|
| Brak eksportu/importu sejfu | przeniesienie kluczy na inną maszynę = ponowne wpisanie | „export” DPAPI `CRYPTPROTECT_LOCAL_MACHINE` albo odtworzenie kluczy (świadomie: sekretu nie da się przenieść, i to jest zaleta) |
| Brak ról „szablonowych” w UI | tworzenie roli to ręczne wypełnienie formularza | kreator z presetów (Claude/Codex/Aider/Ollama) jednym klikiem |
| Brak wersjonowania ról | nie widać, kto zmienił definicję i kiedy | tabela `agent_revisions` albo kolumna `revision` + zapis zmian |
| Brak uprawnień per klucz (np. „tylko odczyt”) | klucz jest przypisany do roli albo nie | warstwa polityk dopiero ma sens przy Fazie 5 |
| Brak automatycznego wykrywania rotacji po stronie dostawcy | rotacja ręczna | przypomnienie na podstawie `created_at`/`last_used_at` |
| `doctor` nie sprawdza, czy klucz w sejfie jest *poprawny* (tylko obecny) | literówka w kluczu wyjdzie dopiero w runie | opcjonalny „ping” dostawcy z limitem kosztu |

---

## 8. Co dalej: Fazy 3–5 (plan i decyzje do podjęcia)

### 8.1 Faza 3 — Smart Router / Estimator

Cel z briefu: tanie zadania → model lokalny (Ollama), drogie → API w chmurze.

Propozycja architektury:

```text
dispatch(prompt) ─► Router.estimate(prompt)
                      ├─ sygnały: długość, język, liczba plików w projekcie, słowa-klucze
                      │  („architektura”, „refaktor”, „test”, „formatuj”, „podsumuj”),
                      │  historia: średni koszt/czas podobnych runów z bazy
                      ├─ dostępność: czy Ollama odpowiada na 127.0.0.1:11434 i ma model?
                      └─ decyzja: { tier: "local" | "cloud", model, provider, reason }
                           │
                           ├─► route zapisany w wierszu runu (route_json) + zdarzenie lifecycle
                           └─► extraEnv dla agenta (np. OLLAMA_HOST, ANTHROPIC_MODEL)
```

Decyzje do podjęcia:
1. **Klasyfikator**: deterministyczna heurystyka (szybka, przewidywalna, testowalna) czy mały model lokalny jako klasyfikator (lepszy, ale dodaje zależność i koszt)? Propozycja: heurystyka jako domyślna, klasyfikator-model jako opcja.
2. **Czy router zmienia model w obrębie jednej roli** (przez `extraEnv`) czy wybiera inną rolę (np. `coder-local`)? Propozycja: `extraEnv` + kolumna `route_json` w runie, bo nie mnoży definicji ról.
3. **Progi**: jak mierzyć „skomplikowanie”? Propozycja pierwszej wersji: liczba znaków promptu, obecność słów-kluczy architektonicznych, liczba plików w projekcie, obecność `[commit]`/`[test]`, oraz „czy zadanie dotyka >1 katalogu”.
4. **Bezpieczeństwo**: czy zadanie z sekretami/kluczami może iść do modelu lokalnego? (Ollama = lokalnie, więc tak; chmura = nie, jeżeli prompt zawiera dane wrażliwe — proponuję jawny próg „projekt oznaczony jako `sensitive` nigdy nie idzie do chmury”).

### 8.2 Faza 4 — narzędzia zewnętrzne (web)

Cel z briefu: agenci mają samodzielnie szukać dokumentacji i faktów.

Dwa warianty (do decyzji):

| Wariant | Jak działa | Plusy | Minusy |
|---|---|---|---|
| **A. MCP server w Ouroborosie** | Ouroboros wystawia serwer MCP (stdio lub HTTP) z narzędziami `web.fetch`, `web.search`, `repo.read`, `task.delegate`; harness (np. claude) dostaje `--mcp-config` | nie piszemy własnej pętli agenta; narzędzia są widoczne w harnessie; standard | wymaga wsparcia MCP w harnessie; konfiguracja per rola |
| **B. Własna pętla tool-calls** | Ouroboros przechwytuje „tool call” z wyjścia agenta, wykonuje narzędzie i wstrzykuje wynik | działa dla każdego CLI | trzeba zaimplementować protokół per harness; ryzyko rozjazdu z rzeczywistym CLI |

Zakres narzędzia web (wspólny): allowlista domen, limit rozmiaru odpowiedzi, cache na dysku runu (`runs/<id>/context/web/`), konwersja HTML → tekst, zapis „śladu” (URL, status, ETag, hash treści) do bazy lub pliku, blokada SSRF (żadnych `127.0.0.1`, `169.254.*`, `file://`, prywatnych zakresów).

### 8.3 Faza 5 — orkiestracja roju (Blackboard & Swarm)

To największa zmiana; proponuję rozłożyć na dwa kroki:

**Krok A (serializowany rój w jednym worktree)** — najbliżej briefu („agenci dzielą to samo środowisko”):

```text
swarm (root run)
  ├─ workspace: JEDEN worktree + JEDNA gałąź
  ├─ blackboard: tabele swarm_notes(key, value_json, author_run, created_at)
  │              + pliki .ouroboros/notes/*.md w worktree (czytelne dla agentów)
  ├─ task tree: swarm_tasks(id, swarm_id, parent_id, role, prompt, state,
  │            depends_on, result_json, created_at, started_at, ended_at)
  └─ wykonanie: zadania idą SEKWENCYJNIE (jeden pisarz w worktree), każdy task
                to osobny „run” z własnymi zdarzeniami i kosztem, ale bez
                własnego pusha — push robi korzeń po ostatnim zadaniu
```

**Krok B (równoległość z merge)** — gdy trzeba więcej przepustowości: każde zadanie dostaje własny worktree od tej samej bazy, a wyniki wracają przez `git cherry-pick`/patch do worktree korzenia. Wymaga rozstrzygnięcia konfliktów — dlatego proponuję Krok A jako pierwszy.

Decyzje do podjęcia:
1. **Kto tworzy drzewo zadań**: agent-orchestrator (rola „architekt”) czy deterministyczny rozdzielacz po etykietach z briefu zadania?
2. **Jak agent zgłasza zadanie dziecku**: przez plik `.ouroboros/tasks.json` w worktree (prosty, widoczny w diffie) czy przez CLI/HTTP (`ouroboros task add --role researcher --prompt …`)?
3. **Limity**: budżet kosztu na całe drzewo (nie tylko na run) — to wymaga nowej kolumny/agregacji i egzekwowania w `tick()`.
4. **Blackboard**: tabela (strukturalna, łatwa do zapytań) + odbicie w plikach (czytelne dla agentów) czy tylko pliki (prostsze, ale brak zapytań)?
5. **Bezpieczeństwo**: czy zadania dziecka dziedziczą klucze korzenia (tak domyślnie?) i czy dziedziczą limity pamięci/czasu?

### 8.4 Proponowane kryteria akceptacji dla Faz 3–5

| Faza | Kryterium |
|---|---|
| 3 | Router zapisuje decyzję w runie; przy dostępnym Ollama zadanie „formatuj plik” idzie lokalnie, a „zaprojektuj moduł” do chmury; brak Ollamy nie psuje niczego (fallback + zdarzenie) |
| 4 | Rola z dostępem do sieci potrafi pobrać stronę dokumentacji i zapisać jej treść w kontekście runu; próba wejścia na `127.0.0.1`/zakazaną domenę jest odrzucana i widoczna w zdarzeniach |
| 5 | Drzewo 3 zadań (researcher → coder → tester) w jednym worktree kończy się jednym pushem z commitami wszystkich ról; zadania widoczne w bazie z własnym kosztem; porażka dziecka zatrzymuje rodziców zależnych i jest widoczna w UI |

---

## 9. Komendy weryfikacyjne (copy-paste)

```bat
:: stan po migracji
agentdock.cmd status
agentdock.cmd cli doctor

:: sejf kluczy
echo <sekret> | agentdock.cmd cli keys add moj-klucz --env ANTHROPIC_API_KEY --provider anthropic
agentdock.cmd cli keys
agentdock.cmd cli keys rotate <key-id>
agentdock.cmd cli keys disable <key-id>

:: role
agentdock.cmd cli agents
agentdock.cmd cli agents add researcher --command claude --args "--print|--output-format|stream-json" --stdin
agentdock.cmd cli agents keys researcher <key-id>
agentdock.cmd cli agents disable researcher

:: run z dowodem wstrzyknięcia (bez wypisywania sekretu)
agentdock.cmd cli run -p "Sprawdź środowisko [printenv ANTHROPIC_API_KEY] [commit]" --agent researcher

:: dostawa
agentdock.cmd cli run -p "Zmiana bez pusha [commit]" --agent demo --no-push
agentdock.cmd cli show <run-id>

:: testy i typy
agentdock.cmd test
bun run typecheck
```
