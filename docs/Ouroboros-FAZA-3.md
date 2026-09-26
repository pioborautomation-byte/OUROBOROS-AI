# Ouroboros — raport z wdrożenia Fazy 3 (Smart Router / Estimator)

| | |
|---|---|
| **Dokument** | raport implementacyjny Fazy 3: decyzja „model lokalny czy chmura” |
| **Data** | 2026-09-24 |
| **Zakres** | migracja v4, moduł `src/router.ts`, integracja w runnerze, API/CLI/UI, testy |
| **Wynik testów** | **47/47 pass** (3 pliki, 160 asercji, ~17 s); `bun run typecheck` czysty |
| **Dowód na żywo** | prawdziwy run na modelu lokalnym (`qwen2.5-coder:7b` przez Ollamę): decyzja → zamiana roli → odpowiedź w 2 s → koszt API `n/d` |
| **Dokumenty pokrewne** | [`Ouroboros-FAZA-1-2.md`](Ouroboros-FAZA-1-2.md), [`AgentDock-DOKUMENTACJA.md`](AgentDock-DOKUMENTACJA.md), [`AgentDock-BRIEF-DLA-LLM.md`](AgentDock-BRIEF-DLA-LLM.md) |

---

## 0. Mapa briefu: co jest zrobione

| Element briefu | Stan | Dowód |
|---|---|---|
| „moduł-bramka analizujący stopień skomplikowania zadania” | **ZAIMPLEMENTOWANE** | `src/router.ts` → `scorePrompt()` (deterministyczne sygnały z wagami) + `decideRoute()` |
| „proste zadania → lokalne darmowe modele na Windowsie (np. Ollama)” | **ZAIMPLEMENTOWANE** | sonda `GET /api/tags`, rola `ollama-local` (`ollama run {model} {prompt}`), kontrola pobrania modelu |
| „zadania wymagające wysokiej inteligencji architektonicznej → płatne API” | **ZAIMPLEMENTOWANE** | sygnały złożoności + próg; przy przekroczeniu poziom `cloud` (bez zamiany roli) |
| „decyzja przed uruchomieniem `Bun.spawn`” | **ZAIMPLEMENTOWANE** | decyzja w `Runner.execute()` przed tworzeniem worktree i przed spawnem |
| „oszczędność tokenów” (mierzalna) | **ZAIMPLEMENTOWANE (pomiar)** | kolumny `route_tier`/`route_model`/`route_json` + `db.routingStats()` (lokalnie / chmura / koszt chmury) |
| — (dodatkowo) projekty wrażliwe nie idą do chmury | **ZAIMPLEMENTOWANE** | `projects.sensitive` + wymuszenie poziomu lokalnego + blokada, gdy model lokalny niedostępny |

### Decyzje projektowe przyjęte przy starcie (z poprzedniej rozmowy)

| # | Decyzja | Realizacja |
|---|---|---|
| 1 | klasyfikator **heurystyczny** domyślnie, modelowy jako opcja | `routing.classifier = "heuristic" \| "ollama"`; ścieżka modelowa z twardym fallbackiem do heurystyki |
| 2 | routing przez **env poziomu + zamianę roli**, a nie przez mnożenie ról | `routing.local.agent` / `routing.cloud.agent` + `env` + placeholdery `{model}`, `{tier}` |
| 3 | progi oparte na długości, słowach-kluczach, strukturze i rozmiarze repo | tabela sygnałów w §1 |
| 4 | projekt **wrażliwy** nigdy do chmury | `projects.sensitive`, wymuszenie poziomu, blokada bez modelu lokalnego |

---

## 1. Model decyzyjny

### 1.1 Sygnały złożoności (deterministyczne, z wagami)

`scorePrompt()` zwraca wynik 0..1 **razem z listą sygnałów**, więc decyzja jest audytowalna (te same sygnały widzi UI i `route_json`):

