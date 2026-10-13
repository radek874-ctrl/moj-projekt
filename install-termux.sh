#!/data/data/com.termux/files/usr/bin/bash
# Jednorazowa instalacja w Termuxie: zależności + skróty na ekran główny (Termux:Widget).
set -e
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"

pkg install -y python rust curl termux-api >/dev/null || true
pip install -r requirements.txt

chmod +x start.sh stop.sh
mkdir -p ~/.shortcuts
ln -sf "$DIR/start.sh" ~/.shortcuts/Wydatki
ln -sf "$DIR/stop.sh" ~/.shortcuts/"Wydatki stop"

echo
echo "Gotowe! Uruchom aplikację poleceniem:  ./start.sh"
echo "Albo dodaj widżet Termux:Widget na ekran główny i stuknij 'Wydatki'."
