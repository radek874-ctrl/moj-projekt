#!/data/data/com.termux/files/usr/bin/bash
# Zatrzymuje serwer uruchomiony przez start.sh.
pkill -f "uvicorn app.main:app" && echo "Serwer zatrzymany." || echo "Serwer nie działał."
command -v termux-wake-unlock >/dev/null && termux-wake-unlock