| Sygnał | Waga | Przykład |
|---|---|---|
| długość zadania | ≤ 120 znaków: **−0,10**; ≤ 600: **+0,05**; > 600: **+0,25** | „Sformatuj README” vs 5-akapitowy brief |
| słowa-klucze **proste** (20+) | **−0,12** za trafienie (min −0,35) | sformatuj, prettier, lint, literówk, komentarz, podsumuj, przetłumacz, readme, changelog, dopisz, rename, summarize, translate, typo |
| słowa-klucze **złożone** (30+) | **+0,18** za trafienie (max +0,70) | architektur, refaktor, przeprojektuj, migracj, optymaliz, wydajnoś, bezpieczeństw, race condition, współbieżn, benchmark, cał-, wszystkie pliki, integracj, kontrakt, plan, analiz, audyt, debug, diagnoz, napraw błąd |
| struktura wieloetapowa | **+0,15** | „następnie”/„potem”/„krok”, ≥ 3 punkty listy, ≥ 3 akapity |
| rozmiar projektu | ≥ 500 plików: **+0,15**; ≤ 50: **−0,10** | `git ls-files` (cache 60 s) |

Wynik jest obcinany do [0, 1]; **próg domyślny 0,5** (`routing.threshold`). Poniżej progu → poziom `local`, powyżej → `cloud`.

Przykłady z testów:
- „Sformatuj plik NOTATKA.md i dopisz komentarz.” → **0,00** → local
- „Przeprojektuj architekturę modułu autoryzacji w całym projekcie, dodaj migracje i zadbaj o bezpieczeństwo.” → **0,60** → cloud

### 1.2 Klasyfikator modelowy (opcja)

`routing.classifier = "ollama"` wysyła do lokalnego modelu pytanie „oceń złożoność 0-100” (`/api/generate`, `temperature: 0`). Gdy model nie odpowiada, zwróci śmieci albo nie ma go na liście — **wracamy do heurystyki** i zapisujemy rozbieżność jako ostrzeżenie w decyzji. Klasyfikator nigdy nie wywraca dispatchu.

### 1.3 Wymuszenia i priorytety

Kolejność: **operator > wrażliwy projekt > preferencja roli > tryb globalny > wynik klasyfikatora**.

| Źródło | Jak ustawić | Efekt |
|---|---|---|
| operator (per run) | `--tier local\|cloud\|auto` (CLI), `{"tier": "..."}` (API), select „Model” (UI) | wymusza poziom; zapis w `route_request` |
| wrażliwy projekt | checkbox przy projekcie w UI → `PATCH /api/projects/:id {sensitive:true}` | wymusza `local`; gdy model lokalny niedostępny → **run zablokowany** z komunikatem |
| preferencja roli | pole „Poziom modelu” w roli (`agents.tier` = `local`/`cloud`) | rola „architekt” może zawsze wymagać chmury, rola `ollama-local` zawsze lokalności |
| tryb globalny | `routing.mode` = `auto` \| `local-only` \| `cloud-only` | wymusza poziom dla wszystkich runów |
| klasyfikator | wynik `scorePrompt` / modelu | decyduje tylko w trybie `auto` bez wymuszeń |

Konflikt „operator wymusza chmurę w wrażliwym projekcie” jest dozwolony (operator jest dorosły), ale **zawsze** kończy się ostrzeżeniem w zdarzeniach i w `route_json`.

### 1.4 Uczciwość wobec modelu lokalnego

Trzy stany, każdy jawnie odnotowany:

| Sytuacja | Zachowanie |
|---|---|
| Ollama odpowiada, model pobrany | poziom lokalny wykonalny |
| Ollama odpowiada, **model nie pobrany** | poziom lokalny niewykonalny; komunikat: `model "x" nie jest pobrany (dostępne: …) — uruchom \`ollama pull x\`` |
| Ollama nie odpowiada | j.w. z adresem i błędem połączenia |
| decyzja **automatyczna** i poziom lokalny niewykonalny | fallback do chmury **z ostrzeżeniem** (run idzie dalej) |
| decyzja **wymuszona** (operator/rola/tryb/wrażliwy projekt) i poziom lokalny niewykonalny | **run zablokowany** — nie udajemy, że model lokalny istnieje |

Kontrolę „czy model jest pobrany” dodano po realnym odkryciu: na maszynie testowej Ollama działała, więc router natychmiast kierował runy lokalnie — a brak tej kontroli oznaczałby ciche `ollama pull` (gigabajty) albo błąd w połowie runu.

---

## 2. Jak poziom jest realizowany

Trzy kanały, w tej kolejności:

