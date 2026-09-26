# AgentDock — dokumentacja techniczna, projektowa i zmiany w projekcie

| | |
|---|---|
| **Dokument** | opis projektu + rejestr zmian + materiał do dyskusji o dalszym rozwoju |
| **Wersja dokumentu** | 1.2 |
| **Data** | 2026-09-24 |
| **Autor implementacji** | sesja robocza (asystent AI) na maszynie użytkownika |
| **Status projektu** | działający prototyp (MVP+), zweryfikowany end-to-end na Windows 11; rozwija się w kierunku **Ouroborosa** (rój agentów) — patrz `Ouroboros-FAZA-1-2.md` i `Ouroboros-FAZA-3.md` |
| **Wersja aplikacji** | AgentDock 0.1.0 (Ouroboros Faza 0–3: migracje + sejf kluczy + role w bazie + Smart Router) |
| **Stan testów** | 47/47 pass (jądro + Faza 0–2 + Faza 3), `bun run typecheck` czysty, schemat bazy v4 |
| **Kod** | `C:\Users\Piotr\Desktop\Ouroboros AI\warren-main\agentdock\` |
| **Dokumenty pokrewne** | `agentdock/README.md`, [`Ouroboros-FAZA-1-2.md`](Ouroboros-FAZA-1-2.md), [`Ouroboros-FAZA-3.md`](Ouroboros-FAZA-3.md) (raporty z wdrożeń), [`AgentDock-BRIEF-DLA-LLM.md`](AgentDock-BRIEF-DLA-LLM.md), `warren-main/warren-windows/README.md`, `warren-main/docs/*` (dokumentacja Warrena) |

> **Uwaga do wersji dokumentu.** Sekcje §1–§13 opisują stan AgentDocka (jądro: worktree, Job Object, eventy, finalizacja, push). Raporty z wdrożeń opisują **zmiany z 2026-09-24**:
> - `Ouroboros-FAZA-1-2.md` — wersjonowane migracje schematu, sejf kluczy API (DPAPI), dynamiczny rejestr ról w bazie, jawna dostawa gałęzi;
> - `Ouroboros-FAZA-3.md` — **Smart Router**: decyzja „model lokalny (Ollama) czy chmura”, heurystyka + klasyfikator, wymuszenia (operator > wrażliwy projekt > rola > tryb), kontrola pobrania modelu, audyt `route_json`, statystyki oszczędności.
>
> Miejsca zaktualizowane w tym dokumencie: §14.1 poz. 1 i 4 oraz §14.4.

---

## Spis treści

- [0. Jak czytać ten dokument](#0-jak-czytać-ten-dokument)
- [1. Streszczenie i tabela faktów](#1-streszczenie-i-tabela-faktów)
- [2. Kontekst: od Warrena do AgentDock](#2-kontekst-od-warrena-do-agentdock)
  - [2.1 Czym jest Warren](#21-czym-jest-warren)
  - [2.2 Dlaczego Warren nie działa natywnie na Windows](#22-dlaczego-warren-nie-działa-natywnie-na-windows)
  - [2.3 Faza 1: kopia robocza Warrena na Windows przez WSL2](#23-faza-1-kopia-robocza-warrena-na-windows-przez-wsl2)
  - [2.4 Faza 2: AgentDock — natywna aplikacja lokalna](#24-faza-2-agentdock--natywna-aplikacja-lokalna)
- [3. AgentDock — przegląd architektury](#3-agentdock--przegląd-architektury)
- [4. Model domenowy i dane](#4-model-domenowy-i-dane)
- [5. Warstwa wykonawcza (runtime)](#5-warstwa-wykonawcza-runtime)
- [6. Agenci](#6-agenci)
- [7. Interfejsy: HTTP API, SSE, CLI, UI, launcher](#7-interfejsy-http-api-sse-cli-ui-launcher)
- [8. Konfiguracja, dane na dysku, instalacja](#8-konfiguracja-dane-na-dysku-instalacja)
- [9. Bezpieczeństwo i izolacja — analiza](#9-bezpieczeństwo-i-izolacja--analiza)
- [10. Wydajność i koszty — pomiary](#10-wydajność-i-koszty--pomiary)
- [11. Weryfikacja: testy i dowody działania](#11-weryfikacja-testy-i-dowody-działania)
- [12. Rejestr zmian (inwentarz plików i błędów)](#12-rejestr-zmian-inwentarz-plików-i-błędów)
- [13. Decyzje projektowe (ADR)](#13-decyzje-projektowe-adr)
- [14. Znane luki, błędy i ryzyka](#14-znane-luki-błędy-i-ryzyka)
- [15. Roadmapa: warianty dalszych zmian + pytania do dyskusji](#15-roadmapa-warianty-dalszych-zmian--pytania-do-dyskusji)
- [16. Pakiety kontekstu do dyskusji z innymi modelami](#16-pakiety-kontekstu-do-dyskusji-z-innymi-modelami)
- [17. Słownik pojęć](#17-słownik-pojęć)
- [18. Aneksy (DDL, config, API, CLI, komendy, layout struktur)](#18-aneksy)

---

## 0. Jak czytać ten dokument

Dokument jest **samowystarczalny**: opisuje kontekst (Warren), powstałą aplikację (AgentDock), wszystkie zmiany wykonane w tej sesji, dowody działania, decyzje projektowe z alternatywami, znane luki oraz warianty dalszego rozwoju wraz z pytaniami.

Konwencje:

- **`§`** — numer sekcji, do cytowania w dyskusji („patrz §5.3”).
- **“Stan: ZAIMPLEMENTOWANE”** — działa i zostało sprawdzone na tej maszynie.
- **“Stan: LUKA”** — świadomie pominięte albo niedokończone.
- **“Stan: PROPOZYCJA”** — nie istnieje, opisane jako wariant do decyzji.
- Fragmenty kodu podane jako `plik:linia` można otworzyć w repozytorium.

Dokument celowo zawiera **liczby i ślady wykonania** (testy, logi, czasy, stany bazy), żeby rozmówca (człowiek lub inny model) nie musiał niczego zakładać.

---

## 1. Streszczenie i tabela faktów

### 1.1 Co zostało zrobione, w trzech zdaniach

1. Przeanalizowano i uruchomiono **Warren 0.19.2** (samodzielnie hostowana infrastruktura dla zadań agentów kodujących) — na Windows przez **WSL2/Ubuntu**, bo Windows nie jest przez Warrena wspierany (brak sandboxa `bwrap`/`sandbox-exec`), co udokumentowano skryptami w `warren-main/warren-windows/`.
2. Następnie zbudowano **AgentDock** — natywną aplikację Windows (bez WSL, bez Dockera, bez Node.js) realizującą to samo jądro: run jako zarządzane obciążenie z izolowanym workspace, limitami, strumieniem zdarzeń, finalizacją i wypchnięciem gałęzi.
3. Aplikacja została zweryfikowana end-to-end: **13/13 testów**, pełny cykl runu (worktree → agent → commit → push), wymuszenie limitu pamięci przez system operacyjny, timeout z ratowaniem pracy, anulowanie z ubiciem drzewa procesów, kolejkowanie 2+1, oraz wersja jednoplikowa `agentdock.exe`.

### 1.2 Tabela faktów (stan na 2026-09-24)

| Obszar | Wartość |
|---|---|
| Nazwa aplikacji | **AgentDock** (nie „warren-lite”, nie fork Warrena — osobna implementacja wzorowana na modelu Warrena) |
| Wersja | 0.1.0 |
| Platforma | Windows 10/11 (testowane na Windows 11 Home, build 26200); kod ma fallbacki dla innych platform, ale Job Object działa tylko na Windows |
| Runtime aplikacji | **Bun 1.4.2** (natywny binarny runtime dla Windows; zainstalowany przez `irm bun.sh/install.ps1 | iex`) |
| Zależności runtime | **zero** (żadnego pakietu npm w kodzie produkcyjnym; `@types/bun` tylko jako devDependency) |
| Liczba plików źródłowych | 12 modułów TS (`src/`), 1 plik testów, 1 skrypt PowerShell, 1 launcher `.cmd`, README |
| Linie kodu | 3 656 (łącznie z testami, README i launcher) |
| Baza danych | SQLite (`bun:sqlite`), WAL, plik `%USERPROFILE%\.agentdock\agentdock.db` |
| UI | jeden plik HTML generowany z `src/ui.ts` (brak kroku budowania, brak frameworka) |
| HTTP API | 10 tras (5 odczyt/zapis + SSE + UI + healthz) |
| CLI | 12 poleceń (`serve`, `demo`, `run`, `projects`, `runs`, `show`, `tail`, `cancel`, `doctor`, `version`, `help`, tryb `--demo-agent`) |
| Izolacja | `git worktree` per run + Windows **Job Object** (limit pamięci, limit procesów, kill-on-close) + allowlist środowiska + per-run git config |
| Limity domyślne | pamięć 2048 MB, czas 1800 s, równoległość 2, maks. 64 procesy w jobie |
| Wypchnięty artefakt | gałąź `agentdock/run-<id>` na `origin` (gwarantowany efekt runu zakończonego sukcesem/porażką; nie po anulowaniu) |
| Testy | 13 testów `bun test`, wszystkie przechodzą (2,2 s) |
| Wersja jednoplikowa | `agentdock.exe` 86 169 088 B (~82 MiB), uruchamia się i wykonuje pełny cykl runu |
| Baza po sesji testowej | 1 projekt, 14 runów (11 `succeeded`, 2 `failed`, 1 `cancelled`), 450 zdarzeń, suma kosztów $0,00462 |
| Token operatora | generowany losowo (`crypto.randomBytes(24).toString("base64url")`), zapisany w `config.json`, wymagany na `/api/*` |
| Binding sieciowy | wyłącznie `127.0.0.1`, port domyślny 8787 |

### 1.3 Diagram: gdzie to stoi w całości

```text
┌─────────────────────────── Ta maszyna (Windows 11) ───────────────────────────┐
│                                                                               │
│  ┌─────────────── WSL2 / Ubuntu 26.04 (faza 1) ───────────────┐               │
│  │  Warren 0.19.2 (kopia źródeł w ~/warren)                   │               │
│  │  runtime: local (bwrap) · SQLite · HTTP :8080              │               │
│  │  + warren-windows/*.sh  (skrypty instalacji i obsługi)     │               │
│  └────────────────────────────────────────────────────────────┘               │
│                                                                               │
│  ┌─────────────── Windows natywnie (faza 2) ──────────────────┐               │
│  │  AgentDock 0.1.0                                           │               │
│  │  runtime: Bun 1.4.2 + WinAPI (Job Object przez bun:ffi)    │               │
│  │  SQLite · HTTP :8787 (loopback) · UI w przeglądarce        │               │
│  │  agentdock.exe (single-file) · agentdock.cmd (launcher)    │               │
│  └────────────────────────────────────────────────────────────┘               │
│                                                                               │
│  Git 2.54 · PowerShell 5.1 · 16 rdzeni · 31,3 GB RAM                          │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Kontekst: od Warrena do AgentDock

### 2.1 Czym jest Warren

**Warren** (`@os-eco/warren-cli`, wersja 0.19.2, licencja MIT, autor Jaymin West, repo `github.com/jayminwest/warren`) to samodzielnie hostowana infrastruktura, która zamienia uruchomienie agenta kodującego w **zarządzane obciążenie** — a nie w sesję w terminalu. Kod źródłowy w tym workspace to snapshot bez `.git` (`warren-main/`), 28 MB.

Model pojęciowy (z dokumentacji projektu):

```text
project registry → dispatch → isolated run → event stream
→ steer or cancel → finalize → push branch → teardown
```

Kluczowe pojęcia Warrena:

| Pojęcie | Znaczenie |
|---|---|
| **harness** | proces agenta, który Warren prowadzi (w dystrybucji: Pi i Claude Code) |
| **runtime** (`WARREN_RUNTIME`) | gdzie run się wykonuje: `local` (bwrap / sandbox-exec), `docker` (kontener obok), `k8s` (pod na run) |
| **forge** | warstwa Git: GitHub App (domyślnie) albo statyczny PAT |
| **tracker** | źródło zadań: Seeds (wbudowany) albo zewnętrzne kontenery `warren-tracker/v1` |
| **agent** | rola (prompt + polityka) nałożona na harness: planner, healer, nightwatch, bugwatch, pr-fixer |
| **run** | jedno wykonanie: workspace → eventy → finalize → push gałęzi |

Warren posiada: cykl życia runu, izolację, strumień zdarzeń, sterowanie (steering), limity kosztu i równoległości, recovery (watchdogi), finalizację (salvage), dostawę Git (push + PR), historię (SQLite/Postgres) za jednym HTTP API, CLI i UI (React), a także opcjonalne rozszerzenia (audit-log, judge, campaign-controller, trackery Jira/ADO). Dokumentacja: `warren-main/docs/` (m.in. `architecture.md`, `quickstart.md`, `cli-reference.md`, `http-api.md`, `design/*`).

Istotne cechy z perspektywy tej pracy:

- **Warren nie obsługuje Windows** — patrz §2.2.
- Sandbox jest **fundamentem** modelu bezpieczeństwa: run dostaje własny UID, własny `/workspace`, własny `$HOME`, widzi tylko wybrane ścieżki (w `src/sandbox/sandbox.ts` i `src/runtime/local/profile.ts`).
- Gwarantowanym efektem runu jest **wypchnięta gałąź**; PR, tracker, preview i judge to reakcje na to zdarzenie.

### 2.2 Dlaczego Warren nie działa natywnie na Windows

To nie jest kwestia „brakującego buildu” — brak jest mechanizmu systemowego, wokół którego zbudowany jest cały runtime:

| Miejsce w kodzie Warrena | Zachowanie | Skutek na Windows |
|---|---|---|
| `src/sandbox/sandbox.ts:44-49` | dispatch po platformie: `darwin` → `sandbox-exec`, `linux` → `bwrap`, inaczej `throw new Error("warren sandbox: unsupported platform …")` | każdy run kończy się błędem |
| `src/sandbox/sandbox.test.ts:156-161` | test wprost zakłada odrzucenie `win32` | „brak wsparcia” jest **kontraktem**, nie przypadkiem |
| `src/cli/commands/up.ts:104-138` | `detectUpRuntime()`: Linux z `bwrap` w PATH → `local`, macOS → `local`, w innym razie komunikat „użyj `docker compose`” | `warren up` na Windows nie wystartuje runtime'u lokalnego |
| `src/sandbox/cgroup.ts` | limit pamięci przez cgroup v2 | brak odpowiednika (na Windows: Job Object) |
| `src/sandbox/inbound-forward.ts` | forward portów przez `nsenter` + `nc` w netns sandboxa | brak netns |
| `src/runtime/local/profile.ts` | profil sandboxa: bind-mount `/usr`, `/etc`, `/lib`, workspace, `$HOME` | brak mount namespace |

Dostępne na Windows alternatywy z dokumentacji Warrena to **Docker Desktop** (`docker compose up -d`, granica: kontener) albo **Kubernetes** (pod per run) — oba wymagają Dockera/k3d i nie dają „lokalnej aplikacji desktopowej”.

### 2.3 Faza 1: kopia robocza Warrena na Windows przez WSL2

**Cel:** mieć działającą kopię Warrena na tej maszynie, bez zmieniania jego kodu.

**Wybrana droga:** kod i serwer w WSL2 (Ubuntu 26.04, jądro 6.18, `bwrap` już zainstalowany), a przeglądarka i skrypty obsługi po stronie Windows (`localhost` jest przez WSL2 przekierowywany automatycznie).

**Co powstało** (`warren-main/warren-windows/`, 24,3 kB):

| Plik | Rola |
|---|---|
| `install-wsl.sh` | jednorazowa instalacja: pakiety (`bubblewrap`, `git`, `unzip`), Bun, kopia źródeł z `/mnt/c` do `~/warren`, `bun install`, build UI (`src/ui/dist`), założenie środowiska demo; flaga `--with-harnesses` instaluje `claude-code`, `pi`, `pnpm` |
| `make-demo-env.sh` | repo demo (bare `origin.git` + klon roboczy), `gitconfig` z `url.<local>.insteadOf` przekierowującym `https://github.com/demo-org/demo-repo` na dysk lokalny, PATH-shim `claude` (deterministyczny agent z harnessu akceptacyjnego Warrena), `seed-agents.json` z agentem `stub-shell` |
| `start.sh` | start serwera w tle (`warren up --no-wizard --no-open`), pidfile, czekanie na `/healthz`, wypisanie URL + tokenu + jednorazowego linku `/setup?code=…`, tryby `--demo` / zwykły (znacznik `demo-mode`) |
| `stop.sh` | SIGTERM do pidfile, fallback `pkill`, czekanie na zwolnienie portu |
| `status.sh` | stan procesu, tryb, `/healthz`, `/readyz`, lista agentów (`/agents`), projektów (`/projects`), runów (`/runs`), ogon logu |
| `demo-run.sh` | rejestracja projektu demo (`warren add-project`), dispatch runu agenta `stub-shell`, weryfikacja wypchniętej gałęzi w `origin.git` |
| `warren.cmd` | jeden punkt wejścia dla Windows: `install | start | stop | status | demo | ui | logs | cli …`; normalizuje CRLF w `.sh` przed uruchomieniem |
| `README.md` | dokumentacja fazy 1 (po polsku): co to Warren, dlaczego WSL, co gdzie leży, jak dodać klucze, ograniczenia, odinstalowanie |

**Dowody działania (faza 1):**

- `GET /healthz` → `{"ok":true}` **wywołane z Windows** (WSL2 forwarding), UI → HTTP 200.
- `GET /readyz` → `bwrap created a minimal sandbox (unshare-all + ro-bind / + exec /bin/true)`, `db_reachable: dialect=sqlite`.
- W trakcie runu widoczny realny sandbox (nie atrapa):
  ```
  /usr/bin/bwrap --unshare-all --share-net --die-with-parent --uid 1000 --gid 1000 \
    --proc /proc --dev /dev --tmpfs /tmp --ro-bind-try /usr /usr … \
    --bind <repo>/.git <repo>/.git \
    --bind …/local/homes/local-run_<id> /home/sandbox \
    --bind …/local/workspaces/local-run_<id> /workspace \
    --chdir /workspace -- claude --print --input-format stream-json --output-format stream-json …
  ```
- Run demo przeszedł pełny cykl: `run.spawned` → eventy agenta → `run.terminal state=succeeded` → `reap.completed branchPushed: true, commitsAhead: 1` → gałąź `warren/run_<id>` obecna w `origin.git`.
- W logu występuje oczekiwana linia `reap.step_failed step:pr_open err:no_credential …` — brak poświadczenia GitHuba (PR nie powstaje, gałąź i tak jest wypchnięta).

**Wniosek z fazy 1:** żeby mieć Warrena na Windows, trzeba użyć cudzego systemu plików (WSL) albo kontenera. To jest dokładnie ta granica, którą faza 2 miała obejść.

### 2.4 Faza 2: AgentDock — natywna aplikacja lokalna

**Cel użytkownika:** „podobny projekt działający na Windows lokalnie, odpalany jako aplikacja lokalna”.

**Zakres, jaki przyjęto (i dlaczego):** nie da się (i nie ma sensu) przenosić Warrena 1:1 — brakuje K8s, dockerowego runtime'u, GitHub App, trackerów, preview. Przeniesiono więc **jądro**: izolowany run, workspace, obserwowalność, limity, finalizacja i push, plus historia i UI. Świadomie odrzucono wieloużytkownikowość, RBAC i chmurę.

**Co jest inne od Warrena (na poziomie decyzji):**

| Aspekt | Warren | AgentDock |
|---|---|---|
| Platforma | macOS/Linux, opcjonalnie Docker/K8s | Windows natywnie (kod ma fallbacki dla innych OS-ów) |
| Granica izolacji | namespaces (bwrap) / kontener / pod | worktree + Job Object + allowlist env |
| Jail systemu plików | tak | **nie** (patrz §9.2) |
| Wypuszczanie kodu | PR przez GitHub App/PAT | push gałęzi na `origin`; PR robisz sam |
| Harnessy | adaptery Pi i Claude Code | dowolne CLI + 4 presety + wbudowany agent demo |
| Stan | SQLite/Postgres | SQLite (WAL) |
| Transport live | SSE (`/runs/:id/events?follow=1`) | SSE (`/api/runs/:id/events`) |
| Licencja/publikacja | projekt open source | aplikacja lokalna użytkownika (brak publikacji) |

---

## 3. AgentDock — przegląd architektury

### 3.1 Stos technologiczny

| Warstwa | Wybór | Dlaczego |
|---|---|---|
| Runtime | Bun 1.4.2 | jeden binarny plik, wbudowane `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `bun:ffi` (FFI do `kernel32.dll`), kompilacja do `.exe` |
| Język | TypeScript (bez transpilacji do JS w dev) | Bun uruchamia `.ts` bezpośrednio |
| Baza | SQLite (WAL) | zero instalacji, wystarczające dla jednego użytkownika |
| HTTP | `Bun.serve` (routing ręczny) | brak zależności, pełna kontrola nad SSE |
| UI | jeden plik HTML (inline CSS+JS) | brak buildu i brak `node_modules` po stronie UI |
| Procesy | `Bun.spawn` + `windowsHide` | brak migających okien konsoli |
| Ograniczenia procesu | **Job Object** przez `bun:ffi` | jedyny realny mechanizm limitów per-proces na Windows |
| Launcher | `.cmd` + `Start-Process` (PowerShell) | uruchomienie „jak aplikacja”: ukryty proces w tle + karta przeglądarki |

### 3.2 Mapa modułów

| Plik | Linie | Odpowiedzialność | Kluczowe elementy |
|---|---:|---|---|
| `src/main.ts` | 528 | punkt wejścia, CLI, bootstrap, serwer, demo, konfiguracja hosta runów | `main()`, `serve()`, `demo()`, `Host` (`httpHost`/`localHost`), `doctor()`, `followRun()`, `ensureDemoRepo()` |
| `src/runner.ts` | 605 | cykl życia runu (maszyna stanów) | `Runner`, `dispatch()`, `tick()`, `execute()`, `cancel()`, `recover()`, `drain()`, `emit()`, `pumpLines()`, `extractUsage()` |
| `src/server.ts` | 287 | HTTP API, SSE, serwowanie UI, autoryzacja | `startServer()`, `sseResponse()`, `publicRun()`, `authorized()` |
| `src/ui.ts` | 403 | cały frontend jako string HTML | `UI_HTML`, funkcje `refresh/render*/dispatchRun/cancelRun/attachStream` |
| `src/db.ts` | 296 | schemat i repozytoria SQLite | `AgentDockDb`, typy `ProjectRow`/`RunRow`/`EventRow`/`RunState`, `appendEvent()` z sekwencją |
| `src/git.ts` | 200 | wszystkie operacje git | `git()`, `prepareBase()`, `worktreeAdd/Remove()`, `commitAll()`, `diffStat()`, `pushBranch()`, `clone()` |
| `src/job.ts` | 155 | Job Object (WinAPI przez FFI) | `createRunJob()`, `buildExtendedLimitInfo()`, `jobObjectsSupported()`, `RunJob` |
| `src/agents.ts` | 103 | rozwiązywanie agenta na argv+env | `resolveAgent()`, `buildRunEnv()`, `selfArgv()`, `agentBinaryAvailable()` |
| `src/config.ts` | 163 | konfiguracja, presety, allowlist | `loadConfig()`, `defaultConfig()`, `DEFAULT_AGENTS`, `BASE_ENV_ALLOWLIST` |
| `src/demo-agent.ts` | 169 | wbudowany agent demo (bez modelu) | `runDemoAgent()`, `parseKnobs()`, emisja `stream-json` |
| `src/projects.ts` | 66 | rejestracja projektów | `addProject()` (ścieżka lokalna lub URL → klon do `repos/`) |
| `src/paths.ts` | 43 | katalog danych i jego struktura | `resolveRoot()`, `appPaths()`, `ensureDirs()`, `APP_VERSION` |
| `tests/agentdock.test.ts` | 200 | testy jednostkowe + E2E | 13 testów, patrz §11.1 |
| `tools/agentdock-start.ps1` | 68 | start w tle + czekanie na healthz | ASCII-only (encoding PS 5.1), cytowanie ścieżek ze spacjami |
| `agentdock.cmd` | 113 | launcher dla człowieka | `start/stop/status/demo/ui/logs/test/build/shortcut/cli/help`, styl „label + goto” |
| `README.md` | 218 | dokumentacja użytkownika | szybki start, izolacja, agenci, CLI, dane, build, porównanie z Warrenem |

**Suma: 3 656 linii** (bez `node_modules`, bez `bun.lock`, bez `agentdock.exe`).

### 3.3 Przepływ sterowania (dispatch → koniec)

```text
UI (fetch) ─┐
CLI (bun run src/main.ts run) ─┼─► POST /api/runs ─► Runner.dispatch()
                              │                      ├─ walidacja projektu/agenta/promptu
                              │                      ├─ insert do bazy (state=queued) + zamrożenie limitów
                              │                      └─ tick()
                              ▼
                    Runner.tick()  (limit: active.size + starting.size < maxConcurrent)
                              │
                              ▼
                    Runner.execute(run)               [async, po jednym na run]
                     1. mkdir runs/<id>/, prompt.md, gitconfig
                     2. git fetch + rev-parse bazy     (prepareBase)
                     3. git worktree add -b agentdock/run-<id>
                     4. resolveAgent() → argv + env
                     5. createRunJob() (Job Object + limity)
                     6. Bun.spawn(cwd=worktree, env=allowlist)  + job.assign(pid)
                     7. pumpLines(stdout/stderr) → emit() → SQLite + SSE
                     8. timeout timer → TerminateJobObject
                     9. await exit → finalizing
                    10. commitAll (salvage) → diffStat → pushBranch
                    11. worktree remove + prune
                    12. state terminal + tick() (start kolejnego z kolejki)
