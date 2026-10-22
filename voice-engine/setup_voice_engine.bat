@echo off
setlocal
title Mind Voice - Cai dat moi truong

REM Mind Voice (QD-145) - cai moi truong Python RIENG cho giong noi tai may.
REM - Tao voice-engine\.venv (khong dung, khong sua Python he thong cua Windows).
REM - Cai SDK chinh thuc VieNeu-TTS + Supertonic (~0,8 GB goi Python).
REM - KHONG tai model. Model cai trong ung dung: Mind Voice Studio -> Quan ly model.

cd /d "%~dp0"

echo.
echo ============================================================
echo   MIND VOICE - CAI DAT MOI TRUONG (chi chay mot lan)
echo ============================================================
echo   Thu muc: %CD%
echo   Se tai khoang 0,8 GB goi Python vao voice-engine\.venv
echo   Model giong (0,2 - 0,5 GB moi model) KHONG tai o buoc nay.
echo.
choice /c CK /n /m "Tiep tuc? [C]o / [K]hong: "
if errorlevel 2 exit /b 1

set "PY="
where py >nul 2>&1 && py -3.11 -c "import sys" >nul 2>&1 && set "PY=py -3.11"
if not defined PY (
    where python >nul 2>&1 && python -c "import sys; exit(0 if sys.version_info[:2] >= (3, 10) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo [LOI] Can Python 3.10+ ^(khuyen nghi 3.11^). Cai tu https://www.python.org/downloads/ roi chay lai.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/2] Tao moi truong rieng .venv bang %PY% ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo [LOI] Khong tao duoc .venv.
        pause
        exit /b 1
    )
) else (
    echo [1/2] Da co .venv - dung lai.
)

echo [2/2] Cai SDK chinh thuc ^(requirements.txt^)...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [LOI] Cai goi that bai. Xem thong bao phia tren.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   XONG. Chay START_TOOL.bat - Mind Voice se tu khoi dong.
echo   Sau do mo Mind Voice Studio -^> Quan ly model de cai model.
echo ============================================================
pause
exit /b 0
