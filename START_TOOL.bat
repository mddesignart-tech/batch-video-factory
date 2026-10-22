@echo off
setlocal
title Batch Video Factory - Launcher

REM Batch Video Factory - One Click Launcher (QD-140)
REM Dat file nay trong thu muc goc cua project.
REM Vi du: F:\Tool Video Youtube\START_TOOL.bat
REM
REM Build lai khi code moi hon ban build (src, prisma, public, package*.json,
REM next.config.ts, tsconfig.json), de luon chay ban moi nhat.
REM Khong tu ap migration len DB: chi canh bao va huong dan.

cd /d "%~dp0"

echo.
echo ============================================================
echo   BATCH VIDEO FACTORY
echo ============================================================
echo   Thu muc: %CD%
echo.

where npm >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong tim thay npm/Node.js.
    echo Hay kiem tra lai Node.js tren may.
    echo.
    pause
    exit /b 1
)

if not exist "logs" mkdir "logs" >nul 2>&1

REM Mot server cu con mo o cong 3000 se giu ban cu - va chan ban build moi.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 3000); $c.Close(); exit 1 } catch { exit 0 }"
if errorlevel 1 (
    echo [CANH BAO] Cong 3000 dang co server chay - co the la BAN CU.
    echo Hay dong cua so "Batch Video Factory Server" cu, roi chay lai file nay.
    echo Dang mo tool dang chay: http://localhost:3000/workspace
    start "" "http://localhost:3000/workspace"
    pause
    exit /b 0
)

set "NEED_BUILD="
if not exist ".next\BUILD_ID" (
    set "NEED_BUILD=1"
    echo [1/4] Chua co production build.
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$b = (Get-Item '.next\BUILD_ID').LastWriteTimeUtc;" ^
      "$f = @(Get-ChildItem -Path 'src','prisma','public' -Recurse -File -ErrorAction SilentlyContinue) + @(Get-Item 'package.json','package-lock.json','next.config.ts','tsconfig.json' -ErrorAction SilentlyContinue);" ^
      "$n = $f | Where-Object { $_.LastWriteTimeUtc -gt $b } | Select-Object -First 1;" ^
      "if ($n) { Write-Host ('      Thay doi moi hon ban build: ' + $n.FullName.Substring((Get-Location).Path.Length + 1)); exit 1 } else { exit 0 }"
    if errorlevel 1 (
        set "NEED_BUILD=1"
        echo [1/4] Code da thay doi sau lan build truoc.
    ) else (
        echo [1/4] Production build da moi nhat - bo qua build.
    )
)

if defined NEED_BUILD (
    echo       Dang build ban moi nhat ^(chi tai may, khong goi API^)...
    echo.
    call npx prisma generate
    if errorlevel 1 (
        echo.
        echo [LOI] prisma generate that bai. Tool chua duoc khoi dong.
        pause
        exit /b 1
    )
    call npm run build
    if errorlevel 1 (
        echo.
        echo [LOI] Build that bai. Tool chua duoc khoi dong.
        pause
        exit /b 1
    )
)

echo.
echo [2/4] Kiem tra migration cua DB...
call npx prisma migrate status >nul 2>&1
if errorlevel 1 (
    echo [CANH BAO] DB chua co migration moi nhat ^(hoac khong doc duoc trang thai^).
    echo Tool co the bao loi o trang moi. Cach ap an toan:
    echo   1. npm run backup
    echo   2. npx prisma migrate deploy
    echo Xem chi tiet: npx prisma migrate status
    echo.
    choice /c CK /n /m "Van khoi dong? [C]o / [K]hong: "
    if errorlevel 2 exit /b 1
) else (
    echo       DB da co du migration.
)

echo.
echo [Mind Voice] Kiem tra giong noi tai may ^(QD-145, tuy chon^)...
if exist "voice-engine\.venv\Scripts\python.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 8011); $c.Close(); exit 1 } catch { exit 0 }"
    if errorlevel 1 (
        echo       Mind Voice dang chay ^(127.0.0.1:8011^).
    ) else (
        start "Mind Voice" /min cmd /c ""%~dp0voice-engine\start_voice_engine.bat""
        echo       Da khoi dong Mind Voice ^(cua so thu nho "Mind Voice"^).
        echo       Model chua cai? Mo Mind Voice Studio -^> Quan ly model. Khong tu tai.
    )
) else (
    echo       Chua cai Mind Voice - bo qua. Muon dung giong tai may $0:
    echo       chay voice-engine\setup_voice_engine.bat ^(mot lan^).
)

echo.
echo [3/4] Dang khoi dong Batch Video Factory...

start "Batch Video Factory Server" cmd /k "cd /d ""%~dp0"" && npm start"

echo [4/4] Dang cho server san sang...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url='http://localhost:3000/workspace';" ^
  "$ok=$false;" ^
  "for($i=0;$i -lt 90;$i++){" ^
  " try {" ^
  "   $r=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2;" ^
  "   if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){$ok=$true;break}" ^
  " } catch {}" ^
  " Start-Sleep -Seconds 1" ^
  "};" ^
  "if($ok){Start-Process $url; exit 0}else{Start-Process $url; exit 1}"

if errorlevel 1 (
    echo.
    echo [CANH BAO] Server chua phan hoi sau thoi gian cho.
    echo Hay xem cua so "Batch Video Factory Server" de biet loi.
    echo Dia chi: http://localhost:3000/workspace
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   TOOL DA KHOI DONG
echo   http://localhost:3000/workspace
echo ============================================================
echo.
echo Cua so nay co the dong.
echo KHONG dong cua so "Batch Video Factory Server" khi dang dung.
timeout /t 3 >nul
exit /b 0