```

Ścieżki wejścia do tego samego rdzenia:

- **serwer** (proces w tle) — hostuje runy; CLI i UI tylko zlecają przez HTTP;
- **CLI bez serwera** — ten sam proces CLI uruchamia `Runner` in-process (CLI informuje o tym użytkownika);
- **`agentdock.exe`** — identyczna logika w pojedynczym pliku wykonywalnym.

---

## 4. Model domenowy i dane

### 4.1 Pojęcia

| Pojęcie | Definicja w AgentDock | Uwagi |
|---|---|---|
| **Projekt** | repozytorium git na dysku (ścieżka lokalna) albo sklonowane z URL do `repos/<nazwa>` | musi być repo git — inaczej rejestracja kończy się błędem |
| **Agent** | nazwany preset `{ command, args, stdinPrompt?, env? }` | definiowany w `config.json`; może być wbudowany |
| **Run** | jedno wykonanie agenta na projekcie; wiersz w bazie z zamrożonymi parametrami | id postaci `run_<base36-czas><6 losowych>` |
| **Zdarzenie** | linia z procesu agenta albo komunikat cyklu życia; zapisane z numerem sekwencji | per run, sekwencja od 1 |
| **Worktree** | katalog roboczy runu (`git worktree`), gałąź `agentdock/run-<id>` | kasowany po finalizacji, gałąź zostaje |
| **Job (Job Object)** | obiekt jądra Windows grupujący procesy runu i egzekwujący limity | tworzony przed spawnem, zamykany po runie |
| **Salvage** | commit tego, co agent zostawił niezacommitowane | ratuje pracę po porażce/timeoucie |
| **Push** | `git push -u origin <gałąź>` po finalizacji | tylko dla runów nieanulowanych |

### 4.2 Maszyna stanów runu

```text
                    ┌──────────┐
      dispatch ────►│  queued  │
                    └────┬─────┘
                         │ tick() (wolny slot)
                         ▼
                    ┌───────────┐   błąd przygotowania   ┌────────┐
                    │ preparing │───────────────────────►│ failed │
                    └─────┬─────┘                        └────────┘
                          │ spawn + assign do joba
                          ▼
                    ┌─────────┐  cancel/timeout ──┐
                    │ running │◄──────────────────┘
                    └────┬────┘
                         │ proces zakończony
                         ▼
                    ┌────────────┐
                    │ finalizing │ (commit szczątków, diffstat, push, sprzątanie)
                    └─────┬──────┘
                          ▼
             ┌────────────┼─────────────┐
             ▼            ▼             ▼
       ┌───────────┐ ┌────────┐ ┌───────────┐
       │ succeeded │ │ failed │ │ cancelled │
       └───────────┘ └────────┘ └───────────┘
```

**Tabela przejść i warunków:**

| Z | Do | Warunek | Skutki uboczne |
|---|---|---|---|
| — | `queued` | `POST /api/runs` / CLI `run` / UI | wiersz w bazie z limitami, zdarzenie `lifecycle` |
| `queued` | `preparing` | `tick()` znalazł wolny slot (`active+starting < maxConcurrent`) | `started_at`, wpis do zbioru `starting` |
| `preparing` | `running` | worktree utworzony i proces wystartował | `pid`, `job_kind`, `branch`, `worktree`, `base_commit` |
| `preparing` | `failed` | wyjątek (np. brak repo, konflikt gałęzi, brak `git`) | `failure_reason` = treść błędu |
| `running` | `finalizing` | proces zakończony (dowolnym kodem) | `exit_code` |
| `running` | `finalizing` (jako cancelled) | `cancel()` albo timeout | `TerminateJobObject`, `failure_reason` = powód |
| `finalizing` | `succeeded` | kod wyjścia 0 i brak anulowania/timeoutu | `cost_usd`, `tokens_*`, `commits_ahead`, `files_changed`, `insertions`, `deletions`, `pushed` |
| `finalizing` | `failed` | kod ≠ 0 albo timeout | j.w. + `failure_reason` |
| `finalizing` | `cancelled` | anulowanie operatora | j.w., **bez pusha** |
| dowolny nieterminalny | `failed` | restart procesu-gospodarza (`recover()`) | `failure_reason` = „przerwany przez restart aplikacji” |

**Gwarancje i nie-zobowiązania:**

- **Gwarancja:** run, który nie został anulowany, kończy się wypchnięciem gałęzi, jeśli powstał choć jeden commit (własny commit agenta albo salvage).
- **Nie-gwarancja:** anulowany run nie pushuje (świadoma decyzja: nie wysyłamy połowicznej pracy). Gałąź i commit zostają lokalnie.
- **Nie-gwarancja:** brak zewnętrznego PR/merge — to poza zakresem.

### 4.3 Schemat bazy

```sql
-- §18.A zawiera pełne DDL; poniżej skrót z rolą kolumn
projects(id PK, name, path UNIQUE-w-logice, url, default_branch, added_at)

runs(
  id PK, project_id, agent, prompt,
  state,                       -- queued|preparing|running|finalizing|succeeded|failed|cancelled
  branch, worktree, base_commit,
  pid, exit_code, failure_reason,
  created_at, started_at, ended_at,
  cost_usd, tokens_in, tokens_out,
  commits_ahead, files_changed, insertions, deletions,
  pushed,                      -- 0/1 (uwaga: nie rozróżnia „nie było czego pushować” od „push się nie udał” → §14.1)
  memory_limit_mb, timeout_sec,
  job_kind                     -- win32-job | none
)

events(id PK autoincrement, run_id, seq, ts, kind, stream, text)
  -- kind: lifecycle | stdout | stderr ; indeks (run_id, seq) ; indeks po state w runs
