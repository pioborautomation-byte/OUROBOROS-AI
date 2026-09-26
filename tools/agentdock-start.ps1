# AgentDock - start serwera w tle + czekanie na /healthz.
#
# Ten plik jest celowo ASCII-only: PowerShell 5.1 czyta .ps1 w kodowaniu ANSI,
# wiec polskie znaki w UTF-8 bez BOM lamia parser (Unexpected token).
# Osobny plik zamiast inline -Command, bo przekazywanie sciezek ze spacjami
# przez `cmd -> Start-Process -ArgumentList` gubilo cudzyslowy.
param(
	[Parameter(Mandatory = $true)][string]$Entry,
	[string]$OutLog,
	[string]$ErrLog,
	[int]$WaitSec = 30
)

$ErrorActionPreference = 'Stop'
$bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$dataDir = Join-Path $env:USERPROFILE '.agentdock'
$configPath = Join-Path $dataDir 'config.json'

if (-not (Test-Path $bun)) {
	Write-Host "ERROR: bun not found at $bun (install: irm bun.sh/install.ps1 | iex)"
	exit 1
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
if (-not $OutLog) { $OutLog = Join-Path $dataDir 'server.log' }
if (-not $ErrLog) { $ErrLog = Join-Path $dataDir 'server.err.log' }

function Get-Port {
	if (-not (Test-Path $configPath)) { return 8787 }
	try { return (Get-Content $configPath -Raw | ConvertFrom-Json).port } catch { return 8787 }
}

function Test-Health([int]$p) {
	try {
		$r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/healthz" -f $p) -TimeoutSec 2
		return ($r.StatusCode -eq 200)
	} catch { return $false }
}

# Already running? Do not start a second instance.
$port = Get-Port
if (Test-Health $port) {
	Write-Host ("AgentDock already running: http://127.0.0.1:{0}" -f $port)
	exit 0
}

# Quote the script path inside ArgumentList: spaces in the path would otherwise
# split the argument and bun would try to load "C:\Users\Piotr\Desktop\Ouroboros".
$proc = Start-Process -WindowStyle Hidden -FilePath $bun `
	-ArgumentList @("`"$Entry`"", 'serve') `
	-RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
Write-Host ("started pid {0} (log: {1})" -f $proc.Id, $OutLog)

$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline) {
	if ($proc.HasExited) {
		Write-Host ("process exited with code {0} - check {1}" -f $proc.ExitCode, $ErrLog)
		exit 1
	}
	$port = Get-Port
	if (Test-Health $port) {
		Write-Host ("AgentDock ready: http://127.0.0.1:{0}" -f $port)
		exit 0
	}
	Start-Sleep -Milliseconds 500
}

Write-Host ("server did not become ready in {0}s - check {1}" -f $WaitSec, $ErrLog)
exit 1
