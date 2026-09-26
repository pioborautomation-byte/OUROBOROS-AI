# AgentDock — brief dla modeli (kontekst do wklejenia)

Krótki, samowystarczalny pakiet kontekstu. Pełna wersja: `docs/AgentDock-DOKUMENTACJA.md`.

---

## 1. Co to jest

**AgentDock 0.1.0 → Ouroboros** — natywna aplikacja Windows (bez WSL, bez Dockera, bez Node.js) do uruchamiania agentów kodujących jako **izolowane, obserwowalne runy**. Inspirowana projektem **Warren 0.19.2** (`jayminwest/warren`), zaprojektowana pod jeden komputer z Windows i rozwijana w kierunku **roju agentów (Ouroboros)**: role definiowane w bazie, klucze API w lokalnym sejfie (DPAPI), docelowo router modeli, narzędzia web i orkiestracja wielu runów we wspólnym workspace.

**Zrobione (Faza 0–2 Ouroborosa, 2026-09-24):** wersjonowane migracje SQLite (`user_version`), sejf kluczy API (DPAPI, brak sekretów w env hosta), rejestr ról w bazie z CRUD bez restartu, jawna dostawa gałęzi (`delivery_state`).

**Zrobione (Faza 3 — Smart Router, 2026-09-24):** bramka decyzyjna „model lokalny czy chmura” przed spawnem agenta: heurystyka złożoności (długość, słowa-klucze, struktura, rozmiar repo) + opcjonalny klasyfikator modelem, próg 0,5, wymuszenia (operator > wrażliwy projekt > rola > tryb), sonda Ollamy z kontrolą **czy model jest pobrany**, zamiana roli (`ollama-local`) + placeholdery `{model}`/`{tier}` + env poziomu, audyt w `route_json`, statystyki lokalnie/chmura. **47/47 testów**, na żywo: proste zadanie → `qwen2.5-coder:7b` odpowiedział w 2 s, koszt API `n/d`.

Rdzeń: `repo + zadanie → świeży git worktree na gałęzi agentdock/run-<id> → proces agenta w Windows Job Object → strumień zdarzeń (SSE) → finalizacja (salvage commit, diffstat, push gałęzi) → sprzątanie worktree`.

## 2. Stack

- **Bun 1.4.2**, TypeScript bez transpilacji, **zero zależności runtime**
- `bun:sqlite` (WAL) — projekty, runy, zdarzenia
- `Bun.serve` — HTTP API + SSE + UI (jeden plik HTML, bez buildu)
- `Bun.spawn` — procesy agentów
- `bun:ffi` → `kernel32.dll` — **Job Object** (limity procesu)
- `bun:ffi` → `crypt32.dll` + `kernel32.dll` — **sejf kluczy API (DPAPI)**: `CryptProtectData`/`CryptUnprotectData`, a `LocalFree` z `kernel32`
- `bun build --compile` → `agentdock.exe` (86 MB, jeden plik)
- Launcher: `agentdock.cmd` + `tools/agentdock-start.ps1` (ukryty proces + karta przeglądarki)

## 3. Cykl życia runu

```text
queued → preparing (fetch + worktree add -b agentdock/run-<id>)
       → running   (spawn + Job Object, eventy na żywo)
       → finalizing (commitAll salvage → diffstat → git push → worktree remove)
       → succeeded | failed | cancelled
```

- Kolejka: `maxConcurrent` (2 domyślnie), licznik `active.size + starting.size`.
- Limit czasu → `TerminateJobObject` → salvage commit → **push** (praca nie ginie).
- Anulowanie → `TerminateJobObject` → salvage commit → **bez pusha** (celowo).
- Restart aplikacji → runy nieterminalne oznaczane jako `failed` („przerwany przez restart aplikacji”).
- Gwarantowany efekt: **wypchnięta gałąź** (jeśli są commity i nie anulowano).

## 4. Izolacja (Windows)

| Mechanizm | Realizacja | Odpowiednik w Warrenie |
|---|---|---|
| limit pamięci | Job Object, flaga `0x100`, pole @112 (144-bajtowa struktura, `bun:ffi`) | cgroup `memory.max` |
| limit procesów | Job Object, flaga `0x8`, `ActiveProcessLimit = 64` | limity procesów |
| brak sierot | `KILL_ON_JOB_CLOSE` `0x2000` + `TerminateJobObject` | `--die-with-parent` |
| brak dziedziczenia sekretów | allowlist 21 zmiennych + per-agent lista | profile env |
| tożsamość i poświadczenia gita | per-run `GIT_CONFIG_GLOBAL` + `GIT_CONFIG_NOSYSTEM=1` | tożsamość per run |
| workspace | `git worktree` per run | worktree |