```

**Właściwości:**

- WAL (`pragma journal_mode = WAL`) → odczyt z UI/CLI nie blokuje zapisu z runnera.
- Zdarzenia są **append-only** z sekwencją liczoną w `appendEvent()` (`max(seq)+1`) — UI potrafi odtworzyć przebieg i dołączyć do żywego strumienia bez duplikatów.
- Brak mechanizmu migracji schematu: tabele tworzone przez `create table if not exists`. Konsekwencja: dodanie kolumny wymaga migracji (patrz §14.4 — propozycja).

### 4.4 Zdarzenia

| Rodzaj | `stream` | Treść | Przykład |
|---|---|---|---|
| `lifecycle` | `null` | decyzje runnera: kolejka, baza, worktree, spawn, anulowanie, finalizacja, wynik | `run wystartował (pid 146548, limity: win32-job, 2048 MB)` |
| `stdout` | `stdout` | linia z procesu agenta | `{"type":"assistant",…}` |
| `stderr` | `stderr` | linia z `stderr` procesu | `demo-agent: commit wykonany przez agenta` |

Limity ochronne (żeby run nie zapchał dysku/UI):

- `MAX_EVENTS_PER_RUN = 20 000` — po przekroczeniu zdarzenia przestają być zapisywane (jednorazowa notka w logu),
- `MAX_LINE_CHARS = 20 000` — dłuższe linie są ucinane z `…`,
- transkrypt runu dodatkowo zapisywany do `runs/<id>/transcript.log` (JSON-per-linia: `{seq,kind,stream,text}`).

---

## 5. Warstwa wykonawcza (runtime)

### 5.1 Workspace: worktree, baza, gałęzie

Kroki w `Runner.execute()` (`src/runner.ts:392-440`):

1. `runs/<run-id>/` + `prompt.md` (treść zadania) + `gitconfig` (per-run config, patrz §6.3).
2. `prepareBase(repo, default_branch)` — jeśli jest `origin`: `git fetch --quiet origin <gałąź>`; potem `rev-parse origin/<gałąź>` → SHA i `ref`; gdy fetch/ref niedostępny, fallback na lokalną gałąź.
3. `git worktree add -b agentdock/run-<id> <worktrees>/<run-id> <base-ref>` — świeży katalog roboczy, brak współdzielenia z Twoim checkoutem.
4. Po zakończeniu: `git worktree remove --force`, potem `git worktree prune`; **gałąź zostaje w repo**.

Konsekwencje (ważne dla dyskusji):

- równoległe runy na tym samym repo są bezpieczne (osobne katalogi i gałęzie),
- Twój working tree nigdy nie jest dotykany (nawet gdy agent robi `git reset --hard`),
- gałęzie runów zostają jako ślad (brak automatycznej retencji — §14.5).

### 5.2 Proces agenta: spawn, środowisko, stdin

| Parametr `Bun.spawn` | Wartość | Uzasadnienie |
|---|---|---|
| `cwd` | katalog worktree | praca zawsze w izolowanym workspace |
| `env` | allowlist (21 zmiennych) + zmienne agenta + wstrzyknięte `AGENTDOCK_*`/`GIT_*` | brak dziedziczenia sekretów z procesu nadrzędnego |
| `stdin` | `pipe` gdy `stdinPrompt: true`, inaczej `ignore` | prompt trafia na stdin (tak działa `claude --print`) |
| `stdout`/`stderr` | `pipe` → `pumpLines()` | linia = zdarzenie; brak buforowania całego wyjścia |
| `windowsHide` | `true` | brak migających okien konsoli |

`pumpLines()` (`src/runner.ts:104-133`) czyta strumień przez `TextDecoder` (obsługa wielobajtowych znaków na granicy chunków), dzieli po `\n`, zdejmuje `\r`, a przy przekroczeniu `MAX_LINE_CHARS` uwalnia bufor (ochrona przed „linią bez końca”).

### 5.3 Job Object — dokładny mechanizm

Job Object to jądrowy obiekt Windows grupujący procesy. AgentDock tworzy go **przed** uruchomieniem agenta i przypina proces agenta, dzięki czemu limity działają dla całego drzewa (agent + `git` + to, co agent odpali).

**Wywołania WinAPI** (`src/job.ts:41-49`, wszystkie przez `bun:ffi` → `kernel32.dll`):

| Funkcja | Argumenty | Rola |
|---|---|---|
| `CreateJobObjectW(attrs=null, name=null)` | — | tworzy job (bez nazwy → prywatny) |
| `SetInformationJobObject(job, JobObjectExtendedLimitInformation=9, info, 144)` | struktura 144 B | ustawia limity |
| `OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE, 0, pid)` | `0x100|0x1` | uchwyt do procesu agenta |
| `AssignProcessToJobObject(job, proc)` | — | przypina proces (i jego przyszłe dzieci) |
| `TerminateJobObject(job, 1)` | — | ubija całe drzewo (cancel/timeout) |
| `CloseHandle(job)` | — | zwolnienie; `KILL_ON_JOB_CLOSE` dobija resztę |

**Struktura `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` (layout x64 = 144 B)** — budowana jako `Uint8Array(144)` + `DataView`:

| Offset | Pole | Ustawiane przez AgentDock |
|---:|---|---|
| 0 | `PerProcessUserTimeLimit` (LARGE_INTEGER) | — |
| 8 | `PerJobUserTimeLimit` (LARGE_INTEGER) | — |
| **16** | `LimitFlags` (DWORD) | kombinacja flag poniżej |
| 24 | `MinimumWorkingSetSize` | — |
| 32 | `MaximumWorkingSetSize` | — |
| **40** | `ActiveProcessLimit` (DWORD) | `64` (`ACTIVE_PROCESS_LIMIT`) |
| 48 | `Affinity` (ULONG_PTR) | — |
| 56 / 60 | `PriorityClass` / `SchedulingClass` | — |
| 64…111 | `IO_COUNTERS` (6 × LARGE_INTEGER = 48 B) | — |
| **112** | `ProcessMemoryLimit` (SIZE_T, `setBigUint64`) | `memory_limit_mb × 1024 × 1024` |
| 120 / 128 | `JobMemoryLimit` / `Peak*` | — |

(Układ wynika z wyrównania: `BasicLimitInformation` = 64 B, potem 48 B liczników I/O, zatem limit pamięci procesu wypada na offsecie 112.)

**Użyte flagi:**

| Flaga | Wartość | Efekt | Odpowiednik w Warrenie |
|---|---:|---|---|
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` | `0x100` | przekroczenie limitu → proces dostaje błąd alokacji / kończy się | cgroup `memory.max` |
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | `0x8` | maks. 64 równoczesne procesy w jobie (odrzuca kolejne `CreateProcess`) | — |
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | `0x2000` | zamknięcie uchwytu ubija całe drzewo → **zero sierot** | `--die-with-parent` w bwrap |
| `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` | `0x400` | zdefiniowane, nieużywane domyślnie | — |

**Degradacja:** gdy FFI albo platforma niedostępne (`jobObjectsSupported() === false`), `createRunJob()` zwraca no-op o `kind: "none"`; runy nadal działają, ale bez limitów systemowych. Fakt ten jest widoczny w `job_kind` wiersza runu, w UI (`izolacja: Job Object (limity OS)`) i w `doctor`.

**Znane okno czasowe:** proces jest przypinany do joba **po** starcie (`Bun.spawn` nie tworzy procesu zawieszonego), więc teoretycznie agent może odpalić dziecko przed `AssignProcessToJobObject`. W praktyce to milisekundy; alternatywa (`CREATE_SUSPENDED` przez FFI) jest wariantem do dyskusji (§15.B3).

### 5.4 Nadzór: timeout, cancel, salvage, drain, recover

| Mechanizm | Implementacja | Zachowanie |
|---|---|---|
| **Timeout** | `setTimeout(timeout_sec × 1000)` → `terminate(active)` | ustawia `timedOut`, `TerminateJobObject`, potem normalna finalizacja; stan `failed`, powód „przekroczony limit czasu (Ns)” |
| **Cancel** | `POST /api/runs/:id/cancel` → `Runner.cancel()` | jeśli run działa: `cancelReason` + ubicie drzewa; jeśli stoi w kolejce: natychmiast `cancelled` bez startu |
| **Salvage** | `commitAll()` w finalizacji | wszystko niezacommitowane staje się commitem `agentdock: <pierwsze 72 znaki promptu>` |
| **Drain** | `Runner.drain()` przy SIGINT/SIGTERM | czeka do 15 s na zakończenie runów, potem ubija resztę; `server.stop()`, usunięcie pidfile, `db.close()` |
| **Recover** | `Runner.recover()` przy starcie | runy w stanach nieterminalnych z poprzedniej sesji → `failed` z powodem „przerwany przez restart aplikacji” (worktree zostaje na dysku do obejrzenia) |
| **Limit zdarzeń** | licznik per run | po 20 000 zdarzeń zapis zatrzymany z jednorazową notką |

**Uwaga o zatrzymaniu aplikacji:** `agentdock.cmd stop` używa `taskkill /PID <pid> /T /F`, czyli twardego ubicia drzewa — runy w locie zostaną po restarcie oznaczone jako przerwane (`recover()`). Łagodna ścieżka (Ctrl-C w konsoli serwera) uruchamia `drain()`. To różnica, którą warto rozstrzygnąć w dyskusji (§15.G4).

### 5.5 Finalizacja — sekwencja i odporność na błędy

```text
state := finalizing                      (exit_code zapisany)
try:
  commit := commitAll(worktree, "agentdock: <prompt>", identity)   # tylko gdy dirty
  commitsAhead := rev-list --count <base>..HEAD
  diff := diff --shortstat <base>..HEAD  → files/insertions/deletions
  if commitsAhead > 0 and not cancelled:
      pushBranch(worktree, branch)        # GIT_TERMINAL_PROMPT=0
  if cancelled: notka „gałąź zostaje lokalnie, bez pusha”
  worktree remove --force ; worktree prune
catch err:
  zdarzenie lifecycle „błąd finalizacji: …”   (run nadal kończy się stanem terminalnym)
```

Zasady:

- **Błąd finalizacji nie wywraca runu** — jest logowany jako zdarzenie, run dostaje stan wynikający z procesu agenta.
- **Push nigdy nie rzuca** — `pushBranch()` zwraca `{pushed, message}`; komunikat trafia do zdarzenia.
- **Sprzątanie jest best-effort** — nieudane `worktree remove` też jest odnotowane.

### 5.6 Kolejka i współbieżność

- Limit: `active.size + starting.size < maxConcurrent` (`src/runner.ts:270`).
- **Dlaczego dwa zbiory:** `execute()` jest asynchroniczne (fetch, `worktree add`), więc run „przejęty” przez `tick()` nie jest jeszcze w `active`. Bez zbioru `starting` trzy dispatche pod rząd uruchamiały trzy runy mimo `maxConcurrent = 2` (błąd złapany podczas weryfikacji — §12.3 poz. 11).
- Run przechodzi z `starting` do `active` w momencie spawnu (`this.starting.delete(run.id)` tuż po `this.active.set(...)`); bez tego licznik liczyłby go podwójnie (też złapane w testach).
- `queued → preparing` ustawiane **synchronicznie** przed pracą asynchroniczną, żeby dwa równoległe `tick()` nie wzięły tego samego wiersza.
- Po zakończeniu runu `tick()` startuje następny z kolejki.

---

## 6. Agenci

### 6.1 Presety i placeholdery

Cztery presety domyślne (`src/config.ts:74-110`):

| Nazwa | `command` | `args` | `stdinPrompt` | `env` (dodatkowe) |
|---|---|---|---|---|
| `demo` | `{self}` | `["--demo-agent"]` | tak | — (wbudowany, bez modelu) |
| `claude` | `claude` | `--print --output-format stream-json --verbose --dangerously-skip-permissions` | tak | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` |
| `codex` | `codex` | `exec --full-auto {prompt}` | nie | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| `aider` | `aider` | `--yes-always --no-auto-commits --message {prompt}` | nie | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` |

Placeholdery podstawiane w `command` i `args` (`src/agents.ts:52-58`, `69-95`):

| Placeholder | Wartość |
|---|---|
| `{prompt}` | pełna treść zadania (do argumentu) |
| `{promptFile}` | ścieżka do `runs/<id>/prompt.md` |
| `{workspace}` | katalog worktree |
| `{runId}` | identyfikator runu |
| `{self}` | sam AgentDock (tylko jako `command`; → `process.execPath` + ewentualnie ścieżka skryptu) |

### 6.2 Allowlist środowiska

**Bazowa lista (21 zmiennych, przenoszone bez zmian):**

`PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `CommonProgramFiles`, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`, `OS`, `LANG`, `LC_ALL`, `PYTHONIOENCODING`.

**Wstrzykiwane zawsze:**