1. **Rola docelowa** — `routing.local.agent` (domyślnie `ollama-local`) albo `routing.cloud.agent` (domyślnie `null` = bez zamiany). Zdarzenie: `router: zamieniam rolę X → Y (poziom local)`.
2. **Placeholdery w argumentach roli** — `{model}` (np. `ollama run {model} {prompt}`) i `{tier}`.
3. **Zmienne środowiskowe poziomu** — `routing.local.env` / `routing.cloud.env` (np. `OLLAMA_HOST=127.0.0.1:11434`).

Do tego rola `ollama-local` jest presetem wbudowanym:

```json
"ollama-local": {
  "builtin": true,
  "tier": "local",
  "command": "ollama",
  "args": ["run", "{model}", "{prompt}"],
  "description": "Model lokalny przez Ollama (bezpłatny)…"
}
```

Presety wbudowane dochodzą do istniejącej instalacji **raz na wersję presetów** (`agents.syncPresets(DEFAULT_AGENTS, PRESETS_VERSION)`, znacznik w tabeli `meta`), więc po aktualizacji `ollama-local` pojawił się bez nadpisywania ról użytkownika.

### 2.1 Dlaczego `{prompt}` w argumencie (i co to naprawiło)

Placeholder `{prompt}` był **udokumentowany od początku, ale nigdy nie podstawiany** — runner nie przekazywał `prompt` do zmiennych. Efekt: `ollama run qwen2.5-coder:7b {prompt}` wysyłało do modelu dosłowny tekst `{prompt}`, a presety `codex` (`exec --full-auto {prompt}`) i `aider` (`--message {prompt}`) były w praktyce zepsute. Błąd wyszedł dopiero na prawdziwym runie z modelem lokalnym; poprawka + dwa testy jednostkowe („podstawia {prompt}, {model}, {tier}, {runId}, {promptFile}” i „nieznany placeholder zostaje bez zmian”).

### 2.2 Reguła „rolę wbudowaną pomijam”

Role wbudowane (`demo`, `ollama-local`) to **świadomy wybór operatora** — router ich nie podmienia i nie podejmuje dla nich decyzji (w `route_json` zostaje `null`, w zdarzeniach `router: pomijam rolę wbudowaną "demo"`).

Skąd ta reguła: przy pierwszym uruchomieniu na maszynie z działającą Ollamą prosty prompt na agencie `demo` został przekierowany na `ollama-local`, czyli run zrobił coś innego, niż zlecił operator (i przestał commitować, bo `ollama run` nie jest agentem kodującym). Wymuszenie przez operatora (`--tier local`) nadal działa — wtedy zamiana jest zamierzona.

---

## 3. Dane, API, CLI, UI

### 3.1 Migracja v4 (schemat)

```sql
alter table runs add column route_tier text;      -- local | cloud | null
alter table runs add column route_model text;     -- model wybrany przez router
alter table runs add column route_json text;      -- pełna decyzja (sygnały, powód, ostrzeżenia)
alter table runs add column route_request text;   -- żądanie operatora: auto | local | cloud
alter table agents add column tier text;          -- preferencja modelu roli
alter table projects add column sensitive integer not null default 0;
create table if not exists meta (key text primary key, value text not null);
```

Migracja przeszła na realnej bazie (16 runów z epok 1–2 zachowanych).

Przykład `route_json` z prawdziwego runu:

```json
{
  "tier": "local", "forced": false, "forcedBy": null,
  "requestedAgent": "asystent", "agent": "ollama-local", "effectiveAgent": "ollama-local",
  "model": "qwen2.5-coder:7b", "provider": "ollama",
  "score": 0.0, "threshold": 0.5, "classifier": "heuristic",
  "signals": [
    {"name":"proste","delta":-0.12,"detail":"słowa-klucze: podsumuj"},
    {"name":"długość","delta":-0.1,"detail":"66 znaków (krótkie polecenie)"}
  ],
  "reason": "wynik złożoności 0.00 < próg 0.50 → model lokalny [proste: słowa-klucze: podsumuj; długość: 66 znaków (krótkie polecenie)]",
  "warnings": [], "blocked": false
}
```

