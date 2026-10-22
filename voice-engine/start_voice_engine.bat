@echo off
setlocal
title Mind Voice

REM Mind Voice (QD-145) - dich vu giong noi tai may, CHI localhost (127.0.0.1:8011).
REM Khong tai gi khi khoi dong. Dong cua so nay = tat Mind Voice.

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [Mind Voice] Chua cai moi truong. Chay setup_voice_engine.bat truoc.
    pause
    exit /b 1
)

set "PYTHONIOENCODING=utf-8"
set "HF_HUB_DISABLE_TELEMETRY=1"
set "HF_HOME=%~dp0models\.hf"
if not defined MIND_VOICE_PORT set "MIND_VOICE_PORT=8011"

if not exist "..\logs" mkdir "..\logs" >nul 2>&1
echo [Mind Voice] Dang chay tai http://127.0.0.1:%MIND_VOICE_PORT% - log: logs\mind-voice.log
".venv\Scripts\python.exe" -m mind_voice.server >> "..\logs\mind-voice.log" 2>&1