| Zmienna | Wartość | Po co |
|---|---|---|
| `AGENTDOCK` | `1` | agent wie, że działa w AgentDocku |
| `AGENTDOCK_RUN_ID` | `run_…` | identyfikacja (używa jej agent demo przy nazwie pliku) |
| `AGENTDOCK_PROJECT` | nazwa projektu | kontekst |
| `AGENTDOCK_WORKSPACE` | ścieżka worktree | agent nie musi zgadywać katalogu |
| `AGENTDOCK_PROMPT_FILE` | ścieżka `prompt.md` | dla agentów czytających zadanie z pliku |
| `GIT_TERMINAL_PROMPT` | `0` | żadnych interaktywnych pytań o hasło |
| `GIT_CONFIG_NOSYSTEM` | `1` | brak systemowego configu gita |
| `GIT_CONFIG_GLOBAL` | `runs/<id>/gitconfig` | **izolacja tożsamości i poświadczeń** (patrz §6.3) |
| `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | `<projekt> (AgentDock)` / `agentdock@localhost` | deterministyczne commity |

**Czego agent nie widzi:** Twoich kluczy API innych dostawców, tokenów GitHuba, sekretów aplikacji itp. — o ile nie są jawnie wymienione w `agents.<nazwa>.env`.

### 6.3 Per-run git config (dlaczego to ważne)

Plik `runs/<id>/gitconfig` zawiera wyłącznie:

```ini
[user]        name = AgentDock / email = agentdock@localhost
[init]        defaultBranch = <gałąź projektu>
[safe]        directory = *
[core]        autocrlf = false
```

Dzięki `GIT_CONFIG_GLOBAL` wskazującemu na ten plik (i `GIT_CONFIG_NOSYSTEM=1`) agent:

- commituje z przewidywalną tożsamością, niezależnie od configu użytkownika,
- **nie używa** Twoich credential helperów ani tokenów z `~/.gitconfig` — nie może „przypadkiem” pushować Twoim kontem,
- nie dziedziczy ustawień typu `core.autocrlf`, które psułyby commity między Windows a repo.

Push wykonuje **AgentDock** (w kontekście procesu nadrzędnego, z Twoim środowiskiem), a nie agent — więc dostawa działa, ale agent nie ma kluczy.

### 6.4 Wbudowany agent demo

`src/demo-agent.ts` — deterministyczny „coding agent” bez modelu. Po co: pozwala sprawdzić **cały** cykl życia (workspace, Job Object, strumień zdarzeń, commit, push, statystyki kosztu) bez klucza API i bez sieci, oraz stabilnie testować parser kosztu/tokenów na prawdziwym kształcie `stream-json`.

Zachowanie: wypisuje kopertę `system/init`, kopertę `assistant`, linie diagnostyczne na `stderr`, zapisuje `agentdock-output/run-<id>.md` w worktree, opcjonalnie commituje, na końcu emituje kopertę `result` z `total_cost_usd` i `usage`.

Knobs (w treści promptu):

| Knob | Efekt | Użycie w testach |
|---|---|---|
| `[sleep_ms=N]` | praca w tle z heartbeatami (1/s) | anulowanie, timeout, kolejka |
| `[mem_mb=N]` | alokuje N MB i trzyma | weryfikacja limitu pamięci Job Object |
| `[fail]` | kończy kodem 1 | ścieżka porażki |
| `[commit]` | agent commituje sam | „agent commituje” vs „salvage” |
| `[silent]` | brak wyjścia i pliku | run bez efektów |

### 6.5 Parsowanie kosztu i tokenów

`extractUsage()` (`src/runner.ts:78-102`) dla każdej linii zaczynającej się od `{`:

1. `JSON.parse` (błąd → ignorowane),
2. `usage` z obiektu albo z `message.usage` → `input_tokens|inputTokens`, `output_tokens|outputTokens` (sumowane),
3. `total_cost_usd | cost_usd | costUsd` (sumowane).

Działa to dla kopert `claude-code` (`type: "result"`), a także dla dostawców podających `usage` w dowolnej kopercie. **Ograniczenie:** brak normalizacji per-harness (np. inny format u Pi) — do rozstrzygnięcia w §15.E1.

### 6.6 Przepis: dodanie własnego agenta

1. Sprawdź, czy CLI jest w PATH (`agentdock.cmd cli doctor`).
2. Dopisz wpis do `%USERPROFILE%\.agentdock\config.json`:

```json
"moj-agent": {
  "description": "Mój agent CLI",
  "command": "moj-agent",
  "args": ["run", "--task", "{prompt}", "--cwd", "{workspace}"],
  "env": ["MOJ_KLUCZ_API"]
}
```

3. Ustaw `MOJ_KLUCZ_API` w środowisku użytkownika (`setx`) i zrestartuj aplikację.
4. `agentdock.cmd cli run -p "zadanie" --agent moj-agent`.

Uwaga: agent dostanie `cwd = worktree` — jeśli wymaga jawnej ścieżki, użyj `{workspace}`.

---

## 7. Interfejsy: HTTP API, SSE, CLI, UI, launcher

### 7.1 HTTP API

Binding: `127.0.0.1:<port>` (domyślnie 8787), `idleTimeout: 120 s` (SSE), odpowiedzi JSON z `cache-control: no-store`.

| Metoda | Ścieżka | Auth | Body / parametry | Odpowiedź | Kody błędów |
|---|---|---|---|---|---|
| `GET` | `/healthz` | nie | — | `{ok, app, version, active, db, jobObjects}` | — |
| `GET` | `/`, `/index.html`, `/setup` | nie | — | HTML UI | — |
| `GET` | `/api/state` | tak | — | `{projects, agents, runs, stats, limits, paths, version}` | 401 |
| `POST` | `/api/projects` | tak | `{path}` albo `{url, name?}` | `{project}` (201) | 400 (brak/nie-git/błąd klonu), 401 |
| `DELETE` | `/api/projects/:id` | tak | — | `{ok:true}` | 401 |
| `POST` | `/api/runs` | tak | `{projectId, agent, prompt, memoryLimitMb?, timeoutSec?, push?}` | `{run}` (201) | 400 (walidacja), 401 |
| `GET` | `/api/runs/:id` | tak | — | `{run, events[]}` | 401, 404 |
| `GET` | `/api/runs/:id/events` | tak | `?from=<seq>` | SSE | 401, 404 |
| `POST` | `/api/runs/:id/cancel` | tak | — | `{ok:true}` | 401, 409 (run nieaktywny) |
| — | inne | — | — | `{error}` | 404 |

**Autoryzacja:** `Authorization: Bearer <token>` **albo** `?token=<token>` (drugi wariant istnieje, bo `EventSource` nie umie ustawiać nagłówków). Token generowany przy pierwszym starcie, trzymany w `config.json`.

**Kształt runu w odpowiedziach** (`publicRun()`): `id, projectId, agent, prompt, state, branch, baseCommit, createdAt, startedAt, endedAt, exitCode, failureReason, costUsd, tokensIn, tokensOut, commitsAhead, filesChanged, insertions, deletions, pushed (bool), memoryLimitMb, timeoutSec, jobKind, durationMs`.

### 7.2 Kontrakt SSE

```text
event: hello
data: {"runId":"run_…","from":0}

data: {"seq":1,"ts":"…","kind":"lifecycle","stream":null,"text":"run zakolejkowany …"}

data: {"seq":2,…}

: keepalive            ← co 20 s, podtrzymuje połączenie
```

Zasady:

- najpierw replay zdarzeń `seq > from` z bazy (klient po reconnectcie nie traci kontekstu),
- potem zdarzenia na żywo z `Runner.subscribe(runId, …)`,
- `keepalive` co 20 s, `idleTimeout = 120 s`,
- rozłączenie klienta → `cancel()` strumienia → odpięcie subskrypcji (brak wycieków),
- martwy subskrybent nie psuje runu (wyjątki w listenerach są łapane).

### 7.3 CLI

| Polecenie | Opis | Uwagi |
|---|---|---|
| `agentdock [serve] [--port N] [--no-open]` | start serwera + UI | domyślne zachowanie; `serve` jawnie |
| `agentdock demo` | repo demo + pełny run agenta demo | działa bez kluczy, wypisuje gałęzie w `origin` |
| `agentdock run -p "<zadanie>" [--project <id\|ścieżka>] [--agent <nazwa>] [--memory MB] [--timeout S] [--no-follow]` | dispatch + podgląd zdarzeń | `--project` przyjmuje też ścieżkę (zostanie zarejestrowana) |
| `agentdock projects [add <ścieżka\|url> \| rm <id>]` | lista / rejestracja / usunięcie | bez podpolecenia = lista |
| `agentdock runs [--limit N]` | historia runów | format tabelaryczny |
| `agentdock show <run-id>` | szczegóły (gałąź, pliki, błąd, prompt) | czyta z bazy |
| `agentdock tail <run-id>` | śledzenie zdarzeń | dopóki stan terminalny |
| `agentdock cancel <run-id>` | anulowanie | wymaga żywego gospodarza (HTTP) |
| `agentdock doctor` | diagnostyka | git, Job Objects, config, dane, agenci, serwer |
| `agentdock --version` / `help` | — | — |
| `agentdock --demo-agent` | tryb wewnętrzny (agent demo) | wywoływany przez preset `demo` |

**Tryby hosta runów:** jeśli serwer odpowiada na `/healthz` → dispatch przez HTTP (run żyje w serwerze, CLI może się zamknąć); w przeciwnym razie run obsługuje proces CLI (z ostrzeżeniem wypisanym użytkownikowi).

### 7.4 UI

Jeden dokument HTML (inline CSS + vanilla JS, ~9,9 kB skryptu). Widoki:

- **Nagłówek:** nazwa, wersja, chip limitów (`limit: 2048 MB · 1800s · równolegle 2 · Job Object ✓`), licznik aktywnych runów.
- **Panel tokenu:** jeśli brak/nieprawidłowy, pokazuje baner z polem do wklejenia tokenu (przy wejściu `?token=…` token trafia do `localStorage` i znika z URL).
- **Projekty:** lista z przyciskiem usuń; formularz „ścieżka lub URL” (rozpoznaje URL po schemacie).
- **Agenci:** nazwa, znacznik `wbudowany` / `gotowy` / `brak w PATH`, opis.
- **Nowy run:** projekt, agent, limit pamięci, limit czasu, prompt, przycisk „Uruchom”, „Wstaw zadanie demo”.
- **Runy:** tabela (stan, agent, id, czas, commity, push, koszt) odświeżana co 3 s.
- **Szczegóły runu:** metryki (stan, agent, gałąź, commity, pliki, push, koszt/tokeny, limity, izolacja, błąd), prompt, **Anuluj**, log na żywo (SSE, auto-scroll).

Świadome decyzje: brak frameworka i kroku budowania (zmiana UI = zmiana jednego pliku), brak optymistycznych aktualizacji (stan zawsze z serwera), escape HTML w każdym miejscu renderowania danych z runu.

### 7.5 Launcher i „uczucie aplikacji”

`agentdock.cmd` (styl etykiet + `goto`, **bez** zagnieżdżonych bloków `if (...)`):

| Polecenie | Efekt |
|---|---|
| `start` | wywołuje `tools/agentdock-start.ps1`: sprawdza, czy nie działa; startuje `bun <src>/main.ts serve` ukryty (`-WindowStyle Hidden`) z logami do `server.log`/`server.err.log`; czeka na `/healthz` (30 s) |
| `stop` | `taskkill /PID <pid z pidfile> /T /F` |
| `status` | `doctor` + lista projektów + ostatnie runy |
| `demo` | pełny run demo w konsoli |
| `ui` | otwiera UI z tokenem z `config.json` |
| `logs` | `Get-Content -Wait` na logu serwera |
| `test` / `build` / `shortcut` | `bun test` / `bun run build` (exe) / skrót na pulpicie (`AgentDock.lnk`) |
| `cli <polecenia>` | dowolne polecenie CLI |

Dwa twarde wymagania Windows, które ukształtowały te pliki (§12.3 poz. 8-10):

1. **PowerShell 5.1 czyta `.ps1` jako ANSI** → plik musi być ASCII-only (polskie znaki w UTF-8 bez BOM łamią parser).
2. **`Start-Process -ArgumentList` nie cytuje automatycznie** → ścieżka ze spacjami została ucięta (`C:\Users\Piotr\Desktop\Ouroboros`); poprawka: cytowanie wewnątrz `ArgumentList`. Dodatkowo `cmd` źle parsuje `(` `)` w `echo` wewnątrz bloku `if (...)` — stąd styl etykiet.

Tryb „aplikacja”: proces działa ukryty w tle, użytkownik dostaje kartę przeglądarki z UI, może zamknąć terminal. Wariant z prawdziwym oknem (WebView2) i ikoną w zasobniku jest w §15.A.

---

## 8. Konfiguracja, dane na dysku, instalacja

### 8.1 `config.json`

Ścieżka: `%USERPROFILE%\.agentdock\config.json` (nadpisywalna przez `AGENTDOCK_HOME`). Pełny przykład w §18.B.

| Pole | Domyślnie | Znaczenie |
|---|---|---|
| `port` | `8787` | port lokalnego HTTP API/UI |
| `token` | losowy base64url (24 B) | token operatora |
| `maxConcurrent` | `2` | ile runów działa jednocześnie (reszta w kolejce) |
| `memoryLimitMb` | `2048` | domyślny limit pamięci procesu runu |
| `timeoutSec` | `1800` | domyślny limit czasu runu |
| `branchPrefix` | `agentdock/run-` | prefiks gałęzi runów |
| `agents` | 4 presety | definicje agentów (§6.1) |

Reguły wczytywania (`loadConfig()`): brak pliku → tworzy z domyślnymi; istniejący plik → dopisuje nowe wbudowane agenty i brakujące pola, zapisując wynik (idempotentne, „drift-aware”); `AGENTDOCK_PORT` w środowisku ma priorytet nad plikiem; uszkodzony JSON → twardy błąd z nazwą pliku.

### 8.2 Katalogi i pliki danych

| Ścieżka | Zawartość | Cykl życia |
|---|---|---|
| `~/.agentdock/config.json` | konfiguracja + token | trwały |
| `~/.agentdock/agentdock.db` (+ `-wal`, `-shm`) | projekty, runy, zdarzenia | trwały, rośnie (brak retencji — §14.5) |
| `~/.agentdock/server.log`, `server.err.log` | log procesu serwera | nadpisywany przy starcie (log startu) |
| `~/.agentdock/agentdock.pid` | PID serwera (dla `stop`) | tworzony przy starcie, kasowany przy zatrzymaniu |
| `~/.agentdock/worktrees/<run-id>` | katalog roboczy runu | kasowany w finalizacji |
| `~/.agentdock/runs/<run-id>/{prompt.md,gitconfig,transcript.log}` | materiał runu + pełny transkrypt | trwały |
| `~/.agentdock/repos/<nazwa>` | klony projektów dodanych przez URL | trwały |
| `~/.agentdock/demo/{repo,origin.git}` | repo demo + jego lokalny origin | trwały |

### 8.3 Zmienne środowiskowe aplikacji

| Zmienna | Efekt |
|---|---|
| `AGENTDOCK_HOME` | inny katalog danych (przydatne w testach/na przenośnym dysku) |
| `AGENTDOCK_PORT` | nadpisanie portu z `config.json` |
| `AGENTDOCK_SELF_ENTRY` | wskazanie pliku wejściowego, gdy nie da się go wywnioskować z `argv[1]`/`Bun.main` (używane w testach) |

### 8.4 Instalacja i usunięcie

Instalacja (stan bieżący):

1. `powershell -c "irm bun.sh/install.ps1 | iex"` → `C:\Users\Piotr\.bun\bin\bun.exe`,
2. `agentdock.cmd cli doctor` (sanity), `agentdock.cmd start`, `agentdock.cmd demo`.

Usunięcie: `agentdock.cmd stop`, potem skasowanie `agentdock/` (kod) i `%USERPROFILE%\.agentdock` (dane). Aplikacja nie pisze nigdzie indziej.

---

## 9. Bezpieczeństwo i izolacja — analiza

### 9.1 Co jest faktycznie egzekwowane

| Mechanizm | Egzekwuje | Siła |
|---|---|---|
| limit pamięci na proces (`0x100`, offset 112) | jądro Windows | **twarda** — naruszenie kończy proces (potwierdzone: `RangeError: Out of memory`, run `failed`) |
| limit aktywnych procesów (`0x8`, `ActiveProcessLimit=64`) | jądro | twarda — kolejne `CreateProcess` w jobie są odrzucane |
| `KILL_ON_JOB_CLOSE` | jądro | twarda — brak sierot po zamknięciu joba |
| `TerminateJobObject` przy cancel/timeout | jądro | twarda — drzewo umiera natychmiast |
| allowlist środowiska | aplikacja (przed spawnem) | miękka, ale deterministyczna — brak dziedziczenia sekretów |
| per-run `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_NOSYSTEM` | git | brak użycia Twoich credential helperów przez agenta |
| separate worktree + gałąź | git | brak kolizji z Twoim checkoutem i między runami |
| loopback + token | aplikacja | brak dostępu z sieci i z innych maszyn |
| limit zdarzeń / długości linii | aplikacja | ochrona przed zapchaniem bazy przez gadatliwego agenta |

### 9.2 Czego nie ma (i dlaczego)

| Brak | Przyczyna | Skutek / obejście |
|---|---|---|
| **Jail systemu plików** | Windows nie ma odpowiednika `bwrap`/`unshare` dla zwykłego procesu użytkownika; dostępne ścieżki to AppContainer / Windows Sandbox / kontener | agent widzi cały dysk (w tym Twoje pliki w zasięgu uprawnień użytkownika). Obejście teraz: uruchamiaj agentów, którym ufasz; alternatywa: Warren w Dockerze/K8s (granica kontenera) |
| **Odcięcie sieci** | brak mechanizmu per-proces bez WFP/filtra jądra lub kontenera | agent może łączyć się z siecią. Obejście częściowe: proxy przez zmienne środowiskowe/`*_BASE_URL`, jeśli agent to respektuje |
| **Kwantum CPU** | Job Object ma limit *czasu* CPU, nie „% rdzenia” jak cgroups | brak ochrony przed zajęciem wszystkich rdzeni; `[NUMBER_OF_PROCESSORS]` jest tylko informacją |
| **Limity dysku/IO** | brak odpowiednika `io.max`; Job Object daje statystyki I/O, nie limity | agent może zapełnić dysk |
| **Uruchomienie jako inny użytkownik** | wymaga konfiguracji systemu (AppContainer/konto) | runy dziedziczą Twoje uprawnienia |
| **RBAC / wielu użytkowników** | świadomie poza zakresem (jak w Warrenie: jeden zaufany operator) | jeden token, jedna instancja |

### 9.3 Powierzchnia ataku i higiena

- **Sieć:** wyłącznie `127.0.0.1` (brak ekspozycji na LAN/WAN). Token w `config.json` (plik w profilu użytkownika), dostęp do API wymaga nagłówka lub parametru.
- **Token w URL:** przy `?token=…` token może trafić do historii przeglądarki — UI natychmiast usuwa go z URL (`history.replaceState`) i przenosi do `localStorage`.
- **SQLite:** plik w profilu użytkownika; treść promptów i logów runów jest jawna na dysku (to dane operatora, nie sekrety — ale warto o tym pamiętać przy udostępnianiu maszyny).
- **Zdarzenia agenta** są renderowane w UI z escapowaniem HTML — brak wstrzyknięcia przez log.
- **`git push`** wykonywany przez aplikację, nie przez agenta (agent nie dostaje poświadczeń).
- **Ścieżki:** `addProject` przyjmuje ścieżkę absolutną albo URL i klonuje do `repos/<nazwa>`; brak normalizacji do bazowego katalogu danych dla *lokalnych* ścieżek (świadome: użytkownik może wskazać dowolne repo na dysku).

### 9.4 Porównanie granic (Windows vs Linux/Warren)

| Warstwa | AgentDock (Windows) | Warren `local` (Linux) | Warren `docker`/`k8s` |
|---|---|---|---|
| katalog roboczy | osobny worktree | osobny worktree | worktree w kontenerze/podzie |
| widoczność plików | cały dysk | tylko zbindowane ścieżki | tylko to, co w obrazie/wolumenach |
| tożsamość UID | brak zmiany (Twój użytkownik) | `uid 1000` | uid w kontenerze |
| limity pamięci | Job Object | cgroup v2 | limit kontenera/poda |
| sieć | pełna | `--share-net` + profil sieciowy | network policy / brak |
| gwarancja braku sierot | `KILL_ON_JOB_CLOSE` | `--die-with-parent` | cykl życia kontenera |

Wniosek do dyskusji: AgentDock daje **izolację procesu i kosztów**, ale nie **izolację danych i sieci**. To jest granica, którą trzeba świadomie zaakceptować albo domknąć (§15.B, §15.C).

### 9.5 Scenariusze awaryjne — co się dzieje

| Scenariusz | Zachowanie aplikacji |
|---|---|
| Agent alokuje 4× więcej pamięci niż limit | jądro ubija proces; zdarzenia do ostatniej linii; run `failed` („agent zakończył się kodem 1”); ewentualny salvage commit; gałąź pushowana |
| Agent wisi w nieskończoność | timeout (`timeout_sec`) → `TerminateJobObject`; salvage; `failed` z powodem „przekroczony limit czasu” |
| Agent odpala 500 procesów | po 64 procesach w jobie kolejne `CreateProcess` są odrzucane (błąd po stronie agenta) |
| Agent robi `git reset --hard` / kasuje pliki | dotyczy **tylko** worktree runu; Twój checkout nietknięty |
| Agent wypisuje 10 GB logów | po 20 000 zdarzeń zapis wstrzymany; transkrypt ograniczony; linie > 20 000 znaków ucinane |
| Wyłączasz aplikację w trakcie runu | procesy ubite (`taskkill /T /F`), po restarcie runy oznaczone jako `failed` z powodem „przerwany przez restart aplikacji”; worktree zostaje do obejrzenia |
| Brak `git` w PATH | `doctor` pokazuje BŁĄD; dispatch kończy się `failed` na etapie przygotowania |
| Brak remote `origin` w projekcie | run kończy się sukcesem, push pomijany z notką „brak remote 'origin' — gałąź została tylko lokalnie” |
| Push odrzucony (np. brak uprawnień) | run kończy się stanem wynikającym z agenta, w zdarzeniach komunikat od gita; **`pushed=0` nie odróżnia tego od „nie było czego pushować”** (§14.1) |
| Dwa runy naraz na tym samym repo | osobne worktree i gałęzie, brak konfliktu (chyba że oba celują w ten sam plik — wtedy różne gałęzie, świadoma decyzja operatora przy scalaniu) |

---

## 10. Wydajność i koszty — pomiary

Wszystko zmierzone na tej maszynie (16 rdzeni logicznych, 31,3 GB RAM, Windows 11 build 26200, Bun 1.4.2, git 2.54).

| Operacja | Czas / rozmiar |
|---|---|
| `bun install` (devDependencies, `@types/bun`) | ~1,2 s |
| `bun test` (13 testów, w tym E2E z runem) | 2,2 s |
| `bun run build` (`--compile`) | ~0,2 s (bundle 12 modułów) + kompilacja |
| Rozmiar `agentdock.exe` | 86 169 088 B (~82 MiB) |
| Start serwera do `/healthz` | < 2 s (healthz gotowy po ~1 s) |
| Run agenta demo (bez `[sleep_ms]`) | 1 s end-to-end (worktree + spawn + commit + push + sprzątanie) |
| Narzut `git worktree add` + `remove` | wliczony w powyższe 1 s |
| Rozmiar bazy po 14 runach | 64 KB + 32 KB WAL (450 zdarzeń) |
| Koszt w runach demo (symulowany przez agenta) | $0,00042/run (stała agenta demo) |
| Suma kosztów w bazie po sesji testowej | $0,00462 |

Wnioski praktyczne:

- narzut aplikacji jest nieistotny wobec czasu pracy prawdziwego agenta (sekundy vs minuty),
- koszt dominujący to tokeny modelu — stąd parser kosztu i kolumny `cost_usd`/`tokens_*`,
- przy prawdziwym agencie wąskim gardłem będzie I/O `npm install`/buildów w worktree (kolejny argument za cache'em zależności — §15.G2).

---

## 11. Weryfikacja: testy i dowody działania

### 11.1 Testy automatyczne (`bun test` — 13/13 pass, 2,2 s)

| # | Test | Co sprawdza |
|---:|---|---|
| 1 | `extractUsage > czyta koszt i tokeny z koperty result` | parser koperty `claude-code` |
| 2 | `extractUsage > sumuje kolejne koperty i ignoruje śmieci` | akumulacja + odporność na nie-JSON |
| 3 | `Job Object > flagi limitów są ustawione…` | bity flag i offsety (16 / 40 / 112) |
| 4 | `Job Object > na Windows job jest tworzony i przyjmuje limit` | realne `SetInformationJobObject` |
| 5 | `projekty > odrzuca katalog, który nie jest repozytorium git` | walidacja rejestracji |
| 6 | `projekty > config doładowuje nowe agenty wbudowane…` | idempotentny merge configu |
| 7 | E2E: `run kończy się sukcesem` | pełny cykl |
| 8 | E2E: `agent pracował w worktree na własnej gałęzi, worktree posprzątany` | izolacja + sprzątanie |
| 9 | E2E: `są commity i statystyki diffa` | salvage/commit + `--shortstat` |
| 10 | E2E: `koszt i tokeny pochodzą z logu agenta` | integracja parsera z runem |
| 11 | E2E: `gałąź runu jest wypchnięta na origin` | `git branch` + `git log` w bare repo |
| 12 | E2E: `zdarzenia runu są zapisane i mają rosnącą sekwencję` | model zdarzeń |
| 13 | E2E: `limit pamięci jest zapisany w wierszu runu (Job Object)` | `job_kind = win32-job` |

Test E2E tworzy tymczasowe repo + bare `origin.git`, rejestruje projekt, dispatchuje run agenta `demo`, czeka na stan terminalny (budżet 90 s) i asertuje skutki. `AGENTDOCK_SELF_ENTRY` wskazuje `src/main.ts`, żeby wbudowany agent dał się uruchomić pod `bun test`.

### 11.2 Testy manualne (wykonane, z wynikiem)

| # | Co testowano | Komenda / metoda | Wynik |
|---:|---|---|---|
| M1 | pełny cykl runu przez CLI | `bun run src/main.ts demo` | `succeeded`, 1 commit, pliki 2 (+12/-4), koszt $0,0004, gałąź w `origin` |
| M2 | limit pamięci | `run -p "… [mem_mb=800]" --memory 256` | proces ubity przez OS (`RangeError: Out of memory`), run `failed` |
| M3 | timeout | `run -p "… [sleep_ms=60000]" --timeout 5` | ubity po 5 s, salvage commit wypchnięty, `failed` z powodem |
| M4 | anulowanie | dispatch `[sleep_ms=90000]` + `cancel <id>` | stan `cancelled`, drzewo procesów ubite, **bez pusha** |
| M5 | kolejka | 3 dispatch przy `maxConcurrent=2` | 2× `running` + 1× `queued`, potem domknięcie wszystkich |
| M6 | restart aplikacji | `stop` + `start` | historia i konfiguracja zachowane (SQLite), runy w locie oznaczone jako przerwane |
| M7 | UI z Windows | `GET /` z hosta, `GET /healthz` | HTTP 200, `{"ok":true,…,"jobObjects":true}` |
| M8 | składnia JS UI | ekstrakcja `<script>` + `new Function()` | „skladnia OK”, brak błędów escapowania |
| M9 | SSE | `curl -N "…/events?from=0&token=…"` | `event: hello`, potem zdarzenia; `keepalive` po stronie serwera |
| M10 | autoryzacja | `GET /api/state` bez tokenu | HTTP 401 |
| M11 | wersja jednoplikowa | `agentdock.exe run -p "… [commit]"` | pełny cykl `succeeded`, gałąź wypchnięta |
| M12 | diagnostyka | `doctor` | git OK, Job Objects OK, agent demo OK, serwer OK |

### 11.3 Ślady (fragmenty rzeczywistych logów)

Limit pamięci — egzekwowany przez OS (nie przez aplikację):

```text
! RangeError: Out of memory
!       at runDemoAgent (…\src\demo-agent.ts:105:16)
· finalizacja: commit szczątków, statystyki, push
· run zakończony: failed (agent zakończył się kodem 1) | commity: 0, pliki: 0 (+0/-0) | koszt: n/d
```

Timeout z ratowaniem pracy:

```text
· przekroczony limit czasu (5s) — ubijam run
· zacommitowano niezacommitowane zmiany agenta (f53f016c0f)
· gałąź agentdock/run-muearuc9nsmiza wypchnięta na origin
· run zakończony: failed (przekroczony limit czasu (5s)) | commity: 1, pliki: 1 (+8/-0)
```

Sukces z pełnymi statystykami:

```text
· run wystartował (pid 146548, limity: win32-job, 2048 MB)
· gałąź agentdock/run-mueareyv671brm wypchnięta na origin
· worktree posprzątany (gałąź zostaje w repo)
· run zakończony: succeeded | commity: 1, pliki: 2 (+12/-4) | koszt: $0.0004 | push: wypchnięto na origin
```

Stan bazy po sesji (odczyt z `agentdock.db`):

```json
stany runów: [{"state":"succeeded","n":11},{"state":"failed","n":2},{"state":"cancelled","n":1}]
zdarzeń: 450
projektów: 1
```

Dla kontrastu — sandbox Warrena w WSL2 (faza 1), czyli to, czego AgentDock nie ma:

```text
/usr/bin/bwrap --unshare-all --share-net --die-with-parent --uid 1000 --gid 1000
  --ro-bind-try /usr /usr … --bind <repo>/.git <repo>/.git
  --bind …/homes/local-run_<id> /home/sandbox
  --bind …/workspaces/local-run_<id> /workspace --chdir /workspace -- claude …
```

---

## 12. Rejestr zmian (inwentarz plików i błędów)

### 12.1 Faza 1 — kopia robocza Warrena (WSL2)

| Plik | Typ zmiany | KB | Opis |
|---|---|---:|---|
| `warren-main/warren-windows/install-wsl.sh` | nowy | 3,2 | instalacja: pakiety, Bun, kopia źródeł, `bun install`, build UI, demo; `--with-harnesses` |
| `warren-main/warren-windows/make-demo-env.sh` | nowy | 3,7 | bare origin + repo demo + `insteadOf` + shim `claude` + `seed-agents.json` |
| `warren-main/warren-windows/start.sh` | nowy | 3,3 | start w tle, pidfile, healthz, URL+token+link `/setup`, tryb `--demo` |
| `warren-main/warren-windows/stop.sh` | nowy | 0,7 | SIGTERM + fallback `pkill` + czekanie na port |
| `warren-main/warren-windows/status.sh` | nowy | 1,6 | proces, sondy, agenty, projekty, runy, log |
| `warren-main/warren-windows/demo-run.sh` | nowy | 2,6 | rejestracja projektu + dispatch stub-agenta + weryfikacja gałęzi |
| `warren-main/warren-windows/warren.cmd` | nowy | 2,2 | jeden punkt wejścia + normalizacja CRLF |
| `warren-main/warren-windows/README.md` | nowy | 8,6 | dokumentacja fazy 1 (PL) |

Zmiany poza tym katalogiem: **brak** — kod Warrena nie był modyfikowany (potwierdzenie: kopia źródeł w `~/warren` powstała przez `tar` z `/mnt/c`, bez edycji plików projektu).

### 12.2 Faza 2 — AgentDock

| Plik | Typ | Linie | Rola |
|---|---|---:|---|
| `agentdock/package.json` | nowy | 20 | skrypty `start/dev/test/typecheck/build`, bin, devDependency `@types/bun` |
| `agentdock/tsconfig.json` | nowy | 19 | strict, `noEmit`, typy Bun |
| `agentdock/src/main.ts` | nowy | 528 | wejście, CLI, serwer, demo, hosty runów, doctor |
| `agentdock/src/runner.ts` | nowy | 605 | cykl życia runu |
| `agentdock/src/server.ts` | nowy | 287 | API + SSE + UI |
| `agentdock/src/ui.ts` | nowy | 403 | frontend w jednym pliku |
| `agentdock/src/db.ts` | nowy | 296 | SQLite + repozytoria |
| `agentdock/src/git.ts` | nowy | 200 | operacje git |
| `agentdock/src/job.ts` | nowy | 155 | Job Object przez FFI |
| `agentdock/src/agents.ts` | nowy | 103 | argv + env agenta |
| `agentdock/src/config.ts` | nowy | 163 | konfiguracja, presety, allowlist |
| `agentdock/src/demo-agent.ts` | nowy | 169 | wbudowany agent demo |
| `agentdock/src/projects.ts` | nowy | 66 | rejestracja projektów |
| `agentdock/src/paths.ts` | nowy | 43 | struktura katalogu danych |
| `agentdock/tests/agentdock.test.ts` | nowy | 200 | 13 testów |
| `agentdock/tools/agentdock-start.ps1` | nowy | 68 | start w tle (ASCII-only) |
| `agentdock/agentdock.cmd` | nowy | 113 | launcher (label+goto) |
| `agentdock/README.md` | nowy | 218 | dokumentacja użytkownika (PL) |
| `agentdock/agentdock.exe` | nowy | — | wersja jednoplikowa (86 MB, artefakt buildu) |
| `agentdock/bun.lock`, `node_modules/` | nowe | — | artefakty instalacji dev |

### 12.3 Rejestr napotkanych problemów i poprawek (materiał do dyskusji)

| # | Objaw | Przyczyna | Poprawka | Gdzie |
|---:|---|---|---|---|
| 1 | `unsupported platform win32` przy próbie runu | Warren nie obsługuje Windows (kontrakt kodu) | decyzja: faza 1 przez WSL2, faza 2 osobna implementacja | `src/sandbox/sandbox.ts:44` |
| 2 | `unzip is required to install bun` | brak `unzip` w świeżym WSL | `apt-get install unzip` w skrypcie instalacyjnym | `install-wsl.sh` |
| 3 | `bash: C:/Program Files/Git/mnt/c/...` | MSYS/Git Bash konwertuje ścieżki `/mnt/c/...` na Windows | `MSYS_NO_PATHCONV=1` przy wywołaniach `wsl` | komendy robocze |
| 4 | `$'\r': command not found` w skryptach `.sh` | pliki zapisane w Windows z CRLF | `sed -i 's/\r$//'` + automatyczna normalizacja w `warren.cmd` przed uruchomieniem | `warren.cmd` |
| 5 | `Executable not found in $PATH: "bun"` w teście FFI | `bun` nie jest w PATH (świeży Windows) | użycie `process.execPath` jako komendy potomnej | smoke test FFI |
| 6 | agent demo nie startował z worktree | `argv[1]` był ścieżką **relatywną**, a dziecko startuje z `cwd = worktree` | `resolve()` do ścieżki absolutnej + `AGENTDOCK_SELF_ENTRY` dla testów | `src/agents.ts:57-70` |
| 7 | `EBUSY: resource busy or locked` przy sprzątaniu testu | Windows trzyma uchwyt katalogu chwilę po zamknięciu SQLite | tolerancyjne `rmSync(..., {maxRetries, retryDelay})` w `afterAll` | `tests/agentdock.test.ts` |
| 8 | `Unexpected token ')'` w PowerShellu | PS 5.1 czyta `.ps1` jako ANSI → polskie znaki UTF-8 bez BOM łamią parser | plik `.ps1` wyłącznie ASCII + komentarz wyjaśniający | `tools/agentdock-start.ps1` |
| 9 | `error: Module not found "C:\Users\Piotr\Desktop\Ouroboros"` | `Start-Process -ArgumentList` nie cytuje elementów → ścieżka ze spacjami pęka | jawne cytowanie w `ArgumentList` (`@("`"$Entry`"", 'serve')`) | `tools/agentdock-start.ps1` |
| 10 | `. was unexpected at this time.` (launcher nie działał wcale) | nawiasy w `echo … (pid %%p).` wewnątrz bloku `if (...)` psują parser `cmd` | przepisanie `.cmd` na etykiety i `goto` (zero zagnieżdżonych bloków); znalezione bisekcją `head -n N` | `agentdock.cmd` |
| 11 | 3 runy startowały przy `maxConcurrent = 2` | licznik `active` rośnie dopiero po asynchronicznym przygotowaniu worktree | zbiór `starting` + warunek `active+starting < max`; potem dodatkowo usuwanie z `starting` przy przejściu do `active` (dubel liczenia) | `src/runner.ts:255-285` |
| 12 | `--no-follow` i tak czekał na koniec runu | `followRun()` zawsze pętlił do stanu terminalnego | przy `--no-follow` zwracany jest bieżący wiersz z bazy | `src/main.ts` |
| 13 | `doctor` zwracał błąd, gdy nie ma `claude`/`codex`/`aider` | brak rozróżnienia „wymagane” i „opcjonalne” | parametr `fatal` w raporcie; brak opcjonalnego agenta ≠ problem | `src/main.ts` |

---

## 13. Decyzje projektowe (ADR)

Format: kontekst → opcje → wybór → uzasadnienie → koszt → kiedy wrócić do decyzji.

**ADR-1: natywna aplikacja Windows, bez WSL i Dockera**
Kontekst: użytkownik chce „aplikacji lokalnej na Windows”; Warren wymaga WSL/Dockera.
Opcje: (a) WSL2 + Warren, (b) Docker Desktop + Warren compose, (c) nowa implementacja natywna.
Wybór: **(c)**, przy zachowaniu (a) jako referencji.
Uzasadnienie: brak zależności od wirtualizacji/kontenerów, brak narzutu, „podwójne kliknięcie”, pełna kontrola nad limitami przez Job Object.
Koszt: trzeba zaimplementować własny runtime; brak jaila plików i sieci.
Wrócić gdy: wymagana będzie izolacja danych (→ kontener/AppContainer).

**ADR-2: Bun zamiast Node/Electron**
Opcje: Node + npm deps, Electron/Tauri (okno desktopowe), Bun.
Wybór: **Bun**, zero zależności runtime.
Uzasadnienie: `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `bun:ffi` i `--compile` w jednym binarnym pliku; brak `node_modules` w dystrybucji.
Koszt: Bun na Windows jest młodszy niż Node; ekosystem mniejszy; `bun:ffi` wymaga ostrożności ze strukturami.
Wrócić gdy: potrzebne biblioteki niedostępne dla Buna (np. WebView2 bindings) → wtedy most przez proces.

**ADR-3: Job Object zamiast „brak limitów” lub kontenera per run**
Opcje: (a) bez limitów, (b) kontener per run (`docker run`), (c) Job Object przez FFI.
Wybór: **(c)** z degradacją do (a), gdy FFI niedostępne.
Uzasadnienie: realne egzekwowanie przez jądro bez Dockera; koszt ~150 linii; brak wymogu uprawnień administratora.
Koszt: brak jaila plików/sieci; okno czasowe przed `AssignProcessToJobObject`.
Wrócić gdy: potrzebna izolacja danych/sieci (§15.B, §15.C).

**ADR-4: `git worktree` per run zamiast klonu per run**
Opcje: (a) klon per run (jak Warren), (b) worktree w istniejącym repo, (c) brak izolacji.
Wybór: **(b)**.
Uzasadnienie: szybkie (bez kopiowania historii), czyste, pozwala na równoległość; gałąź zostaje jako ślad.
Koszt: dzieli `objects`/`refs` z repo użytkownika (run widzi gałęzie; ryzyko „przypadkowego” dotknięcia gałęzi użytkownika przez agenta jest teoretyczne, bo pracuje na swojej), wymaga sprawnego `worktree` (Windows: długie ścieżki, antywirus).
Wrócić gdy: potrzebna izolacja także na poziomie obiektów gita (→ klon/`--separate-git-dir`).

**ADR-5: allowlist środowiska zamiast dziedziczenia**
Opcje: (a) pełne dziedziczenie, (b) allowlist bazowa + jawne rozszerzenia per agent.
Wybór: **(b)**.
Uzasadnienie: agent nie dostaje przypadkiem kluczy innych dostawców ani tokenów; determinizm (te same zmienne = te same zachowania).
Koszt: nowy agent może wymagać dopisania zmiennej (dlatego jest to w `config.json`, nie w kodzie).
Wrócić gdy: pojawi się potrzeba zarządzania sekretami (keyring/DPAPI) — §15.G3.

**ADR-6: UI jako jeden plik serwowany przez `Bun.serve`**
Opcje: (a) SPA z Vite (jak Warren), (b) HTML+vanilla inline, (c) WebView2/Electron.
Wybór: **(b)** teraz, (c) jako następny krok (§15.A).
Uzasadnienie: zero buildu, zero `node_modules`, szybka iteracja, łatwe debugowanie (jedna strona).
Koszt: brak komponentów/stanu globalnego; przy rozroście trzeba będzie przejść na coś większego albo na WebView2 z tym samym API.

**ADR-7: SQLite (WAL) zamiast plików JSON/Postgresa**
Uzasadnienie: transakcyjność, zapytania po stanie, zdarzenia z sekwencją, brak serwera.
Koszt: brak wersjonowania schematu (dziś) — §14.4.

**ADR-8: SSE zamiast WebSocketów**
Uzasadnienie: jednokierunkowy strumień (serwer → klient), prostszy kontrakt, automatyczny reconnect w `EventSource`, replay po `from=seq`.
Koszt: `EventSource` nie ustawia nagłówków → token w query (i wynikające uwagi bezpieczeństwa, §9.3).

**ADR-9: push po sukcesie i po porażce, nigdy po anulowaniu**
Uzasadnienie: gwarantowany efekt bez wysyłania połowicznej pracy; dla porażki/timeoutu push ratuje pracę, dla anulowania użytkownik świadomie przerywa.
Koszt: „porażka” i „użyteczna praca” mogą współwystępować — operator musi patrzeć na `commits_ahead`, nie tylko na stan.

**ADR-10: agent demo wbudowany w binarkę (`--demo-agent`)**
Opcje: (a) osobny plik skryptu agenta, (b) tryb wewnętrzny tego samego binarium.
Wybór: **(b)**.
Uzasadnienie: wersja jednoplikowa `agentdock.exe` nie ma „obok siebie” plików źródeł, a demo/testy muszą działać także po kompilacji.
Koszt: `main.ts` ma dwa tryby (serwer i agent) — drobna niedogodność; rozwiązanie przez jawne `process.argv.includes("--demo-agent")` na starcie.

**ADR-11: loopback + pojedynczy token zamiast sesji/RBAC**
Uzasadnienie: jedna instancja, jeden operator (jak w Warrenie: brak użytkowników i RBAC jest świadomym ograniczeniem).
Koszt: brak rozdzielenia uprawnień; każdy, kto ma token, może zlecać runy.

**ADR-12: `.cmd` + `.ps1` zamiast instalatora MSI**
Uzasadnienie: „działa od razu”, bez uprawnień administratora, czytelne dla użytkownika; skrót na pulpicie jednym poleceniem.
Koszt: brak auto-aktualizacji, brak wpisu w „Programy i funkcje”, brak podpisu kodu (SmartScreen) — §15.I.

---

## 14. Znane luki, błędy i ryzyka

### 14.1 Luki funkcjonalne (potwierdzone w kodzie)

| # | Luka | Skutek | Proponowane rozwiązanie |
|---:|---|---|---|
| 1 | ~~`pushed` (0/1) nie odróżnia „nie było czego pushować” od „push się nie udał”; parametr `push` w `POST /api/runs` był ignorowany przez runner~~ | — | **ZROBIONE 2026-09-24** (Ouroboros Faza 1, migracja v3): kolumny `push_enabled`, `delivery_state`, `push_error`, `keys_used`; `push=false` ⇒ `skipped_disabled`; CLI `run --no-push` |
| 2 | Brak retencji: `events`, `runs/<id>/transcript.log` i gałęzie runów rosną bez końca | baza i dysk rosną monotonicznie | polityka retencji (np. `delete from events where run_id in (… starsze niż N dni)`) + `vacuum` + opcjonalne kasowanie gałęzi `agentdock/run-*` |
| 3 | Anulowanie działa tylko, gdy run obsługuje ten sam proces (HTTP) | CLI-hostowany run nie da się anulować po zamknięciu CLI | „reaper”: nowy proces odczytujący PID/stan z bazy i ubijający procesy (albo `job_kill` po identyfikatorze joba) |
| 4 | ~~Brak wersjonowania/migracji schematu SQLite~~ | — | **ZROBIONE 2026-09-24** (Ouroboros Faza 0): `pragma user_version` + `MIGRATIONS[]` w `AgentDockDb.migrate()` (transakcja, idempotentny krok 1, tolerancja `duplicate column name`); realna baza z 14 runami zmigrowała się bez utraty danych |
| 5 | Brak testu limitu pamięci w zestawie automatycznym (jest tylko manualny M2) | regresja w FFI/limitach może przejść niezauważona | test: run z `[mem_mb=…]` i małym limitem → asercja `failed` + komunikat OOM |
| 6 | Brak UI do edycji agentów/configu (trzeba edytować JSON i restartować) | wyższy próg wejścia dla „gotowej aplikacji” | endpoint `PATCH /api/agents/:name` + formularz w UI (§15.E3) |
| 7 | Brak `steering` (wysyłania wiadomości do żywego agenta) | brak funkcji, którą Warren ma (`sendMessage`) | kanał stdin dla agentów czytających z `stdin` albo plik „inbox”, który agent odczytuje (§15.F2) |
| 8 | Brak metryk (`/metrics`) i analityki (koszt w czasie, statystyki per agent) | brak podstaw observowalności dla dłuższej eksploatacji | agregacje SQL + widok UI (§15.G1) |
| 9 | Brak obsługi długich ścieżek Windows (>260 znaków) w worktree | głębokie repo może wywalić `git worktree` | `core.longpaths=true` w `GIT_CONFIG_GLOBAL` + krótsze identyfikatory worktree |
| 10 | Worktree nie jest kasowany po runie przerwanym restartem | osierocone katalogi | `recover()` mógłby próbować `git worktree prune` i czyszczenia po `ended_at` |

### 14.2 Ryzyka techniczne

| Ryzyko | Prawdopodobieństwo | Wpływ | Mitygacja |
|---|---|---|---|
| Zmiana API `bun:ffi` / zachowania Job Object po aktualizacji Bun | niskie | średni | test FFI w zestawie (§14.1 poz. 5) + pin wersji Bun przy wdrożeniu produkcyjnym |
| Antywirus/SmartScreen na `agentdock.exe` (niepodpisany, 86 MB) | średnie | średni | podpis kodu, installer (§15.I), alternatywnie uruchamianie przez `bun run` |
| Agent „ucieka” poza worktree i modyfikuje inne pliki użytkownika | średnie (przy niedobrym promptcie) | **wysoki** | jail plików (§15.B), uruchamianie na kopii repo/VM, zasada „tylko zaufane prompty” |
| Wyczerpanie dysku przez agenta (buildy, cache) | średnie | średni | limity w Job Object nie obejmują I/O — potrzebny monitoring/monitor + instrukcje dla agentów; docelowo kontener z ograniczonym wolumenem |
| Sekrety w promptach/logach (prompty bywają wrażliwe) | średnie | średni | retencja + szyfrowanie DB (DPAPI) — §15.G3 |
| Utrata danych przez `taskkill /T /F` w trakcie runów | niskie | średni | łagodne zatrzymanie (§15.G4) + `recover()` (dziś tylko oznacza jako przerwane) |

### 14.3 Dług techniczny

- `main.ts` (528 linii) łączy CLI, bootstrap, serwer i demo → kandydat do rozbicia na `cli/` (wzorzec z Warrena).
- Brak testów dla: `server.ts` (API/SSE), `jobs` na ścieżce degradacji (brak FFI), `projects` dla URL-i, `git.ts` dla konfliktów gałęzi.
- Brak `typecheck` w CI (lokalnie `bun run typecheck`), brak lintingu.
- `db.updateRun()` buduje SQL dynamicznie (bezpieczne, ale warto mieć whitelistę kolumn — jest, bo klucze pochodzą z typu).
- Brak logowania strukturalnego z poziomami (`log()` pisze wszystko do stdout).

### 14.4 Mechanizm migracji — ZAIMPLEMENTOWANY (2026-09-24, Ouroboros Faza 0)

Zamiast propozycji — stan faktyczny. `src/db.ts` eksportuje `MIGRATIONS` i `SCHEMA_VERSION`:

```ts
// src/db.ts (rzeczywisty kod)
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, description: "bazowy schemat (projekty, runy, zdarzenia) — zgodny z epoką AgentDocka", sql: [ … ] },
  { version: 2, description: "sejf kluczy API + rejestr agentów (dynamiczne role)",                 sql: [ … ] },
  { version: 3, description: "prawda o dostawie (push_enabled/delivery_state/push_error) + audyt kluczy", sql: [ … ] },
];
export const SCHEMA_VERSION = 3;
```

Zasady, które czynią to bezpiecznym:

1. **Krok 1 jest idempotentny** (`create table if not exists`) — baza z epoki AgentDocka (`user_version = 0`, tabele już istnieją) przechodzi go bez błędu i dogania numerację.
2. **Cała migracja jest w transakcji** — błąd ⇒ rollback i wyjątek z numerem kroku (lepiej odmówić startu niż pracować na wpół zmigrowanej bazie).
3. `alter table … add column` nie zna `if not exists`, więc tolerujemy konkretny błąd `duplicate column name`.
4. `pragma user_version` zapisywany **po** udanym kroku — przerwanie nie zostawia fałszywego „done”.

Weryfikacja: `doctor` → `schemat bazy user_version = 3`; realna baza z 14 runami zmigrowała się bez utraty danych; test automatyczny buduje bazę v1 + `user_version = 0` i sprawdza migrację oraz idempotencję.

Kryterium akceptacji: istniejąca baza z 14 runami migruje się bez utraty danych; `push:false` w API faktycznie blokuje push; `delivery_state ∈ {none, skipped_no_commits, pushed, failed, not_attempted}`.

### 14.5 Otwarte pytania do rozstrzygnięcia (nie tylko techniczne)

1. Czy brak jaila plików jest akceptowalny dla docelowego użycia, czy to jest **blokada**? (Jeśli blokada → §15.B.)
2. Czy agent może pushować sam (własnymi poświadczeniami), czy dostawa zawsze przez aplikację? (Dziś: zawsze aplikacja.)
3. Czy chcemy historię kosztów i limity budżetu per projekt (jak `maxCostUsd` w Warrenie)?
4. Czy aplikacja ma być jednoosobowa, czy ma obsłużyć „mały zaufany zespół” (co wymaga czegoś więcej niż token loopback)?
5. Czy zależy nam na PR-ach z aplikacji (wygoda) czy wystarcza push (prostota, mniej powierzchni ataku)?

---

## 15. Roadmapa: warianty dalszych zmian + pytania do dyskusji

Każda pozycja ma: cel, warianty, szkic implementacji, koszt, ryzyka, kryterium akceptacji i pytania do rozmowy. Sekcje są niezależne — można je realizować w dowolnej kolejności.

### A. „Aplikacja” z prawdziwego zdarzenia (okno, tray, autostart)

**Cel:** odejście od karty przeglądarki; uruchamianie jak każdy inny program.

| Wariant | Jak | Plusy | Minusy |
|---|---|---|---|
| A1. WebView2 + host w C#/WinForms | mały host .NET (`<200` linii) osadzający WebView2 wskazujący `http://127.0.0.1:8787`, uruchamiany przez `agentdock.cmd` | natywne okno, brak przeglądarki, ikona okna | dodatkowa zależność (.NET/WebView2 runtime obecny w Windows 11) |
| A2. WebView2 z Bun przez FFI | `CreateCoreWebView2EnvironmentWithOptions` + COM przez `bun:ffi` | jeden stack | wysoki koszt COM w FFI, ryzyko niestabilności |
| A3. Tauri/Neutralino | osobne narzędzie, UI pozostaje HTML | dojrzałe | nowy toolchain (Rust/Node), „cięższy” projekt |
| A4. Zostać przy przeglądarce | — | zero pracy | brak „programu” w odczuciu użytkownika |

