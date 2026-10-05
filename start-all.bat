@echo off
REM Inlark - SATU FILE UNTUK SEMUA SERVICE (double-click 1x, tidak perlu terminal lain)
REM Cara pakai: double-click file ini. Ctrl+C 1x mematikan semuanya.
REM Isi: 0) Muat Client ID Google dari apps\desktop\.env.local
REM      1) Desktop Electron (pnpm dev)  2) Desktop Web (port 5174)  3) Marketing Astro

title Inlark - Semua Service (1 Jendela)
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm tidak ditemukan di PATH.
  echo Install Node LTS + pnpm dulu, lalu jalankan lagi.
  pause
  exit /b 1
)

REM Muat env lokal agar Sign in with Google langsung aktif (tanpa setx / terminal baru)
if exist "apps\desktop\.env.local" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("apps\desktop\.env.local") do (
    if not "%%A"=="" if not "%%B"=="" set "%%A=%%B"
  )
  echo [OK] env lokal dimuat dari apps\desktop\.env.local
) else (
  echo [WARN] apps\desktop\.env.local tidak ada, OAuth Google nonaktif.
)

echo.
echo  =====================================================
echo   Inlark - 1 jendela, 3 service paralel:
echo    [desktop]   pnpm dev (electron-vite)
echo    [web]       pnpm dev:web di http://127.0.0.1:5174
echo    [marketing] pnpm dev:marketing (http://localhost:4321)
echo   Ctrl+C untuk stop semua sekaligus.
echo  =====================================================
echo.

pnpm dlx concurrently@9 -k -n desktop,web,marketing -c cyan,magenta,yellow "pnpm dev" "pnpm dev:web --port 5174 --strictPort" "pnpm dev:marketing"
set CODE=%errorlevel%
echo.
if not "%CODE%"=="0" (
  echo [STOP] salah satu service error (kode %CODE%). Lihat log di atas.
) else (
  echo [STOP] semua service berhenti.
)
pause
