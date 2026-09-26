# AgentDock

**Lokalna aplikacja Windows, która uruchamia zadania agentów kodujących jako izolowane, obserwowalne runy.**
Natywnie — bez WSL, bez Dockera, bez konta w chmurze. Jeden plik `.exe` (albo `bun` + źródła), dane lokalnie, UI w przeglądarce.

To „młodszy brat” [Warrena](https://github.com/jayminwest/warren): ten sam pomysł (run jako obciążenie, nie sesja w terminalu), ale zaprojektowany pod jeden komputer z Windows i to, co Windows realnie potrafi.

**Dokumentacja:** ten plik to skrót dla użytkownika. Pełny opis techniczny (architektura, specyfikacja, decyzje projektowe, znane luki, roadmapa i materiał do dyskusji) jest w [`docs/AgentDock-DOKUMENTACJA.md`](docs/AgentDock-DOKUMENTACJA.md); skrócony kontekst do wklejenia w rozmowę z innym modelem — [`docs/AgentDock-BRIEF-DLA-LLM.md`](docs/AgentDock-BRIEF-DLA-LLM.md); raport z wdrożenia **Ouroborosa (Faza 0–2: migracje, sejf kluczy, dynamiczne role)** — [`docs/Ouroboros-FAZA-1-2.md`](docs/Ouroboros-FAZA-1-2.md).

> **Kierunek rozwoju:** aplikacja ewoluuje w **Ouroboros** — rój agentów, który sam dobiera role i modele, korzysta z internetu i prowadzi zadanie przez wiele runów we wspólnym workspace. Zrealizowane filary: **sejf kluczy API (DPAPI)**, **rejestr ról w bazie** i **Smart Router** (decyzja „model lokalny czy chmura”).

### Smart Router (Faza 3) — tanie zadania na modelu lokalnym

Aplikacja szacuje złożoność zadania **przed** uruchomieniem agenta i wybiera poziom modelu:

```text
dispatch ─► scorePrompt(prompt)   ─────────────────────────────► próg 0,5
             • długość, struktura                       simple │ complex
             • słowa-klucze („sformatuj” vs „architektur”) │        │
             • rozmiar repo (git ls-files)               ▼        ▼
             • opcjonalnie klasyfikator-modelem      model      chmura
                                                      lokalny      │
                                                         │        └─ rola bez zmian
                                        rola ollama-local + {model} + OLLAMA_HOST
```

- **Wymuszenia** (priorytet): operator (`--tier local|cloud`, select w UI) > projekt **wrażliwy** > preferencja roli (`tier`) > tryb globalny (`auto` / `local-only` / `cloud-only`).
- **Uczciwość:** jeśli Ollama nie odpowiada albo **skonfigurowany model nie jest pobrany**, decyzja automatyczna schodzi do chmury *z ostrzeżeniem*, a decyzja wymuszona **blokuje run** (nic nie idzie do chmury wbrew woli operatora).
- **Role wbudowane** (`demo`, `ollama-local`) są pomijane — to świadomy wybór operatora, router ich nie podmienia.
- **Audyt i pomiar:** każdy run zapisuje `route_tier`, `route_model` i pełne `route_json` (sygnały, powód, ostrzeżenia); `agentdock cli routing` i karta w UI pokazują rozkład „lokalnie / chmura / koszt chmury”.

Ustawienia w `config.json` → `routing` (rola i model lokalny, próg, klasyfikator). Sprawdzone na żywo: proste zadanie → `qwen2.5-coder:7b` odpowiedział w 2 s, koszt API `n/d`.

### Co nowego (Ouroboros Faza 1–2)

| Funkcja | Jak używać |
|---|---|
| **Sejf kluczy API** | UI → *Klucze API* (dodaj/rotuj/wyłącz), albo `agentdock.cmd cli keys add <etykieta> --env ANTHROPIC_API_KEY --provider anthropic`. Sekrety szyfrowane DPAPI, nigdy nie pokazywane |
| **Role agentów w bazie** | UI → *Role agentów* (formularz + przypisanie kluczy), albo `agentdock.cmd cli agents add researcher --command claude --args "--print" --stdin`. Nowa rola działa **bez restartu** |
| **Brak sekretów w środowisku hosta** | agent dostaje tylko to, co ma przypisane w sejfie; nazwy sekretopodobne w polu „zmienne” są odrzucane |
| **Jawna dostawa gałęzi** | `delivery_state` w szczegółach runu (`pushed`, `skipped_no_commits`, `skipped_cancelled`, `skipped_disabled`, `failed`) + `--no-push` w CLI |
| **Smart Router** | `agentdock.cmd cli routing` (stan + sonda Ollamy), `--tier auto\|local\|cloud` w `run`, karta „Smart Router” w UI; projekt można oznaczyć jako **wrażliwy** (checkbox) — wtedy tylko model lokalny |
| **Migracje schematu** | automatyczne przy starcie (`user_version`), bez utraty historii |

```text
repo + zadanie
      │
      ▼
świeży git worktree na własnej gałęzi (Twój checkout zostaje nietknięty)
      │
      ▼
proces agenta w Windows Job Object: limit pamięci, limit procesów,
ubijanie całego drzewa przy zamknięciu, allowlist zmiennych środowiskowych
      │
      ├── strumień zdarzeń na żywo (SSE) → UI
      ├── limit czasu + anulowanie
      └── commit szczątków po awarii/timeoucie
      │
      ▼
gałąź `agentdock/run-<id>` wypchnięta na origin
```

---

## Szybki start

```bat
agentdock.cmd start        :: start UI w tle + otwarcie przeglądarki z tokenem
agentdock.cmd demo         :: repo demo + pełny run, bez żadnego klucza API
agentdock.cmd status       :: sondy, projekty, runy
agentdock.cmd stop         :: zatrzymanie
```

Pierwszy kontakt bez konfiguracji (`agentdock.cmd demo`) wygląda tak:

```text
projekt demo: prj_mue...  (C:\Users\Piotr\.agentdock\demo\repo)
run run_mue... wystartował — oglądam przebieg:

· run zakolejkowany (agent: demo, projekt: demo)
· worktree gotowy: ...\worktrees\run_mue... (gałąź agentdock/run-mue...)
· uruchamiam agenta: ... --demo-agent
· run wystartował (pid 146548, limity: win32-job, 2048 MB)
> {"type":"assistant","message":{...}}
! demo-agent: commit wykonany przez agenta
· gałąź agentdock/run-mue... wypchnięta na origin
· worktree posprzątany (gałąź zostaje w repo)
· run zakończony: succeeded | commity: 1, pliki: 2 (+12/-4) | koszt: $0.0004

gałęzie w origin:
agentdock/run-mue...
main
```

---

## Cykl życia runu

| Stan | Co się dzieje |
|---|---|
| `queued` | wiersz runu zamrożony (agent, prompt, limity); czeka na wolny slot |
| `preparing` | fetch bazy, `git worktree add -b agentdock/run-<id>`, plik promptu, per-run git config |
| `running` | proces agenta w Job Object, stdout/stderr → zdarzenia w SQLite + SSE |
| `finalizing` | commit tego, co agent zostawił, statystyki diffa, push gałęzi, sprzątanie worktree |
| `succeeded` / `failed` / `cancelled` | stan terminalny + powód + koszt/tokeny (jeśli agent je raportuje) |

Trzy decyzje projektowe (świadomie takie same jak w warrenie):

1. **Parametry runu są zamrożone przy dispatchu** — zmiana konfiguracji w trakcie nie mutuje runu.
2. **Wypchnięta gałąź jest gwarantowanym efektem** — po sukcesie i po porażce (ratujemy pracę). Po **anulowaniu celowo nie pushujemy**: nie wysyłamy połowicznej pracy.
3. **Finalizacja ratuje szczątki** — cokolwiek agent zostawił niezacommitowane, staje się commitem.

---

## Izolacja: co Windows realnie daje, a czego nie

Agent działa w osobnym procesie z ograniczeniami narzuconymi przez **Windows Job Object** (`bun:ffi` → `kernel32.dll`):

| Mechanizm | Efekt | Odpowiednik w warrenie (Linux) |
|---|---|---|
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` | proces agenta dostaje OOM, nie cała maszyna | cgroup `memory.max` |
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | maks. 64 procesy w jobie | limity procesów |
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | zamknięcie uchwytu ubija **całe drzewo**, zero sierot | ubijanie procesu grupowego |
| allowlist env | agent **nie dziedziczy** Twoich zmiennych (klucze, tokeny) | profile env w sandboxie |
| per-run `GIT_CONFIG_GLOBAL` | brak credential helperów i globalnego configu użytkownika | tożsamość gita per run |
| `git worktree` per run | brak współdzielonego katalogu roboczego; Twój checkout jest bezpieczny | worktree + branch |
| timeout + cancel | `TerminateJobObject` ubija drzewo natychmiast | cancel/kill |

**Czego nie ma (świadomie, i dlaczego):**

- **Jaila systemu plików.** Agent widzi cały dysk. Windows nie ma odpowiednika `bwrap`/`bubblewrap`, który dałoby się podnieść bez kontenera albo AppContainer. Uczciwa odpowiedź: jeśli potrzebujesz granicy plików/urządzeń, użyj warrena z runtime `docker` lub `k8s` — tam granicą jest kontener/pod.
- **Odcięcia sieci.** Nie ma firewalla per proces; sandbox sieciowy wymagałby WFP albo kontenera.
- **Ograniczeń CPU.** Job Object umie limit czasu procesora, ale nie kwotę CPU jak cgroups — nie udajemy, że to jest.

Te ograniczenia są wypisane także w UI (`izolacja: Job Object (limity OS)`) i w `agentdock doctor`.

---

## Agenci

Definicje żyją w `%USERPROFILE%\.agentdock\config.json` (tworzony przy pierwszym starcie):

```json
{
  "port": 8787,
  "token": "<generowany losowo>",
  "maxConcurrent": 2,
  "memoryLimitMb": 2048,
  "timeoutSec": 1800,
  "branchPrefix": "agentdock/run-",
  "agents": {
    "demo":   { "command": "{self}", "args": ["--demo-agent"], "stdinPrompt": true, "builtin": true },
    "claude": { "command": "claude", "args": ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"], "stdinPrompt": true,
                "env": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"] },
    "codex":  { "command": "codex", "args": ["exec", "--full-auto", "{prompt}"], "env": ["OPENAI_API_KEY"] },
    "aider":  { "command": "aider", "args": ["--yes-always", "--no-auto-commits", "--message", "{prompt}"], "env": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] }
  }
}
```

- `{self}` = sam AgentDock jako agent (wbudowany **agent demo**: symuluje coding-agenta, pisze plik, loguje w formacie `stream-json`, więc parsowanie kosztu/tokenów jest testowane na prawdziwym kształcie danych).
- Placeholdery w argumentach: `{prompt}`, `{promptFile}`, `{workspace}`, `{runId}`.
- `stdinPrompt: true` → zadanie leci na stdin dziecka (tak działa `claude --print`).
- `env` → **dodatkowe** zmienne przepuszczane do agenta (poza bazową allowlistą). Reszta środowiska jest odcinana.
- Agent bez binarki w PATH nie wywala niczego — `doctor` i UI pokazują „brak w PATH”.

Aby użyć prawdziwego agenta, wystarczy mieć jego CLI w PATH i klucz w środowisku, np.:

```bat
setx ANTHROPIC_API_KEY "sk-ant-..."
agentdock.cmd start
agentdock.cmd cli run -p "Dodaj walidację formularza i test" --agent claude
```

Knobs wbudowanego agenta demo (przydatne do testów): `[sleep_ms=N]`, `[mem_mb=N]` (test limitu pamięci), `[fail]`, `[commit]`, `[silent]`.

---

## UI

`http://127.0.0.1:8787` (po `agentdock.cmd start` otwiera się samo, z tokenem w URL):

- **Projekty** — dodawanie lokalnej ścieżki albo URL-a (klonuje do `~/.agentdock/repos`),
- **Agenci** — kto jest gotowy, kto jest tylko wbudowany,
- **Nowy run** — projekt, agent, prompt, limit pamięci i czasu,
- **Runy** — stan, czas, commity, push, koszt; klik → szczegóły,
- **Szczegóły** — metryki, prompt, przycisk **Anuluj**, log na żywo (SSE),
- nagłówek pokazuje tryb limitów (`Job Object ✓`) i liczbę aktywnych runów.

---

## CLI

```bat
agentdock.cmd cli --help
agentdock.cmd cli doctor
agentdock.cmd cli projects                       :: lista
agentdock.cmd cli projects add "C:\praca\repo"   :: rejestracja lokalnego repo
agentdock.cmd cli projects add https://github.com/owner/repo.git
agentdock.cmd cli run -p "zadanie" --agent demo  :: dispatch + podgląd zdarzeń
agentdock.cmd cli run -p "zadanie" --memory 512 --timeout 120 --no-follow
agentdock.cmd cli runs --limit 20
agentdock.cmd cli show <run-id> | tail <run-id> | cancel <run-id>
```

Run obsługuje ten proces, który jest gospodarzem: **serwer** (jeśli działa — wtedy run przeżyje zamknięcie CLI) albo **CLI** (jeśli serwer jest wyłączony). Oba piszą do tej samej bazy, więc historia jest wspólna.

---

## Dane, build, testy

| Ścieżka | Zawartość |
|---|---|
| `%USERPROFILE%\.agentdock\config.json` | konfiguracja, token, agenci, limity |
| `%USERPROFILE%\.agentdock\agentdock.db` | projekty, runy, zdarzenia (SQLite, WAL) |
| `%USERPROFILE%\.agentdock\worktrees\<run-id>` | workspace runu (kasowany po finalizacji) |
| `%USERPROFILE%\.agentdock\runs\<run-id>\` | `prompt.md`, `gitconfig`, `transcript.log` |
| `%USERPROFILE%\.agentdock\repos\` | klony projektów dodanych przez URL |
| `%USERPROFILE%\.agentdock\demo\` | repo demo + jego lokalny `origin.git` |

```bat
agentdock.cmd test         :: bun test (13 testów: usage, Job Object, projekty, E2E runu)
agentdock.cmd build        :: agentdock.exe — jeden plik (~86 MB, zawiera runtime Bun)
agentdock.cmd shortcut     :: skrót AgentDock.lnk na pulpicie
```

Cały katalog danych można skasować jednym poleceniem — aplikacja nie pisze nic poza `~/.agentdock`.

---

## AgentDock vs Warren

| | AgentDock | Warren |
|---|---|---|
| Platforma | Windows, natywnie | macOS/Linux (+ Docker/K8s) |
| Granica izolacji | worktree + Job Object + env allowlist | `bwrap`, kontener obok, pod K8s |
| Jail systemu plików | nie | tak |
| Harnessy | dowolne CLI (presety: claude, codex, aider) + agent demo | adaptery Pi i Claude Code |
| Forge / PR | push gałęzi na origin (PR robisz sam) | GitHub App/PAT, PR, auto-merge |
| Tracker, preview, plan-runs, analityka | nie | tak |
| Wielu użytkowników / RBAC | nie (loopback + token) | świadomie też nie (jeden operator) |
| Uruchomienie | `agentdock.cmd start` / `agentdock.exe` | `warren up` / compose / K8s |

Krótko: AgentDock to warren-owy **rdzeń** (run, workspace, izolacja procesu, eventy, finalizacja, push) w wersji, która działa na Twoim pulpicie bez WSL i bez kontenerów — z uczciwie zaznaczonymi granicami tego, co da się zrobić natywnie na Windows.

---

## Możliwe dalsze kroki

- okno aplikacji (WebView2) zamiast karty przeglądarki + ikona w zasobniku,
- piaskownica plików przez **AppContainer** / **Windows Sandbox** dla trybu „podwyższonej izolacji”,
- PR-y przez GitHub API (token), auto-merge, szablony PR — jak w warrenie,
- preview porty dla runów (dev-servery w worktree),
- plan-runs (łańcuchy zadań z bramkami), analityka kosztów, eksport audytu,
- retencja i sprzątanie starych worktree/gałęzi.
