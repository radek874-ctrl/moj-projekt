# Wspólny budżet – konfiguracja (jednorazowo, ok. 5 minut)

Wspólny budżet pozwala kilku osobom prowadzić te same finanse, każda na swoim
telefonie. Dane synchronizują się przez darmową bazę **Supabase**. Konfiguruje ją
**tylko jedna osoba** – pozostali dołączają z linku zaproszenia.

## 1. Załóż bazę

1. Wejdź na **https://supabase.com** → **Start your project** → zaloguj się (np. przez GitHub).
2. **New project**:
   - *Name*: np. `budzet`
   - *Database Password*: kliknij **Generate a password** (nie będzie potrzebne w aplikacji)
   - *Region*: **Central EU (Frankfurt)**
   - **Create new project** i poczekaj ok. 2 minuty.

## 2. Wklej skrypt bazy

1. W menu po lewej: **SQL Editor** → **New query**.
2. Otwórz plik [supabase-setup.sql](supabase-setup.sql) → przycisk **Raw** → zaznacz i skopiuj całość.
3. Wklej w edytor i kliknij **Run**. Powinno pojawić się *Success. No rows returned*.

## 3. Skopiuj adres i klucz

Kliknij **Connect** na górze strony projektu (albo **Project Settings → API Keys / Data API**) i skopiuj:
- **Project URL** – wygląda jak `https://abcdefgh.supabase.co`
- **publishable key** (`sb_publishable_…`) albo starszy **anon public** (`eyJ…`) – oba działają.

Nie używaj klucza *secret* / *service_role*.

## 4. Utwórz wspólny budżet w aplikacji

1. W aplikacji: **⚙ → 👥 Wspólny budżet → Załóż nowy wspólny budżet**.
2. Wklej *Project URL* i klucz → **Utwórz i wyślij dane z tego telefonu**.
3. **👥 Zaproś osobę** → wyślij link (WhatsApp, SMS, e-mail).

Osoba zaproszona otwiera link w Chrome (albo wkleja go w aplikacji w **⚙ → Wspólny budżet**)
i stuka **Dołącz**. Może przy tym dołączyć swoje dotychczasowe wpisy.

## Jak to działa

- Każdy telefon ma pełną kopię danych, więc aplikacja działa też bez internetu.
  Zmiany wysyłają się po odzyskaniu połączenia.
- Zmiany z różnych telefonów są łączone wpis po wpisie. Gdy dwie osoby zmienią ten sam
  wpis jednocześnie, zostaje wersja zapisana później; edycja wygrywa z usunięciem.
- Synchronizacja następuje po każdej zmianie, przy otwarciu aplikacji i co minutę.
- Klucz asystenta AI nie jest synchronizowany – każdy ma swój.

## Bezpieczeństwo

- **Link zaproszenia daje pełny dostęp do budżetu** – wysyłaj go tylko zaufanym osobom.
- Bez linku nie da się odczytać danych: tabela jest zablokowana, a funkcje bazy wymagają
  losowego, 28-znakowego klucza budżetu.
- Dane są w Twoim projekcie Supabase (UE, Frankfurt). Możesz je w każdej chwili usunąć,
  kasując projekt.

## Uwagi

- Darmowy projekt Supabase **usypia się po tygodniu bez używania**. Jeśli synchronizacja
  przestanie działać po dłuższej przerwie, wejdź na supabase.com i kliknij **Restore project**.
- Odłączenie telefonu (**⚙ → Wspólny budżet → Odłącz**) zostawia dane w telefonie.