**Brak (świadomie):** jail systemu plików, odcięcie sieci, kwoty CPU, limity I/O — Windows bez AppContainer/kontenera tego nie daje.

## 5. API (localhost 8787, token obowiązkowy na `/api/*`)

```text
GET    /healthz              {ok, schemaVersion, vault, agents, active, jobObjects}
GET    /api/routing[?fresh=1]  konfiguracja routera + sonda Ollamy (modele) + statystyki
PATCH  /api/projects/:id      {sensitive: true|false}   ← projekt wrażliwy = tylko model lokalny
GET    /                     UI (zakładki: Runy / Role agentów / Klucze API)
GET    /api/state            projekty + role + klucze + runy + limity
POST   /api/projects         {path} | {url}
DELETE /api/projects/:id
POST   /api/runs             {projectId, agent, prompt, memoryLimitMb?, timeoutSec?, push?, tier?}
                             tier: "auto" | "local" | "cloud"  (domyślnie auto = decyzja routera)
GET    /api/runs/:id         run + wszystkie zdarzenia
GET    /api/runs/:id/events  SSE (hello + data + keepalive 20 s, replay po ?from=seq)
POST   /api/runs/:id/cancel
GET    /api/agents           lista ról          POST /api/agents (create)
PUT    /api/agents/:name     edycja             DELETE /api/agents/:name
PUT    /api/agents/:name/keys {keyIds}           przypisanie kluczy z sejfu
GET    /api/keys             lista (bez sekretów)  POST /api/keys {label, provider, envVar, secret}
PUT    /api/keys/:id         rotacja/wyłączenie    DELETE /api/keys/:id
```
`push: false` jest respektowany → `delivery_state = "skipped_disabled"` (gałąź zostaje lokalnie, bez pusha).

## 6. Agenci

Presety: `demo` (wbudowany, bez modelu, `--demo-agent`), `claude`, `codex`, `aider`. **Role żyją w tabeli `agents`** (CRUD przez API/UI/CLI, działają bez restartu serwera); `config.json` to jednorazowy zasiew.
Placeholdery: `{prompt}`, `{promptFile}`, `{workspace}`, `{runId}`, `{self}`.
Agent demo ma knobs: `[sleep_ms=N]`, `[mem_mb=N]`, `[fail]`, `[commit]`, `[silent]`, `[printenv NAZWA]` (raportuje tylko obecność i długość zmiennej).

