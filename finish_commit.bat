@echo off
REM ──────────────────────────────────────────────────────────────────────
REM  Finishes the commit started by Claude:
REM    1. Removes any leftover .git\index.lock from the sandbox session
REM    2. Re-stages the 4 changed/new files
REM    3. Commits with a descriptive message
REM    4. Pushes to origin (GitHub) — Render will redeploy automatically
REM ──────────────────────────────────────────────────────────────────────
cd /d "%~dp0"

echo === Step 1: Clearing any leftover index.lock ===
if exist ".git\index.lock" (
    del /f /q ".git\index.lock"
    echo Removed stale lock.
) else (
    echo No lock file present.
)

echo.
echo === Step 2: Staging files ===
git add scanner.py core_regime.py analysis.py USA_Stock_Scanner_Improvement_Roadmap.docx
git status --short

echo.
echo === Step 3: Committing ===
git commit -m "Improve signal accuracy: regime filter, smooth RSI, MTF confluence" ^
           -m "- Add core_regime.py: SPY/VIX-based market regime score (15min cache)" ^
           -m "- scanner.py: replace cliff-threshold RSI scoring with smooth Gaussian + slope" ^
           -m "  (fixes non-monotonic bug where 60-70 scored higher than 70-80)" ^
           -m "- scanner.py: add htf_alignment() for multi-timeframe confluence" ^
           -m "  (boosts strength 1.2x when higher TF agrees, 0.6x when disagrees)" ^
           -m "- scanner.py: composite now includes 10%% regime weight" ^
           -m "- Expose regime_score and mtf_align in scan results" ^
           -m "- analysis.py: add deep-research module (Buffett score + value screener)" ^
           -m "- Add USA_Stock_Scanner_Improvement_Roadmap.docx (10-section upgrade plan)" ^
           -m "" ^
           -m "Reference: Sections 8.1, 8.2, 8.3 of the roadmap."

if errorlevel 1 (
    echo.
    echo Commit failed. Check the error above.
    pause
    exit /b 1
)

echo.
echo === Step 4: Pushing to origin/master (this triggers Render redeploy) ===
echo Press CTRL+C now if you do NOT want to push yet.
pause
git push origin master

echo.
echo Done. Watch Render dashboard for the new deploy.
pause
