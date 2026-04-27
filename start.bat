@echo off
echo === USA Stock Scanner ===
echo Starting server at http://localhost:5000
echo Press Ctrl+C to stop.
echo.
start "" http://localhost:5000
python app.py
pause