### 3.2 API

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/routing[?fresh=1]` | konfiguracja routera, sonda Ollamy (modele + błąd), statystyki; `fresh=1` czyści cache sondy |
| `PATCH` | `/api/projects/:id` | `{sensitive: true|false}` — oznaczenie projektu wrażliwego |
| `POST` | `/api/runs` | nowe pole `tier: "auto" \| "local" \| "cloud"` |
| `GET` | `/api/state` | `routing` (tryb, próg, rola/model lokalny, statystyki), runy z `routeTier/routeModel/routeRequest/route` |

### 3.3 CLI

```bat
agentdock.cmd cli routing [--fresh]        :: konfiguracja + sonda Ollamy + statystyki
agentdock.cmd cli run -p "…" --tier local  :: wymuszenie poziomu
agentdock.cmd cli runs                     :: kolumna roli pokazuje [local]/[cloud]
agentdock.cmd cli show <run-id>            :: linia "router: …" z powodem i ostrzeżeniami
agentdock.cmd cli doctor                   :: sekcja routera: tryb, próg, Ollama, rola lokalna, statystyki
```

### 3.4 UI

- **Karta „Smart Router”** (sidebar): tryb, klasyfikator, próg, stan Ollamy (liczba modeli), rola i model lokalny, statystyki (lokalnie/chmura/koszt chmury), ostrzeżenie gdy poziom lokalny niewykonalny, przycisk „Odśwież sondę”.
- **Chip w nagłówku**: `router: auto · lokalny OK` / `· lokalny brak`.
- **Formularz runu**: select „Model (Smart Router)” — auto / lokalny / chmurowy.
- **Szczegóły runu**: pole `router` (poziom, model, wynik) + blok z sygnałami, ostrzeżeniami i rolą efektywną.
- **Projekty**: checkbox „wrażliwy: tylko model lokalny”.

---

## 4. Testy (co doszło)

`tests/router.test.ts` — 20 testów:

| Grupa | Testy |
|---|---|
| heurystyka (5) | krótkie nisko, architektoniczne wysoko, wieloetapowe > krótkie, determinizm, rozmiar projektu |
| decyzje (9) | prosty→local z rolą, złożony→cloud, brak Ollamy→fallback, wrażliwy→wymuszenie i **blokada**, operator vs wrażliwy (ostrzeżenie), preferencja roli, tryb local-only, klasyfikator > heurystyka, **model niepobrany**, brak roli lokalnej |
| integracja z runnerem (6) | prosty prompt: decyzja + zamiana roli + `{model}` w argv + env poziomu, rola chmurowa zostaje w chmurze, złożone zadanie→chmura, **rola wbudowana pomijana**, `--tier local` respektowane, wrażliwy projekt zablokowany **bez tworzenia worktree** |

Dodatkowo w `tests/agentdock.test.ts`: 2 testy placeholderów (`{prompt}`, `{model}`, `{tier}`, `{promptFile}`, nieznany placeholder).

Razem: **47/47 pass**, `typecheck` czysty.

---

## 5. Dowody na żywo (ta maszyna)

Maszyna ma **działającą Ollamę** z modelami `qwen3:30b-a3b`, `nomic-embed-text:latest`, `qwen2.5-coder:7b` — więc Faza 3 została sprawdzona na prawdziwym modelu lokalnym, nie na atrapie.

**A. Proste zadanie → model lokalny (koszt API = 0):**

```text
$ agentdock routing
Smart Router: włączony · tryb auto · klasyfikator heuristic · próg 0.5
  poziom lokalny: rola ollama-local · model qwen2.5-coder:7b · http://127.0.0.1:11434
  Ollama: odpowiada (3 modeli: qwen3:30b-a3b, nomic-embed-text:latest, qwen2.5-coder:7b)

$ agentdock run -p "Odpowiedz po polsku, w jednym zdaniu: do czego służy plik README?" --agent asystent --no-push
· router: wynik złożoności 0.00 < próg 0.50 → model lokalny [proste: słowa-klucze: podsumuj; długość: 66 znaków] · model: qwen2.5-coder:7b
· router: zamieniam rolę asystent → ollama-local (poziom local)
· uruchamiam agenta: ollama run qwen2.5-coder:7b "Odpowiedz po polsku, w jednym zdaniu: …"
· run wystartował (pid 172568, limity: win32-job, 2048 MB)
> Plik README służy jako instrukcja obsługi dla użytkowników, zawierając informacje o celu projektu …
· run zakończony: succeeded | commity: 0, pliki: 0 (+0/-0) | koszt: n/d | dostawa: skipped_no_commits

