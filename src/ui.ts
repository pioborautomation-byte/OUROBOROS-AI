/**
 * UI aplikacji — jeden plik HTML (bez buildu, bez zależności npm).
 *
 * Trzy widoki (Faza 1 i 2 Ouroborosa):
 *   - Runy     — dispatch, tabela runów, szczegóły z logiem na żywo (SSE),
 *   - Role     — rejestr agentów w bazie (CRUD bez restartu serwera) + przypisanie kluczy,
 *   - Klucze   — sejf kluczy API (sekrety tylko do zapisu; UI widzi etykietę i końcówkę).
 *
 * Zdarzenia DOM obsługujemy delegacją (`data-act`), żeby nie generować
 * onclick-ów z danymi użytkownika — mniej miejsc, w których można się pomylić
 * w escapowaniu.
 */
export const UI_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ouroboros · AgentDock core</title>
<style>
  :root {
    --bg: #0b0f14; --panel: #121821; --panel-2: #172030; --line: #23304a;
    --text: #dfe7f3; --muted: #8b9bb4; --accent: #4da3ff; --ok: #35c48a;
    --warn: #f0b429; --err: #ef6b6b; --mono: "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  header {
    display: flex; align-items: center; gap: 10px; padding: 10px 18px;
    border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 5; flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .5px; }
  header .tag { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  nav { display: flex; gap: 6px; margin-left: 8px; }
  .tab {
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
    padding: 5px 12px; border-radius: 999px; cursor: pointer; font-size: 13px;
  }
  .tab.on { color: var(--text); border-color: var(--accent); background: #16243a; }
  .chip { border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--muted); background: var(--panel-2); }
  .chip.ok { color: var(--ok); border-color: #1d4d3a; }
  .chip.warn { color: var(--warn); border-color: #4d3f1d; }
  .chip.bad { color: var(--err); border-color: #5a2a2a; }
  main { display: grid; grid-template-columns: 320px 1fr; gap: 16px; padding: 16px; align-items: start; }
  section[hidden] { display: none; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
  .card + .card { margin-top: 16px; }
  input, select, textarea, button { font: inherit; color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; width: 100%; }
  textarea { min-height: 84px; resize: vertical; font-family: var(--mono); font-size: 13px; }
  button { cursor: pointer; background: #1d2a3f; }
  button:hover { background: #24334c; }
  button.primary { background: var(--accent); color: #04121f; border-color: var(--accent); font-weight: 600; }
  button.primary:hover { background: #6fb6ff; }
  button.danger { border-color: #5a2a2a; color: #ffb3b3; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.mini { width: auto; padding: 3px 9px; font-size: 12px; }
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  label.inline { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
  label.inline input { width: auto; }
  ul.list { list-style: none; margin: 0; padding: 0; }
  ul.list li { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; background: var(--panel-2); font-size: 13px; }
  ul.list li .sub { color: var(--muted); font-size: 11px; word-break: break-all; }
  ul.list li .del { float: right; color: var(--muted); cursor: pointer; }
  ul.list li .del:hover { color: var(--err); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
  tr.sel { background: #17263c; }
  tbody tr.clickable { cursor: pointer; }
  tbody tr.clickable:hover { background: var(--panel-2); }
  .state { font-weight: 600; }
  .state.succeeded { color: var(--ok); }
  .state.failed { color: var(--err); }
  .state.cancelled { color: var(--muted); }
  .state.running, .state.preparing, .state.finalizing { color: var(--accent); }
  .state.queued { color: var(--warn); }
  #log { font-family: var(--mono); font-size: 12.5px; background: #080c11; border: 1px solid var(--line); border-radius: 8px; padding: 10px; height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  #log .lifecycle { color: #63d7ff; }
  #log .stderr { color: var(--warn); }
  #log .stdout { color: var(--text); }
  #log .seq { color: #3f5570; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 10px 0; }
  .meta div { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  .meta .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
  .meta .v { font-family: var(--mono); font-size: 13px; word-break: break-all; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
  .prompt { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: pre-wrap; background: #080c11; border: 1px solid var(--line); border-radius: 8px; padding: 8px; max-height: 110px; overflow: auto; }
  .empty { color: var(--muted); padding: 10px 0; font-size: 13px; }
  .banner { background: #1a2233; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 0 16px; font-size: 13px; }
  .banner.bad { border-color: #5a2a2a; color: #ffc9c9; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; color: var(--muted); }
  .pill.on { color: var(--ok); border-color: #1d4d3a; }
  .pill.off { color: var(--warn); border-color: #4d3f1d; }
  code { font-family: var(--mono); background: #0d131c; padding: 1px 5px; border-radius: 5px; }
</style>
</head>
<body>
<header>
  <h1>Ouroboros</h1>
  <span class="tag" id="ver"></span>
  <nav>
    <button class="tab on" data-view="runs">Runy</button>
    <button class="tab" data-view="agents">Role agentów</button>
    <button class="tab" data-view="keys">Klucze API</button>
  </nav>
  <span class="spacer"></span>
  <span class="chip" id="chipRouter">router: …</span>
  <span class="chip" id="chipVault">…</span>
  <span class="chip" id="chipLimits">…</span>
  <span class="chip" id="chipActive">…</span>
</header>

<div class="banner bad" id="tokenBanner" style="display:none">
  Brak tokenu operatora — uruchom aplikację przez <code>agentdock.cmd start</code> (otworzy UI z tokenem).
  <div style="margin-top:6px"><input id="tokenInput" placeholder="wklej token z config.json" /><button style="margin-top:6px" data-act="save-token">Zapisz token</button></div>
</div>

<main>
  <div>
    <div class="card">
      <h2>Projekty</h2>
      <ul class="list" id="projects"></ul>
      <label for="projInput">Dodaj projekt (ścieżka do repo git lub URL)</label>
      <div class="row">
        <input id="projInput" placeholder="C:\\praca\\moj-projekt  albo  https://github.com/owner/repo.git" />
        <button style="flex:0 0 90px" data-act="add-project">Dodaj</button>
      </div>
      <div class="hint">Run dostaje własny <code>git worktree</code> — Twój checkout zostaje nietknięty.</div>
    </div>

    <div class="card">
      <h2>Smart Router</h2>
      <div id="routingBody"><div class="empty">Sprawdzam…</div></div>
      <div class="row" style="margin-top:8px">
        <button style="flex:0 0 150px" data-act="routing-refresh">Odśwież sondę</button>
      </div>
      <div class="hint">Ustawienia: <code>config.json</code> → <code>routing</code>. Projekt wrażliwy nigdy nie idzie do chmury.</div>
    </div>

    <div class="card" id="sideAgentsCard">
      <h2>Role</h2>
      <ul class="list" id="sideAgents"></ul>
      <div class="hint">Role żyją w bazie — dodanie nowej działa bez restartu aplikacji.</div>
    </div>
    <div class="card" id="sideKeysCard" hidden>
      <h2>Sejf kluczy</h2>
      <ul class="list" id="sideKeys"></ul>
      <div class="hint">Sekrety szyfrowane DPAPI (konto użytkownika); wartości nie opuszczają procesu.</div>
    </div>
  </div>

  <div>
    <section data-view="runs">
      <div class="card">
        <h2>Nowy run</h2>
        <div class="grid-3">
          <div><label for="fProject">Projekt</label><select id="fProject"></select></div>
          <div><label for="fAgent">Rola</label><select id="fAgent"></select></div>
          <div><label for="fMemory">Limit pamięci (MB)</label><input id="fMemory" type="number" min="128" step="128" /></div>
        </div>
        <label for="fTimeout">Limit czasu (s)</label>
        <input id="fTimeout" type="number" min="10" step="10" />
        <label for="fTier">Model (Smart Router)</label>
        <select id="fTier">
          <option value="auto">auto — router decyduje na podstawie złożoności zadania</option>
          <option value="local">lokalny — wymuś model lokalny (Ollama)</option>
          <option value="cloud">chmurowy — wymuś model w chmurze</option>
        </select>
        <label for="fPrompt">Zadanie dla agenta</label>
        <textarea id="fPrompt" placeholder="np. Dodaj walidację formularza logowania i test jednostkowy."></textarea>
        <label class="inline"><input type="checkbox" id="fPush" checked /> pushuj gałąź na origin po zakończeniu</label>
        <div class="row" style="margin-top:6px">
          <button class="primary" id="btnDispatch" data-act="dispatch">Uruchom run</button>
          <button style="flex:0 0 180px" data-act="fill-demo">Wstaw zadanie demo</button>
        </div>
      </div>

      <div class="card">
        <h2>Runy</h2>
        <div id="runsWrap"><div class="empty">Brak runów.</div></div>
      </div>

      <div class="card" id="detailCard" style="display:none">
        <h2>Szczegóły runu</h2>
        <div class="meta" id="detailMeta"></div>
        <div class="hint" id="detailRoute"></div>
        <div class="row" style="margin:8px 0">
          <button class="danger" style="flex:0 0 140px" id="btnCancel" data-act="cancel-run">Anuluj run</button>
          <button style="flex:0 0 160px" data-act="reload-events">Odśwież log</button>
        </div>
        <div class="prompt" id="detailPrompt"></div>
        <label>Log (na żywo)</label>
        <div id="log"></div>
      </div>
    </section>

    <section data-view="agents" hidden>
      <div class="card">
        <h2>Rola agenta</h2>
        <div class="grid-2">
          <div><label for="aName">Nazwa (klucz)</label><input id="aName" placeholder="np. researcher" /></div>
          <div><label for="aCommand">Komenda</label><input id="aCommand" placeholder="np. claude" /></div>
        </div>
        <label for="aDescription">Opis</label>
        <input id="aDescription" placeholder="np. zbiera dokumentację i zapisuje notatki" />
        <label for="aArgs">Argumenty (jeden na linię; placeholdery: {prompt} {promptFile} {workspace} {runId})</label>
        <textarea id="aArgs" placeholder="--print&#10;--output-format&#10;stream-json"></textarea>
        <div class="grid-2">
          <div><label for="aEnv">Zmienne niesekretne (przecinki)</label><input id="aEnv" placeholder="OLLAMA_HOST,ANTHROPIC_BASE_URL" /></div>
          <div><label for="aKeys">Klucze z sejfu</label><select id="aKeys" multiple size="4"></select></div>
        </div>
        <label for="aTier">Poziom modelu (Smart Router)</label>
        <select id="aTier">
          <option value="auto">auto — decyduje złożoność zadania</option>
          <option value="local">local — ta rola zawsze mówi do modelu lokalnego</option>
          <option value="cloud">cloud — ta rola zawsze wymaga chmury</option>
        </select>
        <label class="inline"><input type="checkbox" id="aStdin" /> prompt trafia na stdin dziecka</label>
        <label class="inline"><input type="checkbox" id="aEnabled" checked /> rola aktywna</label>
        <div class="row" style="margin-top:6px">
          <button class="primary" data-act="agent-save">Zapisz rolę</button>
          <button style="flex:0 0 140px" data-act="agent-reset">Wyczyść formularz</button>
          <button class="danger" style="flex:0 0 140px" id="btnAgentDelete" data-act="agent-delete" disabled>Usuń rolę</button>
        </div>
        <div class="hint">Nazwy sekretopodobne (<code>_KEY</code>, <code>_TOKEN</code>, <code>_SECRET</code>, <code>PASSWORD</code>) są odrzucane w liście zmiennych — używaj sejfu.</div>
      </div>

      <div class="card">
        <h2>Rejestr ról</h2>
        <div id="agentsWrap"><div class="empty">Brak ról.</div></div>
      </div>
    </section>

    <section data-view="keys" hidden>
      <div class="card">
        <h2>Nowy klucz API</h2>
        <div class="grid-3">
          <div><label for="kLabel">Etykieta</label><input id="kLabel" placeholder="np. anthropic-prod" /></div>
          <div><label for="kProvider">Dostawca</label>
            <select id="kProvider">
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
              <option value="google">google</option>
              <option value="ollama">ollama (lokalny)</option>
              <option value="other">inny</option>
            </select>
          </div>
          <div><label for="kEnvVar">Zmienna środowiskowa</label><input id="kEnvVar" placeholder="ANTHROPIC_API_KEY" /></div>
        </div>
        <label for="kSecret">Sekret (zapis nieodwracalny — UI nigdy go nie pokaże)</label>
        <input id="kSecret" type="password" placeholder="sk-…" />
        <div class="row" style="margin-top:10px">
          <button class="primary" data-act="key-save">Dodaj klucz</button>
        </div>
        <div class="hint" id="vaultHint"></div>
      </div>

      <div class="card">
        <h2>Klucze w sejfie</h2>
        <div id="keysWrap"><div class="empty">Sejf jest pusty.</div></div>
        <div class="hint">Przypisanie do roli: zakładka <b>Role agentów</b> → wybierz rolę → zaznacz klucze → Zapisz.</div>
      </div>
    </section>
  </div>
</main>

<script>
var TOKEN = localStorage.getItem("agentdock.token") || "";
var state = { projects: [], agents: [], keys: [], runs: [], limits: {}, vault: {}, stats: {} };
var selectedRun = null;
var editingAgent = null;
var source = null;
var activeView = "runs";

(function initToken() {
  var params = new URLSearchParams(location.search);
  var fromUrl = params.get("token");
  if (fromUrl) {
    TOKEN = fromUrl;
    localStorage.setItem("agentdock.token", fromUrl);
    history.replaceState({}, "", "/");
  }
  if (!TOKEN) document.getElementById("tokenBanner").style.display = "block";
})();

function api(path, options) {
  var opts = options || {};
  var headers = Object.assign({ "authorization": "Bearer " + TOKEN }, opts.headers || {});
  if (opts.body) headers["content-type"] = "application/json";
  return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));
        return body;
      });
    });
}

function esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  var s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}

function fmtMoney(v) { return v == null ? "—" : "$" + Number(v).toFixed(4); }

function fmtTime(iso) { return iso == null ? "—" : String(iso).slice(0, 19).replace("T", " "); }

function renderRouting(routing, ollama, stats) {
  var body = document.getElementById("routingBody");
  if (!routing) { body.innerHTML = '<div class="empty">Brak danych routera.</div>'; return; }
  var ollamaPill = ollama && ollama.available
    ? '<span class="pill on">Ollama: ' + ollama.models.length + ' modeli</span>'
    : '<span class="pill off">Ollama: brak odpowiedzi</span>';
  var warn = (ollama && !ollama.available && routing.enabled)
    ? '<div class="sub" style="color:var(--warn);font-size:12px">' + esc(ollama.error || "brak odpowiedzi") + ' — proste zadania pójdą do chmury z ostrzeżeniem</div>'
    : '';
  var statsLine = stats
    ? '<div class="sub" style="color:var(--muted);font-size:12px">runy: lokalnie ' + stats.local + ' · chmura ' + stats.cloud + ' · koszt chmury $' + Number(stats.cloudCostUsd || 0).toFixed(4) + '</div>'
    : '';
  body.innerHTML =
    '<div style="margin-bottom:6px">' +
      '<span class="pill ' + (routing.enabled ? "on" : "off") + '">' + (routing.enabled ? "włączony" : "wyłączony") + '</span> ' +
      '<span class="pill">tryb ' + esc(routing.mode) + '</span> ' +
      '<span class="pill">' + esc(routing.classifier) + '</span> ' +
      '<span class="pill">próg ' + esc(routing.threshold) + '</span> ' +
      ollamaPill +
    '</div>' +
    '<div class="sub" style="color:var(--muted);font-size:12px">lokalnie: ' + esc(routing.local.model || "(domyślny roli)") + ' → rola ' + esc(routing.local.agent || "(brak)") + '</div>' +
    '<div class="sub" style="color:var(--muted);font-size:12px">adres: ' + esc(routing.local.baseUrl) + '</div>' +
    statsLine + warn;
}

function loadRouting(fresh) {
  api("/api/routing" + (fresh ? "?fresh=1" : "")).then(function (data) {
    renderRouting(data.config, data.ollama, data.stats);
    var chip = document.getElementById("chipRouter");
    chip.textContent = "router: " + (data.config.enabled ? data.config.mode : "off") + (data.ollama.available ? " · lokalny OK" : " · lokalny brak");
    chip.className = "chip " + (data.config.enabled ? (data.ollama.available ? "ok" : "warn") : "");
  }).catch(function () {
    document.getElementById("chipRouter").textContent = "router: brak danych";
  });
}

// --------------------------------------------------------------------- views
function setView(name) {
  activeView = name;
  var tabs = document.querySelectorAll(".tab");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].className = tabs[i].getAttribute("data-view") === name ? "tab on" : "tab";
  }
  var sections = document.querySelectorAll("section[data-view]");
  for (var j = 0; j < sections.length; j++) {
    sections[j].hidden = sections[j].getAttribute("data-view") !== name;
  }
  document.getElementById("sideAgentsCard").hidden = name === "keys";
  document.getElementById("sideKeysCard").hidden = name !== "keys";
  render();
}

// --------------------------------------------------------------------- state
function refresh() {
  api("/api/state").then(function (data) {
    state = data;
    document.getElementById("ver").textContent = "v" + data.version + " · schemat v" + data.schemaVersion;
    var protection = data.vault && data.vault.protection ? data.vault.protection : "?";
    var vaultChip = document.getElementById("chipVault");
    vaultChip.textContent = "sejf: " + protection + " · " + data.keys.length + " kluczy";
    vaultChip.className = "chip " + (protection === "dpapi" ? "ok" : protection === "plain" ? "warn" : "bad");
    document.getElementById("chipLimits").textContent =
      "limit: " + data.limits.memoryLimitMb + " MB · " + data.limits.timeoutSec + "s · równolegle " + data.limits.maxConcurrent +
      (data.limits.jobObjects ? " · Job Object ✓" : " · bez limitów systemowych");
    document.getElementById("chipLimits").className = "chip " + (data.limits.jobObjects ? "ok" : "warn");
    var active = data.runs.filter(function (r) { return ["queued","preparing","running","finalizing"].indexOf(r.state) >= 0; }).length;
    document.getElementById("chipActive").textContent = "aktywne: " + active;
    document.getElementById("chipActive").className = "chip " + (active > 0 ? "ok" : "");
    if (selectedRun) {
      var fresh = data.runs.filter(function (r) { return r.id === selectedRun; })[0];
      if (fresh) renderDetail(fresh);
    }
    render();
  }).catch(function (err) {
    if (String(err.message).indexOf("token") >= 0 || String(err.message).indexOf("401") >= 0) {
      document.getElementById("tokenBanner").style.display = "block";
    }
  });
}

function render() {
  renderProjects();
  renderSideLists();
  if (activeView === "runs") { renderForm(); renderRuns(); }
  if (activeView === "agents") { renderAgentForm(); renderAgents(); }
  if (activeView === "keys") { renderKeys(); }
}

function renderProjects() {
  var el = document.getElementById("projects");
  if (state.projects.length === 0) { el.innerHTML = '<div class="empty">Brak projektów — dodaj repo poniżej.</div>'; return; }
  el.innerHTML = state.projects.map(function (p) {
    return '<li><button class="mini del" data-act="project-rm" data-id="' + esc(p.id) + '">usuń</button>' +
      esc(p.name) +
      (p.sensitive ? ' <span class="pill off">wrażliwy</span>' : '') +
      '<div class="sub">' + esc(p.path) + ' · ' + esc(p.defaultBranch) + '</div>' +
      '<label class="inline" style="margin:6px 0 0"><input type="checkbox" data-act="project-sensitive" data-id="' + esc(p.id) + '"' + (p.sensitive ? " checked" : "") + ' /> wrażliwy: tylko model lokalny</label>' +
      '</li>';
  }).join("");
}

function renderSideLists() {
  var agents = document.getElementById("sideAgents");
  agents.innerHTML = state.agents.length === 0 ? '<div class="empty">Brak ról.</div>' : state.agents.map(function (a) {
    var badge = a.builtin ? "wbudowany" : (a.available ? "gotowy" : "brak w PATH");
    var keys = a.keyLabels.length > 0 ? (" · klucze: " + a.keyLabels.join(", ")) : "";
    return '<li>' + esc(a.name) + ' <span class="sub">· ' + badge + keys + '</span><div class="sub">' + esc(a.description) + '</div></li>';
  }).join("");

  var keys = document.getElementById("sideKeys");
  keys.innerHTML = state.keys.length === 0 ? '<div class="empty">Sejf jest pusty.</div>' : state.keys.map(function (k) {
    return '<li>' + esc(k.label) + ' <span class="sub">· ' + esc(k.provider) + ' · ' + esc(k.envVar) + ' · …' + esc(k.hint) + '</span></li>';
  }).join("");

  document.getElementById("vaultHint").textContent =
    (state.vault && state.vault.protection === "dpapi")
      ? "Sekrety szyfrowane DPAPI (powiązane z kontem Windows). Kopia bazy na innym komputerze nie wystarczy do ich odczytu."
      : (state.vault && state.vault.protection === "plain")
        ? "UWAGA: działasz w trybie jawnym (AGENTDOCK_INSECURE_SECRETS=1) — sekrety leżą w bazie bez szyfrowania."
        : "DPAPI niedostępne — zapis sekretów jest zablokowany.";
}

function renderForm() {
  document.getElementById("fProject").innerHTML = state.projects.map(function (p) {
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
  }).join("");
  var agentSelect = document.getElementById("fAgent");
  var previous = agentSelect.value;
  agentSelect.innerHTML = state.agents.filter(function (a) { return a.enabled; }).map(function (a) {
    return '<option value="' + esc(a.name) + '">' + esc(a.name) + '</option>';
  }).join("");
  if (previous) agentSelect.value = previous;
  if (!agentSelect.value && state.agents.some(function (a) { return a.name === "demo"; })) agentSelect.value = "demo";
  var mem = document.getElementById("fMemory");
  if (!mem.value) mem.value = String(state.limits.memoryLimitMb);
  var to = document.getElementById("fTimeout");
  if (!to.value) to.value = String(state.limits.timeoutSec);
  document.getElementById("btnDispatch").disabled = state.projects.length === 0 || state.agents.length === 0;
}

function renderRuns() {
  var wrap = document.getElementById("runsWrap");
  if (state.runs.length === 0) { wrap.innerHTML = '<div class="empty">Brak runów.</div>'; return; }
  var rows = state.runs.map(function (r) {
    var delivery = r.deliveryState ? '<span class="pill ' + (r.deliveryState === "pushed" ? "on" : r.deliveryState === "failed" ? "off" : "") + '">' + esc(r.deliveryState) + '</span>' : "—";
    return '<tr class="clickable' + (r.id === selectedRun ? " sel" : "") + '" data-act="run-select" data-id="' + esc(r.id) + '">' +
      '<td><span class="state ' + esc(r.state) + '">' + esc(r.state) + '</span></td>' +
      '<td>' + esc(r.agent) + '</td>' +
      '<td>' + esc(r.id) + '</td>' +
      '<td>' + fmtDuration(r.durationMs) + '</td>' +
      '<td>' + (r.commitsAhead == null ? "—" : r.commitsAhead) + '</td>' +
      '<td>' + delivery + '</td>' +
      '<td>' + fmtMoney(r.costUsd) + '</td>' +
      '</tr>';
  }).join("");
  wrap.innerHTML = '<table><thead><tr><th>Stan</th><th>Rola</th><th>Run</th><th>Czas</th><th>Commity</th><th>Dostawa</th><th>Koszt</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function selectRun(id) {
  selectedRun = id;
  document.getElementById("detailCard").style.display = "block";
  var fresh = state.runs.filter(function (r) { return r.id === id; })[0];
  if (fresh) renderDetail(fresh);
  renderRuns();
  attachStream(id);
}

function routeSummary(run) {
  if (!run.routeTier) return "—";
  var model = run.routeModel ? (" · " + run.routeModel) : "";
  var score = run.route && run.route.score != null ? (" · wynik " + Number(run.route.score).toFixed(2)) : "";
  var request = run.routeRequest && run.routeRequest !== "auto" ? (" · wymuszone: " + run.routeRequest) : "";
  return run.routeTier + model + score + request;
}

function renderDetail(run) {
  var keys = run.keysUsed && run.keysUsed.length > 0 ? run.keysUsed.join(", ") : "—";
  document.getElementById("detailMeta").innerHTML = [
    ["stan", run.state], ["rola", run.agent], ["gałąź", run.branch || "—"],
    ["router", routeSummary(run)],
    ["commity", run.commitsAhead == null ? "—" : String(run.commitsAhead)],
    ["pliki", run.filesChanged == null ? "—" : (run.filesChanged + " (+" + run.insertions + "/-" + run.deletions + ")")],
    ["dostawa", (run.deliveryState || "—") + (run.pushError ? (" · " + run.pushError) : "")],
    ["koszt", fmtMoney(run.costUsd) + (run.tokensIn ? (" · " + run.tokensIn + "/" + run.tokensOut + " tok") : "")],
    ["klucze", keys],
    ["limit", (run.memoryLimitMb || "—") + " MB / " + (run.timeoutSec || "—") + "s"],
    ["izolacja", run.jobKind === "win32-job" ? "Job Object (limity OS)" : (run.jobKind || "—")],
    ["błąd", run.failureReason || "—"]
  ].map(function (pair) {
    return '<div><div class="k">' + pair[0] + '</div><div class="v">' + esc(pair[1]) + '</div></div>';
  }).join("");
  var route = run.route || null;
  var routeEl = document.getElementById("detailRoute");
  if (route) {
    var signals = (route.signals || []).map(function (s) {
      return '<span class="pill">' + esc(s.name) + ' ' + (s.delta > 0 ? "+" : "") + esc(s.delta) + '</span>';
    }).join(" ");
    var warnings = (route.warnings || []).map(function (w) { return '<div style="color:var(--warn)">! ' + esc(w) + '</div>'; }).join("");
    routeEl.innerHTML =
      '<div>router: ' + esc(route.reason || "—") + '</div>' +
      '<div>sygnały: ' + (signals || '—') + '</div>' +
      warnings +
      (route.effectiveAgent && route.effectiveAgent !== run.agent ? '<div>rola efektywna: ' + esc(route.effectiveAgent) + '</div>' : '');
  } else {
    routeEl.innerHTML = '<div>router: nieaktywny dla tego runu</div>';
  }
  document.getElementById("detailPrompt").textContent = run.prompt;
  var active = ["queued","preparing","running","finalizing"].indexOf(run.state) >= 0;
  document.getElementById("btnCancel").disabled = !active;
}

function attachStream(runId) {
  if (source) { source.close(); source = null; }
  var log = document.getElementById("log");
  log.innerHTML = "";
  source = new EventSource("/api/runs/" + encodeURIComponent(runId) + "/events?token=" + encodeURIComponent(TOKEN));
  source.onmessage = function (ev) {
    var e = JSON.parse(ev.data);
    var cls = e.kind === "lifecycle" ? "lifecycle" : (e.stream === "stderr" ? "stderr" : "stdout");
    var nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML += '<span class="seq">' + e.seq + '</span> <span class="' + cls + '">' + esc(e.text) + '</span>\\n';
    if (nearBottom) log.scrollTop = log.scrollHeight;
  };
}

// --------------------------------------------------------------------- agenci
function renderAgentForm() {
  var select = document.getElementById("aKeys");
  select.innerHTML = state.keys.map(function (k) {
    return '<option value="' + esc(k.id) + '">' + esc(k.label) + ' (' + esc(k.envVar) + ')</option>';
  }).join("");
}

function fillAgentForm(name) {
  if (!name) {
    editingAgent = null;
    document.getElementById("aName").value = "";
    document.getElementById("aName").disabled = false;
    document.getElementById("aDescription").value = "";
    document.getElementById("aCommand").value = "";
    document.getElementById("aArgs").value = "";
    document.getElementById("aEnv").value = "";
    document.getElementById("aStdin").checked = false;
    document.getElementById("aEnabled").checked = true;
    document.getElementById("aTier").value = "auto";
    document.getElementById("btnAgentDelete").disabled = true;
    var options = document.getElementById("aKeys").options;
    for (var i = 0; i < options.length; i++) options[i].selected = false;
    return;
  }
  var agent = state.agents.filter(function (a) { return a.name === name; })[0];
  if (!agent) return;
  editingAgent = name;
  document.getElementById("aName").value = agent.name;
  document.getElementById("aName").disabled = true;
  document.getElementById("aDescription").value = agent.description || "";
  document.getElementById("aCommand").value = agent.command;
  document.getElementById("aArgs").value = (agent.args || []).join("\\n");
  document.getElementById("aEnv").value = (agent.env || []).join(",");
  document.getElementById("aStdin").checked = agent.stdinPrompt === true;
  document.getElementById("aEnabled").checked = agent.enabled === true;
  document.getElementById("aTier").value = agent.tier || "auto";
  document.getElementById("btnAgentDelete").disabled = agent.builtin === true;
  var options2 = document.getElementById("aKeys").options;
  for (var j = 0; j < options2.length; j++) {
    options2[j].selected = (agent.keyIds || []).indexOf(options2[j].value) >= 0;
  }
}

function collectAgentForm() {
  var argsText = document.getElementById("aArgs").value;
  var args = argsText.split("\\n").map(function (line) { return line.trim(); }).filter(function (line) { return line.length > 0; });
  var envText = document.getElementById("aEnv").value;
  var env = envText.split(",").map(function (name) { return name.trim(); }).filter(function (name) { return name.length > 0; });
  var select = document.getElementById("aKeys");
  var keyIds = [];
  for (var i = 0; i < select.options.length; i++) {
    if (select.options[i].selected) keyIds.push(select.options[i].value);
  }
  return {
    name: document.getElementById("aName").value.trim(),
    description: document.getElementById("aDescription").value.trim(),
    command: document.getElementById("aCommand").value.trim(),
    args: args,
    env: env,
    stdinPrompt: document.getElementById("aStdin").checked,
    enabled: document.getElementById("aEnabled").checked,
    tier: document.getElementById("aTier").value === "auto" ? null : document.getElementById("aTier").value,
    keyIds: keyIds
  };
}

function saveAgent() {
  var payload = collectAgentForm();
  var keyIds = payload.keyIds;
  delete payload.keyIds;
  var request = editingAgent === null
    ? api("/api/agents", { method: "POST", body: JSON.stringify(payload) })
    : api("/api/agents/" + encodeURIComponent(editingAgent), { method: "PUT", body: JSON.stringify(payload) });
  request.then(function (data) {
    var name = data.agent.name;
    return api("/api/agents/" + encodeURIComponent(name) + "/keys", { method: "PUT", body: JSON.stringify({ keyIds: keyIds }) });
  }).then(function () {
    fillAgentForm(null);
    refresh();
  }).catch(function (err) { alert("Nie udało się zapisać roli: " + err.message); });
}

function deleteAgent() {
  if (!editingAgent) return;
  if (!confirm("Usunąć rolę " + editingAgent + "?")) return;
  api("/api/agents/" + encodeURIComponent(editingAgent), { method: "DELETE" }).then(function () {
    fillAgentForm(null);
    refresh();
  }).catch(function (err) { alert("Nie udało się usunąć roli: " + err.message); });
}

function renderAgents() {
  var wrap = document.getElementById("agentsWrap");
  if (state.agents.length === 0) { wrap.innerHTML = '<div class="empty">Brak ról.</div>'; return; }
  var rows = state.agents.map(function (a) {
    var keys = a.keyLabels.length === 0 ? "—" : a.keyLabels.join(", ");
    var flags = (a.builtin ? '<span class="pill">wbudowany</span> ' : "") +
      (a.enabled ? '<span class="pill on">aktywna</span>' : '<span class="pill off">wyłączona</span>') +
      (a.tier ? ' <span class="pill">' + esc(a.tier) + '</span>' : "") +
      (a.available ? "" : ' <span class="pill off">brak w PATH</span>');
    return '<tr><td><b>' + esc(a.name) + '</b><div class="hint">' + esc(a.description) + '</div></td>' +
      '<td><code>' + esc(a.command) + '</code><div class="hint">' + esc((a.args || []).join(" ")) + '</div></td>' +
      '<td>' + esc(keys) + '</td><td>' + flags + '</td>' +
      '<td><button class="mini" data-act="agent-edit" data-name="' + esc(a.name) + '">edytuj</button></td></tr>';
  }).join("");
  wrap.innerHTML = '<table><thead><tr><th>Rola</th><th>Komenda</th><th>Klucze</th><th>Stan</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// --------------------------------------------------------------------- klucze
function renderKeys() {
  var wrap = document.getElementById("keysWrap");
  if (state.keys.length === 0) { wrap.innerHTML = '<div class="empty">Sejf jest pusty.</div>'; return; }
  var rows = state.keys.map(function (k) {
    var boundTo = state.agents.filter(function (a) { return (a.keyIds || []).indexOf(k.id) >= 0; }).map(function (a) { return a.name; });
    return '<tr><td><b>' + esc(k.label) + '</b><div class="hint">' + esc(k.id) + '</div></td>' +
      '<td>' + esc(k.provider) + '</td>' +
      '<td><code>' + esc(k.envVar) + '</code></td>' +
      '<td>…' + esc(k.hint) + '</td>' +
      '<td><span class="pill ' + (k.protection === "dpapi" ? "on" : "off") + '">' + esc(k.protection) + '</span></td>' +
      '<td>' + esc(boundTo.length === 0 ? "—" : boundTo.join(", ")) + '</td>' +
      '<td>' + fmtTime(k.lastUsedAt) + '</td>' +
      '<td>' + (k.disabled ? '<span class="pill off">wyłączony</span>' : '<span class="pill on">aktywny</span>') + '</td>' +
      '<td><button class="mini" data-act="key-rotate" data-id="' + esc(k.id) + '">rotuj</button> ' +
      '<button class="mini" data-act="key-toggle" data-id="' + esc(k.id) + '" data-disabled="' + (k.disabled ? "0" : "1") + '">' + (k.disabled ? "włącz" : "wyłącz") + '</button> ' +
      '<button class="mini danger" data-act="key-rm" data-id="' + esc(k.id) + '">usuń</button></td></tr>';
  }).join("");
  wrap.innerHTML = '<table><thead><tr><th>Etykieta</th><th>Dostawca</th><th>Zmienna</th><th>Końcówka</th><th>Ochrona</th><th>Przypisany do</th><th>Ostatnio użyty</th><th>Stan</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function saveKey() {
  var body = {
    label: document.getElementById("kLabel").value.trim(),
    provider: document.getElementById("kProvider").value,
    envVar: document.getElementById("kEnvVar").value.trim(),
    secret: document.getElementById("kSecret").value
  };
  if (body.secret === "") { alert("Podaj sekret."); return; }
  api("/api/keys", { method: "POST", body: JSON.stringify(body) }).then(function () {
    document.getElementById("kLabel").value = "";
    document.getElementById("kEnvVar").value = "";
    document.getElementById("kSecret").value = "";
    refresh();
  }).catch(function (err) { alert("Nie udało się dodać klucza: " + err.message); });
}

// --------------------------------------------------------------------- akcje
document.addEventListener("click", function (event) {
  var target = event.target.closest ? event.target.closest("[data-act], .tab") : null;
  if (!target) return;
  var view = target.getAttribute("data-view");
  if (view && target.className.indexOf("tab") >= 0) { setView(view); return; }
  var act = target.getAttribute("data-act");
  if (!act) return;

  if (act === "save-token") {
    var value = document.getElementById("tokenInput").value.trim();
    if (!value) return;
    localStorage.setItem("agentdock.token", value);
    location.reload();
    return;
  }
  if (act === "add-project") {
    var input = document.getElementById("projInput");
    var raw = input.value.trim();
    if (!raw) return;
    var body = /^(https?:\\/\\/|git@|ssh:\\/\\/|file:\\/\\/)/i.test(raw) ? { url: raw } : { path: raw };
    api("/api/projects", { method: "POST", body: JSON.stringify(body) })
      .then(function () { input.value = ""; refresh(); })
      .catch(function (err) { alert("Nie udało się dodać projektu: " + err.message); });
    return;
  }
  if (act === "project-rm") {
    api("/api/projects/" + encodeURIComponent(target.getAttribute("data-id")), { method: "DELETE" }).then(refresh);
    return;
  }
  if (act === "routing-refresh") { loadRouting(true); return; }
  if (act === "project-sensitive") {
    api("/api/projects/" + encodeURIComponent(target.getAttribute("data-id")), {
      method: "PATCH",
      body: JSON.stringify({ sensitive: target.checked === true })
    }).then(refresh).catch(function (err) { alert("Nie udało się zmienić oznaczenia: " + err.message); });
    return;
  }
  if (act === "dispatch") {
    var payload = {
      projectId: document.getElementById("fProject").value,
      agent: document.getElementById("fAgent").value,
      prompt: document.getElementById("fPrompt").value,
      memoryLimitMb: Number(document.getElementById("fMemory").value) || undefined,
      timeoutSec: Number(document.getElementById("fTimeout").value) || undefined,
      push: document.getElementById("fPush").checked,
      tier: document.getElementById("fTier").value
    };
    document.getElementById("btnDispatch").disabled = true;
    api("/api/runs", { method: "POST", body: JSON.stringify(payload) }).then(function (data) {
      document.getElementById("btnDispatch").disabled = false;
      selectRun(data.run.id);
      refresh();
    }).catch(function (err) {
      document.getElementById("btnDispatch").disabled = false;
      alert("Nie udało się uruchomić runu: " + err.message);
    });
    return;
  }
  if (act === "fill-demo") {
    document.getElementById("fPrompt").value =
      "Dodaj plik NOTATKA.md z krótkim opisem repozytorium i wypisz, co zmieniłeś.";
    return;
  }
  if (act === "run-select") { selectRun(target.getAttribute("data-id")); return; }
  if (act === "cancel-run") {
    if (!selectedRun) return;
    api("/api/runs/" + encodeURIComponent(selectedRun) + "/cancel", { method: "POST" })
      .then(refresh)
      .catch(function (err) { alert("Nie udało się anulować: " + err.message); });
    return;
  }
  if (act === "reload-events") {
    if (!selectedRun) return;
    api("/api/runs/" + encodeURIComponent(selectedRun)).then(function (data) {
      renderDetail(data.run);
      var log = document.getElementById("log");
      log.innerHTML = data.events.map(function (e) {
        var cls = e.kind === "lifecycle" ? "lifecycle" : (e.stream === "stderr" ? "stderr" : "stdout");
        return '<span class="seq">' + e.seq + '</span> <span class="' + cls + '">' + esc(e.text) + '</span>';
      }).join("\\n");
      log.scrollTop = log.scrollHeight;
    });
    return;
  }
  if (act === "agent-edit") { fillAgentForm(target.getAttribute("data-name")); return; }
  if (act === "agent-save") { saveAgent(); return; }
  if (act === "agent-reset") { fillAgentForm(null); return; }
  if (act === "agent-delete") { deleteAgent(); return; }
  if (act === "key-save") { saveKey(); return; }
  if (act === "key-rm") {
    if (!confirm("Usunąć klucz? Role, które go używały, stracą dostęp.")) return;
    api("/api/keys/" + encodeURIComponent(target.getAttribute("data-id")), { method: "DELETE" }).then(refresh);
    return;
  }
  if (act === "key-toggle") {
    api("/api/keys/" + encodeURIComponent(target.getAttribute("data-id")), {
      method: "PUT",
      body: JSON.stringify({ disabled: target.getAttribute("data-disabled") === "1" })
    }).then(refresh).catch(function (err) { alert(err.message); });
    return;
  }
  if (act === "key-rotate") {
    var secret = prompt("Nowy sekret dla klucza (zostanie zapisany, stary przestanie działać):");
    if (!secret) return;
    api("/api/keys/" + encodeURIComponent(target.getAttribute("data-id")), {
      method: "PUT",
      body: JSON.stringify({ secret: secret })
    }).then(refresh).catch(function (err) { alert(err.message); });
    return;
  }
});

refresh();
loadRouting(false);
setInterval(refresh, 3000);
setInterval(function () { loadRouting(false); }, 60000);
</script>
</body>
</html>
`;