**Sekrety:** wyłącznie z sejfu (`api_keys` + przypisania `agent_keys`); nazwy sekretopodobne w polu `env` roli (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`) są odrzucane — inaczej dałoby się obejść sejf przez config.

**Poziom modelu roli (Faza 3):** `tier` = `local` / `cloud` / `null` (auto). Presety wbudowane: `demo` (stub bez modelu) i `ollama-local` (`ollama run {model} {prompt}`, tier local). Role wbudowane są pomijane przez router (świadomy wybór operatora).

## 7. Dowody działania

- `bun test`: **47/47 pass** (~17 s) — jądro + Faza 0–2 + **Faza 3** (heurystyka, decyzje, wymuszenia, fallback vs blokada, model niepobrany, zamiana roli, `{prompt}`/`{model}` w argv, env poziomu, rola wbudowana pomijana, wrażliwy projekt bez worktree). `bun run typecheck` bez błędów.
- Faza 3 na żywo: `router: wynik złożoności 0.00 < próg 0.50 → model lokalny` → `zamieniam rolę asystent → ollama-local` → `ollama run qwen2.5-coder:7b "…"` → odpowiedź w 2 s, koszt `n/d`; wymuszony niepobrany model → run **zablokowany** z listą dostępnych modeli.
- Migracje na żywo: baza z 14 runami → `user_version = 3` (Faza 1–2), potem `user_version = 4` (Faza 3) — historia zachowana w obu krokach.
- Dowód sejfu na żywo: `! demo-agent: OUROBOROS_DEMO_SECRET=obecna (długość 14)` i `ANTHROPIC_API_KEY=BRAK`; brak jawnych wystąpień sekretu w pliku bazy.
- Limit pamięci: `[mem_mb=800]` przy limicie 256 MB → proces ubity przez **jądro** (`RangeError: Out of memory`), run `failed`.
- Timeout 5 s: ubity, praca uratowana commitem, gałąź wypchnięta, `failed` z powodem.
- Anulowanie: drzewo procesów ubite, `cancelled`, bez pusha.
- Kolejka: 3 dispatch przy `maxConcurrent=2` → 2× `running` + 1× `queued`.
- Wersja jednoplikowa `agentdock.exe` przechodzi pełny cykl runu.
- Baza po sesji testowej: 1 projekt, 14 runów (11 `succeeded`, 2 `failed`, 1 `cancelled`), 450 zdarzeń.
- Dla kontrastu, Warren na tej maszynie działa tylko w WSL2 (`bwrap --unshare-all --uid 1000 …`), bo `src/sandbox/sandbox.ts` odrzuca `win32`.

## 8. Znane luki (kandydaci do zmian)

1. Brak jaila plików i odcięcia sieci; brak kwot CPU/IO.
2. ~~`pushed` 0/1 nie odróżnia „nie było commitów” od „push się nie udał”; `push` ignorowany~~ → **zrobione** (`delivery_state`, `push_enabled`, `push_error`).
3. ~~Brak migracji schematu SQLite~~ → **zrobione** (`user_version` + `MIGRATIONS[]`).
4. ~~Brak edycji agentów w UI~~ → **zrobione** (zakładka *Role agentów*).
5. Brak retencji: zdarzenia, transkrypty, gałęzie runów rosną bez końca.
6. Anulowanie działa tylko przez proces-gospodarza (HTTP); brak reapera dla runów osieroconych.
7. Brak `steering` (wiadomości do żywego agenta), brak plan-runs, brak PR-ów.
8. Brak testów API/SSE i testu limitów w CI; `doctor` nie sprawdza długich ścieżek.
9. Zatrzymanie launcher-em to `taskkill /F` (bez `drain()`), więc runy w locie są twardo ubijane.

## 9. O czym chcemy dyskutować (skrót)

**Najbliższe (Faza 4–5 Ouroborosa — brief):**
- **Narzędzia web:** serwer **MCP** wystawiony przez Ouroborosa (`web.fetch`, `web.search`, `repo.read`, `task.delegate`) vs własna pętla tool-calls; allowlista domen, cache w `runs/<id>/context/web/`, ochrona przed SSRF (brak `127.0.0.1`, `file://`, zakresów prywatnych). Wniosek z Fazy 3: **samo skierowanie do modelu lokalnego nie zmienia kodu** — bez narzędzi lokalny poziom kończy się `skipped_no_commits`.
- **Rój (Faza 5):** serializowany rój w jednym worktree (blackboard + drzewo zadań + jeden push korzenia) vs równoległe worktree z cherry-pick; budżet kosztu całego drzewa; dziedziczenie kluczy/limitów przez zadania dzieci.
- **Faza 3.5 (opcjonalnie):** pomiar realnych oszczędności (średni koszt chmury vs liczba runów lokalnych), estymator uczący się z historii, rola lokalna z narzędziami (`aider --model ollama/…`, `opencode`), `projects.routing_mode`.

**Późniejsze:**
- **Izolacja plików:** AppContainer vs Windows Sandbox vs `CREATE_SUSPENDED` + Job Object vs opcjonalny kontener.
- **Sieć:** proxy per run vs WFP vs reguła firewalla po SID vs `--network=none`.
- **Architektura:** jeden proces (`Bun.serve` + runner) vs server + workery przy 10-20 równoległych runach.
- **UX:** okno WebView2 + tray zamiast karty przeglądarki; uczciwe pokazanie granic izolacji w UI.
- **Retencja i backup** (baza, transkrypty, gałęzie runów).

Pełne warianty, koszty, kryteria akceptacji i pytania: `docs/Ouroboros-FAZA-1-2.md` §8 (fazy 3–5) oraz `docs/AgentDock-DOKUMENTACJA.md` §15–§16.

## 10. Pułapki Windows, o których warto pamiętać w dyskusji

- Brak `bwrap`/namespaces dla zwykłego procesu; Job Object ≠ cgroups (brak kwot CPU/IO).
- `Start-Process -ArgumentList` nie cytuje argumentów → ścieżki ze spacjami pękają.
- PowerShell 5.1 czyta `.ps1` jako ANSI → pliki z polskimi znakami (UTF-8 bez BOM) się nie parsują.
- `cmd` parsuje cały blok `if (...)` → nawiasy w `echo` psują składnię.
- Po instalacji Buna nie ma go w PATH w bieżącej sesji → w kodzie używać `process.execPath`.
- WSL2 to inny system plików (`/mnt/c` wolne), a root w WSL ≠ uprawnienia Windows.
- `git worktree` na Windows: uważać na ścieżki >260 znaków (`core.longpaths`) i antywirus.