Do tego wspólne elementy: ikona w zasobniku (tray) pokazująca liczbę aktywnych runów, autostart (`HKCU\…\Run` albo skrót w folderze Autostart), zamknięcie okna = zatrzymanie serwera (lub jego ukrycie).

**Kryterium akceptacji:** kliknięcie skrótu otwiera okno aplikacji (nie przeglądarki), zamknięcie okna zatrzymuje serwer, tray pokazuje liczbę aktywnych runów.
**Pytania:** czy tray jest potrzebny, czy wystarczy okno? Czy zamykanie okna ma ubijać runy, czy pytać o potwierdzenie (i czy wtedy anulować runy, czy je „osierocić” w bazie)?

### B. Izolacja systemu plików (najważniejszy temat bezpieczeństwa)

**Cel:** agent nie powinien móc czytać/pisać niczego poza swoim worktree (oraz katalogami cache).

| Wariant | Mechanizm | Poziom izolacji | Koszt/ryzyko |
|---|---|---|---|
| B1. AppContainer | `CreateAppContainerProfile`, `STARTUPINFOEX` z atrybutem `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, token z ograniczonym SID; dostęp do plików tylko tam, gdzie ACL pozwala | wysoki (jądro egzekwuje) | wymaga nadawania ACL katalogowi worktree; część narzędzi (git, node) działa dobrze, ale niektóre nie (np. zapis w `%TEMP%`); FFI + struktury |
| B2. Windows Sandbox | własna maszyna/VM na run, montaż worktree jako read-only/writable folder | bardzo wysoki | start VM ~ sekundy, wymaga funkcji Windows „Sandbox” (Pro/Enterprise/Home 11 z WSL2?), słaba integracja z UI na żywo |
| B3. Job Object + `CREATE_SUSPENDED` | dodać do B0 domknięcie okna czasowego: proces startuje zawieszony, jest przypinany do joba, potem `ResumeThread` | ten sam co dziś, ale bez okna | wymaga własnego `CreateProcessW` przez FFI zamiast `Bun.spawn` (utrata wygody Bun) |
| B4. Kontener opcjonalny | tryb „docker runtime”: `docker run --rm -v <worktree>:/workspace` (jak Warren) | wysoki (granica kontenera + sieć) | wymaga Dockera; powrót do zależności, którą właśnie odrzucono |
| B5. Zmiana użytkownika | uruchamianie procesu jako inny (niskouprzywilejowany) użytkownik przez `CreateProcessWithLogonW`/`runas` | średni/wysoki | wymaga utworzenia konta i hasła, komplikacje z dostępem do sieci i profilu |

**Rekomendacja do dyskusji:** B1 jako cel średnioterminowy (jądro egzekwuje ACL), B3 jako „tanie domknięcie” obecnego rozwiązania, B4 jako opcjonalny tryb dla osób, które i tak mają Dockera.
**Kryterium akceptacji:** test integracyjny: agent próbuje odczytać plik poza worktree (`C:\Users\<user>\Documents\secret.txt`) → odmowa; próbuje zapisać → odmowa; build/testy w worktree nadal działają.
**Pytania:** czy agent potrzebuje dostępu do `%TEMP%` i cache'ów globalnych (`~/.npm`, `~/.cache`)? Jak pogodzić to z ACL? Czy akceptujemy, że niektóre narzędzia przestaną działać (Node wymaga zapisu w `%TEMP%` — trzeba go dopuścić świadomie)?

### C. Sieć

| Wariant | Jak | Plusy | Minusy |
|---|---|---|---|
| C1. Proxy per run | zmienne typu `HTTP(S)_PROXY`, `*_BASE_URL`; opcjonalny lokalny proxy z allowlistą domen | proste, bez uprawnień admina | tylko dla narzędzi respektujących proxy |
| C2. WFP (Windows Filtering Platform) | filtr po SID/AppContainer + portów | jądro egzekwuje | wymaga usługi/uprawnień; złożone API |
| C3. Firewall po użytkowniku | reguła `New-NetFirewallRule` dla konta bądź ścieżki binarki | dostępne z PowerShell (admin) | zgrubne, wymaga admina |
| C4. Kontener z `--network=none` | jak w B4 | pełna kontrola | zależność Docker |

**Cel:** móc powiedzieć „run bez dostępu do sieci poza listą dozwolonych hostów”.
**Kryterium akceptacji:** run z listą `[api.anthropic.com]` nie może połączyć się z `example.com`; próba jest widoczna w zdarzeniach.

### D. Dostawa kodu: PR, forki, polityki

| Wariant | Zakres |
|---|---|
| D1. PR przez GitHub REST API | `POST /repos/{owner}/{repo}/pulls` tokenem z `GITHUB_TOKEN`; kolumny `pr_url`, `pr_state` |
| D2. Szablony PR | plik `.agentdock/pr-template.md` w repo, wypełniany podsumowaniem runu (prompt, diffstat, koszt) |
| D3. Polityki merge | zakaz automatycznego merge'a, tylko draft PR (bezpieczniej) — jak `pr.autoMerge` w Warrenie, ale domyślnie OFF |
| D4. Multi-forge | GitLab/Azure DevOps przez abstrakcję `Forge` (wzorzec z Warrena: `src/forge/contract.ts`) |

**Kryterium akceptacji:** run kończy się gałęzią + linkiem do PR-a w UI; brak tokenu = zachowanie dzisiejsze (sam push) z jasnym komunikatem.

### E. Agenci i harnessy

| Wariant | Zakres |
|---|---|
| E1. Adaptery per harness | normalizacja zdarzeń/usage (Claude Code `stream-json`, Pi RPC, Codex JSON) — parser jak `src/runtime/adapters/parsers` w Warrenie |
| E2. `steering` | wysyłanie wiadomości do żywego agenta (dla agentów czytających stdin/`inbox`), UI: pole „powiedz coś” + `POST /api/runs/:id/message` |
| E3. Edycja agentów w UI | CRUD na `agents` w `config.json` bez restartu (hot-reload konfiguracji) |
| E4. Zdolności i polityki | „agent może/nie może pushować”, limity kosztu per agent, wymuszanie modelu |
| E5. MCP | wystawienie AgentDock jako serwera MCP (żeby inne agenty mogły zlecać runy) |

**Pytania:** czy chcemy utrzymywać definicje agentów w JSON, czy przenieść je do bazy z API i historią wersji? Czy `steering` ma sens dla CLI, które nie czytają stdin?

### F. Orkiestracja: plan-runs, zależności, wyzwalacze

| Wariant | Zakres |
|---|---|
| F1. Plan-run | łańcuch zadań z bramkami (jak `src/plan-runs/` w Warrenie): sekwencyjne kroki, retry, dzieci |
| F2. Zależności między runami | „uruchom B po sukcesie A” |
| F3. Wyzwalacze | harmonogram (cron) i zdarzenia systemu plików (`FileSystemWatcher`) — np. „w każdą noc uruchom agenta porządkującego” |
| F4. Szablony zadań | biblioteka promptów z parametrami (per projekt) |

**Kryterium akceptacji (F1):** plan 3 kroków zatrzymuje się na porażce, wznawia po naprawie, każdy krok ma własny run w historii.

### G. Operacje, observowalność, dane

| Wariant | Zakres |
|---|---|
| G1. Metryki i analityka | `GET /metrics` (Prometheus-owy tekst), widok „koszt w czasie”, „czas per agent” |
| G2. Cache zależności | współdzielony cache (`node_modules`/`~/.cache`) montowany do runów → szybsze buildy; opcja `AGENTDOCK_CACHE_DIR` |
| G3. Sekrety | przechowywanie kluczy w Windows Credential Manager / DPAPI zamiast zmiennych środowiskowych; UI do zarządzania |
| G4. Łagodne zatrzymanie | `stop` wysyła sygnał do serwera (żeby zadziałał `drain()`), zamiast `taskkill /F`; opcje: „dokończ runy”, „anuluj wszystko” |
| G5. Retencja i backup | polityka czyszczenia zdarzeń/transkryptów, `vacuum`, eksport/import bazy |
| G6. Wielokrotne instancje | wiele profili (`AGENTDOCK_HOME`) + przełącznik w UI |

**Kryterium akceptacji (G4):** `stop` nie zostawia runów w stanie „running” w bazie; trwające runy są albo domknięte, albo jawnie anulowane.

### H. Współpraca i dostęp

| Wariant | Zakres |
|---|---|
| H1. Tokeny per klient | kilka tokenów z etykietami, rotacja, ostatnie użycie |
| H2. Ekspozycja poza loopback | TLS reverse proxy (jak w Warrenie), opcjonalnie `WARREN`-owa ostrożność: jedna instancja = jeden zaufany zespół |
| H3. RBAC | role: operator (dispatch), obserwator (read-only) — jak `readPublic` w Warrenie |
| H4. Zdalni pracownicy | kolejka zadań na współdzielonym hoście + „workerów” na innych maszynach (to już inna klasa projektu — patrz Warren/K8s) |

**Pytanie kluczowe:** czy z założenia ma to być narzędzie jednoosobowe (dziś), czy ma rosnąć do małego zespołu? Odpowiedź zmienia priorytety (H przed B/C albo odwrotnie).

### I. Dystrybucja i jakość

| Wariant | Zakres |
|---|---|
| I1. Installer | Inno Setup / WiX: kopiuje pliki, tworzy wpis „Programy i funkcje”, skrót, autostart |
| I2. Podpis kodu | certyfikat (Authenticode) → brak ostrzeżeń SmartScreen |
| I3. Auto-update | sprawdzanie wersji + podmiana binarki (jak Warren: `install.sh` + tagi) |
| I4. Packaging przez `winget`/`scoop` | wygodna instalacja/aktualizacja |
| I5. CI | GitHub Actions: `bun test`, `typecheck`, build exe, publikacja artefaktu |
| I6. Zbiór testów | macierz: API/SSE, degradacja bez FFI, AppContainer, push-failure, retencja |

**Kryterium akceptacji (I5):** zielone CI na Windows runner + artefakt `agentdock.exe` w każdym tagu.

### Priorytetyzacja (propozycja do dyskusji)

| Priorytet | Pozycje | Uzasadnienie |
|---|---|---|
| **P0 (fundament pod dalszą pracę)** | ~~§14.4 migracje~~ ✅, ~~§14.1 poz. 1 (prawda o pushu)~~ ✅ — zrobione w Ouroboros Faza 0–1; zostaje §14.1 poz. 5 (test limitów w zestawie) i G4 (łagodne zatrzymanie) | porządkują kontrakt i chronią przed regresjami |
| **P1 (bezpieczeństwo i codzienna wygoda)** | B1/B3 (izolacja plików), G3 (sekrety), A1 (okno WebView2), G5 (retencja) | największy wpływ na ryzyko i „uczucie aplikacji” |
| **P2 (funkcje produktowe)** | D1-D2 (PR), E1-E3 (adaptery, steering, edycja agentów), F1 (plan-runs), G1-G2 (metryki, cache) | zwiększają użyteczność, ale nie blokują |
| **P3 (skala i dystrybucja)** | C (sieć), H2-H4 (dostęp/zespół), I (installer/CI/auto-update) | mają sens, gdy pojawi się więcej użytkowników/maszyn |

---

## 16. Pakiety kontekstu do dyskusji z innymi modelami

### 16.1 Brief „jednym akapitem” (do wklejenia na start rozmowy)

> Zbudowałem **AgentDock** — natywną aplikację Windows (Bun 1.4.2, zero zależności runtime, SQLite, UI w przeglądarce) do uruchamiania agentów kodujących jako **izolowanych, obserwowalnych runów**. Run dostaje świeży `git worktree` na gałęzi `agentdock/run-<id>`, proces agenta jest przypinany do **Windows Job Object** (limit pamięci, limit 64 procesów, kill-on-close → brak sierot; realizacja przez `bun:ffi` → `kernel32.dll`), środowisko jest budowane z **allowlisty** (agent nie dziedziczy sekretów), ma **per-run git config** (brak Twoich credential helperów), timeout i anulowanie ubijają całe drzewo, a finalizacja commituje szczątki, liczy diffstat i **pushuje gałąź na origin**. Historia (projekty, runy, zdarzenia) jest w SQLite, UI ma log na żywo po SSE, CLI ma 12 poleceń, a wszystko kompiluje się do jednego `agentdock.exe` (86 MB). Nie ma jaila systemu plików ani odcięcia sieci (Windows bez kontenera/AppContainer tego nie daje). Mam 13/13 testów (w tym E2E) i zweryfikowane: limit pamięci (OS ubija proces), timeout z ratowaniem pracy, anulowanie, kolejkę 2+1 przy `maxConcurrent=2`. Chcę przedyskutować dalsze zmiany: izolację plików (AppContainer vs Windows Sandbox vs Job Object + `CREATE_SUSPENDED`), sieć (proxy vs WFP), PR-y przez GitHub API, okno WebView2, retencję i migracje schematu SQLite.

### 16.2 Brief techniczny (fakty do wklejenia, gdy rozmówca chce konkretów)

```text
APLIKACJA
- nazwa/wersja: AgentDock 0.1.0 ; Windows 11 ; Bun 1.4.2 ; brak zależności runtime
- 12 modułów TS w src/ (3656 linii z testami/README), UI jako jeden plik HTML
- dane: %USERPROFILE%\.agentdock\{config.json, agentdock.db(WAL), worktrees/, runs/, repos/, demo/}
- binding: 127.0.0.1:8787 ; auth: Bearer lub ?token= ; token losowy w config.json