run_muifgjr87q2vg1   succeeded   asystent [local]   2s   0 commit
```

**B. Zabezpieczenie: wymuszony model lokalny, którego nie ma na dysku:**

```text
$ agentdock run -p "Krótkie zadanie testowe." --agent asystent --tier local   # (routing.local.model = llama3:70b)
· router: wymuszone (operator) → model lokalny · model: llama3:70b
· router: wymuszony model lokalny jest niedostępny: model "llama3:70b" nie jest pobrany
  (dostępne: qwen3:30b-a3b, nomic-embed-text:latest, qwen2.5-coder:7b) — uruchom `ollama pull llama3:70b`
  — run nie może wystartować bezpiecznie
· run nieudany: router zablokował run: …   (worktree i katalog runu nie powstały)
```

**C. Statystyki** (`GET /api/routing`): `{"local":3,"cloud":0,"unrouted":16,"cloudCostUsd":0}` — 16 runów z epok 1–2 nie miało decyzji (routing wtedy nie istniał), 3 nowe poszły lokalnie.

**Uczciwa uwaga:** rola `ollama-local` to `ollama run …`, czyli **model rozmawiający**, nie agent kodujący — dlatego run kończy się `skipped_no_commits` (brak zmian w repo). To poprawne zachowanie i ważny wniosek dla Fazy 4/5.

---

## 6. Rejestr błędów złapanych w tej fazie

| # | Objaw | Przyczyna | Poprawka |
|---|---|---|---|
| 1 | model lokalny dostał dosłowny tekst `{prompt}` | placeholder udokumentowany, ale **nie przekazywany** w `vars` runnera | dodane `prompt: run.prompt` + 2 testy; naprawia też `codex`/`aider` |
| 2 | rola utworzona z `tier: "cloud"` zachowywała się jak auto | `create()` liczyło `tier`, ale INSERT go nie zapisywał | INSERT rozszerzony o kolumnę `tier` |
| 3 | testy jądra zaczęły padać „losowo” (brak commitów, brak kosztu) | na maszynie działa Ollama → proste prompty szły do roli lokalnej | harness testowy ma router **wyłączony**; testy routera włączają go świadomie z własną sondą |
| 4 | prosty prompt na `demo` uciekał do `ollama-local` | brak reguły o rolach wbudowanych | reguła „rolę wbudowaną pomijam”, wymuszenie operatora nadal działa |
| 5 | router uznawał poziom lokalny za wykonalny bez pobranego modelu | brak kontroli listy modeli | `hasModel()` + komunikat z listą dostępnych modeli i `ollama pull …` |
| 6 | heurystyka nie odróżniała „architektury” od „formatowania” przy progu 0,5 | waga złożonych słów-kluczy za niska (0,14, cap 0,55) | waga 0,18, cap 0,70 (architektoniczne ~0,60) |
| 7 | sygnał „rozmiar projektu” nie dawał się zaobserwować | obcinanie wyniku do 0 przy bardzo prostych promptach | wzmocnione wagi (+0,15 / −0,10) + test na neutralnym promptcie |

---

## 7. Ograniczenia tego etapu

| Luka | Konsekwencja | Kierunek |
|---|---|---|
| `ollama-local` to rola **rozmawiająca** (brak edycji plików) | lokalne zadania nie zmieniają kodu → `skipped_no_commits` | Faza 4/E2: rola lokalna z narzędziami (`aider --model ollama/...`, `opencode`, `continue`) albo własne narzędzia plikowe |
| brak pomiaru **realnej** oszczędności (tylko liczniki i koszt chmury) | „oszczędność” jest szacunkiem (liczba runów lokalnych × średni koszt chmurowy) | dodać `avgCloudCostUsd` i raport „zaoszczędzono ≈ $X” + wykres w UI |
| klasyfikator modelowy jest niesprawdzony na prawdziwej Ollamie w testach automatycznych | ścieżka modelowa ma tylko test fallbacku | test integracyjny `classifier: "ollama"` na maszynie z modelem (opcjonalny, env-gated) |
| routing nie uwzględnia historii kosztów podobnych runów | „estymator” jest nadal heurystyczny | Faza 3.5: sygnał z bazy (`avg cost` dla podobnych promptów/rol) |
| brak sterowania per projekt (np. „ten projekt zawsze local”) | tylko `sensitive` + tryb globalny | rozważyć `projects.routing_mode` |
| `mode: local-only` bez działającej Ollamy zablokuje **wszystkie** runy | świadome, ale ostre | komunikat w UI/doctor jest (jest), warto dodać „wyłącz na chwilę” jednym klikiem |

---

## 8. Co dalej (Faza 4 i 5 z briefu) — z wnioskami z Fazy 3

### Faza 4 — narzędzia zewnętrzne (web)

Wniosek z Fazy 3: **samo skierowanie do modelu lokalnego nie wystarczy**, żeby zadanie zmieniło kod — potrzebne są narzędzia. Dlatego Faza 4 powinna dać narzędzia w sposób, który działa dla obu poziomów:

1. **Serwer MCP wystawiony przez Ouroborosa** (rekomendacja): narzędzia `web.fetch`, `web.search`, `repo.read`, `task.delegate`; harness dostaje `--mcp-config` i sam wywołuje narzędzia. Plusy: jedno miejsce implementacji, działa dla Claude Code i innych klientów MCP, nie piszemy pętli agenta.
2. **Własna pętla tool-calls** dla CLI, które MCP nie znają (np. `ollama run`): przechwytywanie znaczników `TOOL: web.fetch …` z wyjścia i wstrzykiwanie wyniku. Ryzyko: kruche, per-harness.
3. Wspólne zabezpieczenia niezależnie od wariantu: allowlista domen, blokada SSRF (żadnych `127.0.0.1`, `169.254.*`, `file://`, zakresów prywatnych), limit rozmiaru, cache w `runs/<id>/context/web/`, zapis śladu (URL, status, hash) — patrz §15.C w głównej dokumentacji.

