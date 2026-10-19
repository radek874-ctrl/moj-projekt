# Budżet domowy – aplikacja na Androida

Mała aplikacja (WebView), która otwiera Budżet domowy z GitHub Pages. Dane zostają w telefonie,
aplikacja aktualizuje się sama razem ze stroną i działa bez internetu.

**Pobierz:** https://github.com/radek874-ctrl/moj-projekt/releases/download/android-latest/budzet-domowy.apk

Instalacja: otwórz pobrany plik → zezwól przeglądarce/Plikom na instalowanie nieznanych aplikacji
→ **Zainstaluj**. Android może pokazać ostrzeżenie Play Protect (aplikacja spoza Sklepu Play) –
wybierz **Zainstaluj mimo to**.

Budowa: workflow `.github/workflows/android.yml` (GitHub Actions) przy każdej zmianie w `android/`.
Lokalnie: `cd android && gradle assembleRelease` (wymaga Android SDK).

Dodatki względem przeglądarki: aparat/galeria przy polach plików (zdjęcia paragonów), zapis kopii
i eksportu do „Pobranych”, systemowe „Udostępnij” dla zaproszeń, otwieranie linków zewnętrznych
(Kalendarz Google) w aplikacjach systemowych.

Uwaga: plik `release.keystore` (hasło `budzet-test`) służy tylko do wersji testowych i jest
publiczny. Przed publikacją w Sklepie Play wygeneruj nowy klucz i trzymaj go w sekretach GitHuba
(`KEYSTORE_PASSWORD`).

Aplikacja ma osobne dane niż wersja zainstalowana z Chrome – żeby je przenieść, zapisz kopię
w jednej (⚙ → Kopia zapasowa) i przywróć w drugiej albo połącz obie przez wspólny budżet.