CYKL RUNU
- queued → preparing (fetch + git worktree add -b agentdock/run-<id>) → running (spawn + Job Object)
  → finalizing (commitAll salvage, diffstat, push, worktree remove) → succeeded|failed|cancelled
- queue: limit active+starting < maxConcurrent (domyślnie 2)
- recovery po restarcie: stany nieterminalne → failed ("przerwany przez restart aplikacji")
- push: gdy commitsAhead>0 i nie anulowano; nigdy przy anulowaniu
- limity: pamięć 2048 MB/proces, czas 1800 s, 64 procesy/job, 20 000 zdarzeń/run, 20 000 znaków/linia

JOB OBJECT (bun:ffi → kernel32)
- CreateJobObjectW / SetInformationJobObject(JobObjectExtendedLimitInformation=9, 144 B)
- limit pamięci: flaga 0x100, pole ProcessMemoryLimit na offsecie 112 (BigUint64)
- limit procesów: flaga 0x8, pole ActiveProcessLimit na offsecie 40 = 64
- kill-on-close: flaga 0x2000 ; TerminateJobObject przy cancel/timeout ; CloseHandle na końcu
- przypisanie: OpenProcess(SET_QUOTA|TERMINATE=0x101) → AssignProcessToJobObject (po starcie, okno ms)
- degradacja: brak FFI → kind="none", runy działają bez limitów (widoczne w job_kind, UI, doctor)

