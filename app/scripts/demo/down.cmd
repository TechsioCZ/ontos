@echo off
setlocal
where mise >nul 2>&1
if errorlevel 1 (
  echo [demo] Install mise and run mise install from app/. 1>&2
  exit /b 1
)
pushd "%~dp0\..\.." || exit /b 1
set "MISE_ARGV0="
call mise exec -- node scripts/demo/lifecycle.mts --down %*
set "DEMO_EXIT=%ERRORLEVEL%"
popd
exit /b %DEMO_EXIT%
