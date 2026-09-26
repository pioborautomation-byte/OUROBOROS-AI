@echo off
rem AgentDock - lokalna aplikacja Windows do uruchamiania agentow kodujacych.
rem
rem   agentdock.cmd                 start UI w tle + otwarcie przegladarki
rem   agentdock.cmd start           to samo, jawnie
rem   agentdock.cmd stop            zatrzymanie serwera, ubija tez drzewo procesow
rem   agentdock.cmd status          stan: sondy, projekty, runy
rem   agentdock.cmd demo            repo demo + pelny run agenta demo, bez klucza API
rem   agentdock.cmd cli <polecenie> np. cli run -p "zadanie" --agent demo
rem   agentdock.cmd ui              otwarcie UI w przegladarce, z tokenem
rem   agentdock.cmd logs            podglad logu serwera, Ctrl-C konczy podglad
rem   agentdock.cmd test            testy
rem   agentdock.cmd build           kompilacja do agentdock.exe, jeden plik
rem   agentdock.cmd shortcut        skrot na pulpicie
rem
rem Cala logika idzie przez etykiety i goto, bez zagniezdzonych blokow if (...),
rem bo nawiasy w tekscie echo wewnatrz bloku lamia parser cmd.
setlocal enabledelayedexpansion

set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
set "APPDIR=%~dp0"
set "SRC=%APPDIR%src\main.ts"
set "HOME_DIR=%USERPROFILE%\.agentdock"
set "PIDFILE=%HOME_DIR%\agentdock.pid"
set "OUTLOG=%HOME_DIR%\server.log"
set "ERRLOG=%HOME_DIR%\server.err.log"

if not exist "%BUN%" goto no_bun

set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"

if /i "%CMD%"=="start" goto do_start
if /i "%CMD%"=="stop" goto do_stop
if /i "%CMD%"=="status" goto do_status
if /i "%CMD%"=="demo" goto do_demo
if /i "%CMD%"=="ui" goto do_ui
if /i "%CMD%"=="logs" goto do_logs
if /i "%CMD%"=="test" goto do_test
if /i "%CMD%"=="build" goto do_build
if /i "%CMD%"=="shortcut" goto do_shortcut
if /i "%CMD%"=="cli" goto do_cli
if /i "%CMD%"=="help" goto do_help
goto usage

:no_bun
echo Nie mam Bun pod "%BUN%".
echo Zainstaluj go raz:  powershell -c "irm bun.sh/install.ps1 ^| iex"
exit /b 1

:do_start
if not exist "%HOME_DIR%" mkdir "%HOME_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%tools\agentdock-start.ps1" -Entry "%SRC%" -OutLog "%OUTLOG%" -ErrLog "%ERRLOG%"
exit /b %errorlevel%

:do_stop
if not exist "%PIDFILE%" goto no_pid
set /p STALE_PID=<"%PIDFILE%"
taskkill /PID !STALE_PID! /T /F >nul 2>&1
del "%PIDFILE%" >nul 2>&1
echo Zatrzymano AgentDock, pid !STALE_PID!
exit /b 0

:no_pid
echo Nie znalazlem pliku pid - serwer prawdopodobnie nie dziala.
exit /b 0

:do_status
"%BUN%" "%SRC%" doctor
echo.
"%BUN%" "%SRC%" projects
echo.
"%BUN%" "%SRC%" runs --limit 15
exit /b 0

:do_demo
"%BUN%" "%SRC%" demo
exit /b %errorlevel%

:do_ui
powershell -NoProfile -ExecutionPolicy Bypass -Command "$cfg = Join-Path $env:USERPROFILE '.agentdock\config.json'; $c = Get-Content $cfg -Raw | ConvertFrom-Json; Start-Process ('http://127.0.0.1:{0}/?token={1}' -f $c.port, $c.token)"
exit /b 0

:do_logs
powershell -NoProfile -Command "Get-Content -Wait '%OUTLOG%'"
exit /b 0

:do_test
cd /d "%APPDIR%"
"%BUN%" test
exit /b %errorlevel%

:do_build
cd /d "%APPDIR%"
"%BUN%" run build
exit /b %errorlevel%

:do_shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AgentDock.lnk')); $s.TargetPath = '%APPDIR%agentdock.cmd'; $s.Arguments = 'start'; $s.WorkingDirectory = '%APPDIR%'; $s.IconLocation = '%SystemRoot%\System32\shell32.dll,137'; $s.Save(); Write-Host 'Skrot na pulpicie: AgentDock.lnk'"
exit /b 0

:do_cli
"%BUN%" "%SRC%" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%

:do_help
"%BUN%" "%SRC%" --help
exit /b 0

:usage
echo Nieznane polecenie: %CMD%
echo Uzycie: agentdock.cmd start ^| stop ^| status ^| demo ^| ui ^| logs ^| test ^| build ^| shortcut ^| cli ... ^| help
exit /b 2