### Faza 5 — rój (Blackboard & Swarm)

Rekomendacja: **serializowany rój w jednym worktree**, krok po kroku:

1. `swarm_tasks` (drzewo zadań) + blackboard (`swarm_notes` + pliki `.ouroboros/notes/*.md`),
2. wykonanie sekwencyjne (jeden pisarz w worktree), każdy task = osobny run z własnym kosztem i eventami, ale bez własnego pusha,
3. push robi **korzeń** po ostatnim zadaniu,
4. budżet kosztu na całe drzewo (egzekwowany w `tick()`),
5. dziedziczenie kluczy i limitów przez zadania dzieci.

Kryterium akceptacji: drzewo `researcher → coder → tester` w jednym worktree kończy się **jednym pushem** z commitami wszystkich ról; porażka dziecka zatrzymuje zależne i jest widoczna w UI.

---

## 9. Komendy weryfikacyjne (copy-paste)

```bat
:: stan routera (konfiguracja + sonda Ollamy + statystyki)
agentdock.cmd cli routing --fresh
agentdock.cmd cli doctor

:: prawdziwy run na modelu lokalnym (proste zadanie)
agentdock.cmd cli run -p "Podsumuj, czym jest to repozytorium." --agent asystent --no-push

:: wymuszenie poziomu
agentdock.cmd cli run -p "Zadanie dowolne" --agent asystent --tier local
agentdock.cmd cli run -p "Zadanie dowolne" --agent asystent --tier cloud

:: historia z poziomem modelu
agentdock.cmd cli runs --limit 10
agentdock.cmd cli show <run-id>

:: testy
agentdock.cmd test
bun run typecheck
```

Konfiguracja (`%USERPROFILE%\.agentdock\config.json`):

```json
{
  "routing": {
    "enabled": true,
    "mode": "auto",
    "classifier": "heuristic",
    "threshold": 0.5,
    "classifyModel": "qwen2.5-coder:7b",
    "local": {
      "agent": "ollama-local",
      "model": "qwen2.5-coder:7b",
      "provider": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "env": { "OLLAMA_HOST": "127.0.0.1:11434" }
    },
    "cloud": { "agent": null, "model": null, "provider": null, "env": {} }
  }
}
```