ŚRODOWISKO AGENTA
- allowlist bazowa: PATH, PATHEXT, SystemRoot, SystemDrive, windir, ComSpec, TEMP, TMP, USERPROFILE,
  APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles, ProgramFiles(x86), CommonProgramFiles,
  NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE, OS, LANG, LC_ALL, PYTHONIOENCODING
- + na agenta: claude → ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR
              codex → OPENAI_API_KEY, OPENAI_BASE_URL ; aider → ANTHROPIC/OPENAI/GEMINI/DEEPSEEK
- wstrzykiwane: AGENTDOCK=1, AGENTDOCK_RUN_ID/PROJECT/WORKSPACE/PROMPT_FILE, GIT_TERMINAL_PROMPT=0,
  GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=<runs>/<id>/gitconfig, GIT_AUTHOR_*/GIT_COMMITTER_*

API (auth na /api/*)
- GET /healthz ; GET / (UI) ; GET /api/state ; POST /api/projects ; DELETE /api/projects/:id
- POST /api/runs {projectId, agent, prompt, memoryLimitMb?, timeoutSec?, push?(obecnie ignorowane)}
- GET /api/runs/:id ; GET /api/runs/:id/events?from=seq (SSE: hello + data + keepalive 20 s)
- POST /api/runs/:id/cancel

ZNANE LUKI (istotne w dyskusji)
- brak jaila plików i odcięcia sieci; brak limitów CPU/IO
- pushed=0/1 nie odróżnia "nie było commitów" od "push się nie udał"; brak kolumn push_enabled/push_error
- brak migracji schematu SQLite; brak retencji zdarzeń/transkryptów
- cancel działa tylko przez proces-gospodarza (HTTP); brak reapera dla osieroconych runów
- brak testu limitów pamięci w CI; brak testów API/SSE
```

### 16.3 Zestaw pytań do rozmówcy-modelu (skopiuj i zadaj)

**Izolacja:**
1. Na Windows, dla pojedynczego użytkownika bez uprawnień admina: czy AppContainer (B1) jest realistyczny dla procesu `claude`/`codex` (Node/Bun + git), czy skończy się lawiną problemów z ACL, `%TEMP%` i cache'ami? Jakie widzisz konkretne pułapki?
2. Czy wariant B3 (`CreateProcessW` z `CREATE_SUSPENDED` → `AssignProcessToJobObject` → `ResumeThread`) jest wart utraty wygody `Bun.spawn`? Jakie jeszcze korzyści daje (np. gwarancja, że żadne dziecko nie umknie limitom)?
3. Czy da się pogodzić brak jaila plików z sensownym bezpieczeństwem przez *politykę* (np. uruchamianie wyłącznie na repo w dedykowanym katalogu, wymuszanie `core.longpaths`, blokada `..` w promptach) — czy to iluzja?

**Sieć:**
4. Który wariant (C1 proxy, C2 WFP, C3 firewall po SID, C4 kontener) daje najlepszy stosunek wartości do kosztu przy założeniu „brak admina"? Czy WFP da się sensownie użyć z aplikacji użytkownika?

**Architektura:**
5. Czy `Bun.serve` + SSE + SQLite w jednym procesie wytrzyma 10-20 równoległych runów, czy od razu projektować „server + worker" (procesy potomne trzymające runy)? Jakie limity widzisz (GIL? wątki Bun? FileLock SQLite przy WAL)?
6. Czy warto przenieść definicje agentów z `config.json` do bazy (wersjonowanie, edycja w UI), czy zostać przy pliku (edytowalny, wersjonowalny w gitcie)?
7. Jak zaprojektować migracje SQLite w aplikacji desktopowej, aby były bezpieczne (backup przed migracją, `user_version`, rollback)?

**Produkt:**
8. Czy „push gałęzi bez PR” jest wystarczającym MVP dostawy (jak w Warrenie), czy bez PR-a narzędzie nie ma sensu dla codziennej pracy?
9. Co powinno się stać z runami przy zamykaniu aplikacji: dokończyć, anulować z salvage, czy zostawić i oznaczyć jako przerwane?
10. Jak w UI pokazać ryzyko „brak jaila plików”, żeby użytkownik nie nabrał fałszywego poczucia bezpieczeństwa (dziś jeden chip „Job Object ✓”)?

**Testy:**
11. Jak przetestować limit pamięci w sposób deterministyczny i szybki (obecny manualny test: agent alokuje do OOM)? Czy `[mem_mb]` + limit 64 MB to dobry test CI na Windows runnerze?
12. Jak testować AppContainer (jeśli wejdzie)? Czy da się to zrobić na GitHub-hosted Windows runnerze?

### 16.4 Ostrzeżenia dla rozmówcy (typowe błędne założenia o Windows)

- **Nie ma `bwrap`/namespaces dla zwykłego procesu.** Odpowiedniki to AppContainer, Job Object, Windows Sandbox, kontenery. Nie zakładaj, że „da się to samo zrobić przez ACL”.
- **Job Object to nie cgroups.** Daje limit pamięci/procesów/czasu CPU, ale **nie** ma kwot CPU ani limitów I/O per proces.
- **`Start-Process -ArgumentList` nie cytuje argumentów** — ścieżki ze spacjami pękają, jeśli nie zacytujesz ręcznie.
- **PowerShell 5.1 czyta `.ps1` jako ANSI** — pliki z polskimi znakami w UTF-8 bez BOM się nie parsują (dlatego nasz `.ps1` jest ASCII-only).
- **`cmd` parsuje cały blok `if (...)`** — nawiasy w tekstach `echo` psują składnię („. was unexpected at this time.”).
- **Bun nie jest w PATH po instalacji** w nowej sesji; używaj `process.execPath`, gdy spawnujesz siebie.
- **WSL2 i Windows to dwa systemy plików** — praca na `/mnt/c` jest wolna, a uprawnienia (root w WSL) ≠ uprawnienia Windows.
- **Nie zakładaj, że `git worktree` na Windows nie ma problemów** — długie ścieżki (>260) i antywirus potrafią przeszkodzić (`core.longpaths`).

---

## 17. Słownik pojęć

| Termin | Znaczenie |
|---|---|
| **AgentDock** | nazwa aplikacji opisanej w tym dokumencie |
| **Agent (preset)** | definicja komendy + argumentów + zmiennych środowiskowych dla konkretnego CLI agenta |
| **Agent demo** | wbudowany, deterministyczny „agent” bez modelu (do testów i demo) |
| **Dispatch** | zlecenie runu (UI/CLI → `POST /api/runs`) |
| **Finalizacja** | etap po zakończeniu procesu: salvage commit, diffstat, push, sprzątanie worktree |
| **Job Object** | obiekt jądra Windows grupujący procesy i egzekwujący limity |
| **Knob** | znacznik w treści promptu sterujący zachowaniem agenta demo (np. `[mem_mb=800]`) |
| **Lifecycle** | zdarzenia generowane przez aplikację (nie przez agenta) |
| **Salvage** | ratowanie niezacommitowanej pracy agenta commitem |
| **Run** | jedno wykonanie agenta na projekcie (wiersz w bazie + proces + workspace) |
| **SSE** | Server-Sent Events — jednokierunkowy strumień zdarzeń do UI |
| **Warren** | projekt referencyjny (`jayminwest/warren`), „duży brat” AgentDocka |
| **Worktree** | `git worktree` — osobny katalog roboczy dla jednej gałęzi |
| **`win32-job`** | wartość `job_kind` oznaczająca, że limity Job Object są aktywne |

---

## 18. Aneksy

### 18.A Pełny DDL schematu

```sql
create table if not exists projects (
    id text primary key,
    name text not null,
    path text not null,
    url text,
    default_branch text not null,
    added_at text not null
);

create table if not exists runs (
    id text primary key,
    project_id text not null,
    agent text not null,
    prompt text not null,
    state text not null,
    branch text,
    worktree text,
    base_commit text,
    pid integer,
    exit_code integer,
    failure_reason text,
    created_at text not null,
    started_at text,
    ended_at text,
    cost_usd real,
    tokens_in integer,
    tokens_out integer,
    commits_ahead integer,
    files_changed integer,
    insertions integer,
    deletions integer,
    pushed integer,
    memory_limit_mb integer,
    timeout_sec integer,
    job_kind text
);

create table if not exists events (
    id integer primary key autoincrement,
    run_id text not null,
    seq integer not null,
    ts text not null,
    kind text not null,
    stream text,
    text text not null
);

create index if not exists events_run_seq on events(run_id, seq);
create index if not exists runs_state on runs(state);
```

### 18.B Przykładowy `config.json`

```json
{
  "port": 8787,
  "token": "Q7bL-EhyG0AGOnhPdLrUnAdgwTPf1QD0",
  "maxConcurrent": 2,
  "memoryLimitMb": 2048,
  "timeoutSec": 1800,
  "branchPrefix": "agentdock/run-",
  "agents": {
    "demo": {
      "builtin": true,
      "description": "Wbudowany agent zastępczy — nie woła modelu. …",
      "command": "{self}",
      "args": ["--demo-agent"],
      "stdinPrompt": true
    },
    "claude": {
      "description": "Claude Code CLI (wymaga `claude` w PATH i poświadczenia modelu).",
      "command": "claude",
      "args": ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      "stdinPrompt": true,
      "env": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]
    },
    "codex": { "command": "codex", "args": ["exec", "--full-auto", "{prompt}"], "env": ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
    "aider": { "command": "aider", "args": ["--yes-always", "--no-auto-commits", "--message", "{prompt}"], "env": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"] }
  }
}
```

### 18.C Tabela API (skrót operacyjny)

| Operacja | Komenda `curl` (dla dokumentacji/dyskusji) |
|---|---|
| stan | `curl -H "authorization: Bearer $T" http://127.0.0.1:8787/api/state` |
| projekt z ścieżki | `curl -X POST -H "authorization: Bearer $T" -H "content-type: application/json" -d '{"path":"C:\\praca\\repo"}' http://127.0.0.1:8787/api/projects` |
| projekt z URL | `… -d '{"url":"https://github.com/owner/repo.git"}' …` |
| dispatch | `… -d '{"projectId":"prj_…","agent":"demo","prompt":"zadanie","memoryLimitMb":1024,"timeoutSec":300}' …/api/runs` |
| podgląd | `curl -H "authorization: Bearer $T" …/api/runs/run_…` |
| live | `curl -N "…/api/runs/run_…/events?from=0&token=$T"` |
| anulowanie | `curl -X POST -H "authorization: Bearer $T" …/api/runs/run_…/cancel` |
| healthz | `curl http://127.0.0.1:8787/healthz` |

### 18.D Komendy weryfikacyjne (copy-paste, PowerShell/cmd)

```bat
:: instalacja Bun (jeśli brak)
powershell -c "irm bun.sh/install.ps1 | iex"

:: start / stan / stop
agentdock.cmd start
agentdock.cmd status
agentdock.cmd stop

:: pełne demo bez kluczy
agentdock.cmd demo

:: testy i build
agentdock.cmd test
agentdock.cmd build
agentdock.cmd shortcut

:: CLI
agentdock.cmd cli doctor
agentdock.cmd cli run -p "dodaj plik NOTATKA.md" --agent demo
agentdock.cmd cli run -p "test limitu [mem_mb=800]" --memory 256
agentdock.cmd cli run -p "test timeoutu [sleep_ms=60000]" --timeout 5
agentdock.cmd cli runs --limit 20
agentdock.cmd cli cancel <run-id>
```

### 18.E Layout struktur Job Object (do implementacji/weryfikacji)

```text
JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64, 144 B)
  +0    LARGE_INTEGER PerProcessUserTimeLimit
  +8    LARGE_INTEGER PerJobUserTimeLimit
  +16   DWORD         LimitFlags                    ← 0x8 | 0x100 | 0x2000
  +20   (padding 4)
  +24   SIZE_T        MinimumWorkingSetSize
  +32   SIZE_T        MaximumWorkingSetSize
  +40   DWORD         ActiveProcessLimit            ← 64
  +44   (padding 4)
  +48   ULONG_PTR     Affinity
  +56   DWORD         PriorityClass
  +60   DWORD         SchedulingClass
  +64   IO_COUNTERS   IoInfo (6 × LARGE_INTEGER = 48 B)
  +112  SIZE_T        ProcessMemoryLimit            ← memory_limit_mb × 1 MiB
  +120  SIZE_T        JobMemoryLimit
  +128  SIZE_T        PeakProcessMemoryUsed
  +136  SIZE_T        PeakJobMemoryUsed
```

### 18.F Mapa „gdzie czego szukać w kodzie”

| Zagadnienie | Plik:linia (przybliżenie) |
|---|---|
| maszyna stanów runu | `src/runner.ts:255-285` (tick), `:392-600` (execute) |
| limity i job | `src/job.ts:41-49` (FFI), `:89-127` (struct), `:130-155` (API joba) |
| allowlist środowiska | `src/config.ts:50-72` |
| argv i env agenta | `src/agents.ts:52-95` |
| worktree i push | `src/git.ts:118-186` |
| parser kosztu | `src/runner.ts:78-102` |
| zapis zdarzeń | `src/db.ts:247-290` |
| SSE | `src/server.ts:240-287` |
| UI | `src/ui.ts:12-403` |
| CLI i hosty runów | `src/main.ts:130-215` (hosty), `:430-520` (CLI) |
| agent demo | `src/demo-agent.ts:70-169` |
| launcher | `agentdock.cmd`, `tools/agentdock-start.ps1` |

### 18.G Historia sesji (skrót)

1. **Analiza Warrena** — przeczytane README, architektura, dokumenty designu, kod ścieżki runtime/sandbox, dokumentacja CLI/API.
2. **Faza 1** — kopia robocza na Windows przez WSL2: instalacja Buna, kopia źródeł, build UI, boot serwera, demo run agenta zastępczego, weryfikacja `bwrap`, dostępu z Windows i wypchnięcia gałęzi; 8 skryptów + README.
3. **Faza 2** — AgentDock: projekt architektury, implementacja 12 modułów, launcher, dokumentacja, kompilacja do `.exe`; 14 runów testowych w bazie, 13/13 testów.
4. **Faza 3 (ten dokument)** — konsolidacja wiedzy i rejestru zmian w formie umożliwiającej prezentację i dalszą dyskusję.

---

*Koniec dokumentu. Plik wygenerowany w sesji roboczej; wszystkie liczby pochodzą z rzeczywistego wykonania na tej maszynie (2026-09-23/24), a fragmenty kodu i logów z plików projektu.*
