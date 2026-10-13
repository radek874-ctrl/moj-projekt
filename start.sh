#!/data/data/com.termux/files/usr/bin/bash
# Uruchamia serwer w tle (jeśli jeszcze nie działa) i otwiera aplikację.
cd "$(dirname "$(readlink -f "$0")")" || exit 1

PORT=8000
URL="http://127.0.0.1:$PORT/"

if ! curl -s "${URL}health" >/dev/null 2>&1; then
    command -v termux-wake-lock >/dev/null && termux-wake-lock
    nohup uvicorn app.main:app --host 127.0.0.1 --port "$PORT" >server.log 2>&1 &
    echo "Uruchamiam serwer..."
    for _ in $(seq 1 30); do
        curl -s "${URL}health" >/dev/null 2>&1 && break
        sleep 0.5
    done
fi

if curl -s "${URL}health" >/dev/null 2>&1; then
    echo "Serwer działa: $URL"
    command -v termux-open-url >/dev/null && termux-open-url "$URL"
else
    echo "Nie udało się uruchomić serwera. Szczegóły w pliku server.log"
    exit 1
fi
