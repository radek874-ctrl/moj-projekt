-- Wspólny budżet: jednorazowa konfiguracja bazy w Supabase.
-- Wklej całość w Supabase → SQL Editor → New query → Run.
--
-- Każdy wspólny budżet to jeden wiersz z danymi (JSON) i numerem wersji.
-- Tabela nie jest dostępna bezpośrednio – tylko przez trzy funkcje poniżej,
-- które wymagają znajomości tajnego klucza budżetu (z linku zaproszenia).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shared_budgets (
    id          text primary key,
    secret_hash text        not null,
    data        jsonb       not null,
    version     bigint      not null default 1,
    updated_at  timestamptz not null default now()
);

alter table public.shared_budgets enable row level security;
-- Brak polityk RLS = brak bezpośredniego dostępu dla anon/authenticated.
revoke all on public.shared_budgets from anon, authenticated;

create or replace function public.budget_create(p_id text, p_secret text, p_data jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    if p_id !~ '^[A-Za-z0-9]{10,40}$' or length(p_secret) < 20 then
        raise exception 'Nieprawidłowy identyfikator lub klucz';
    end if;
    if pg_column_size(p_data) > 5000000 then
        raise exception 'Za dużo danych';
    end if;
    insert into shared_budgets (id, secret_hash, data)
    values (p_id, encode(digest(p_secret, 'sha256'), 'hex'), p_data);
    return 1;
end;
$$;

-- Zwraca {"data": ..., "version": n} albo null, gdy id/klucz się nie zgadzają.
create or replace function public.budget_get(p_id text, p_secret text)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
    select jsonb_build_object('data', data, 'version', version)
    from shared_budgets
    where id = p_id and secret_hash = encode(digest(p_secret, 'sha256'), 'hex');
$$;

-- Zapis tylko, gdy p_version to aktualna wersja (inaczej ktoś zdążył zapisać
-- wcześniej – aplikacja pobiera wtedy zmiany, łączy i próbuje ponownie).
-- Zwraca nową wersję albo null.
create or replace function public.budget_put(p_id text, p_secret text, p_data jsonb, p_version bigint)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    new_version bigint;
begin
    if pg_column_size(p_data) > 5000000 then
        raise exception 'Za dużo danych';
    end if;
    update shared_budgets
       set data = p_data, version = version + 1, updated_at = now()
     where id = p_id
       and secret_hash = encode(digest(p_secret, 'sha256'), 'hex')
       and version = p_version
    returning version into new_version;
    return new_version;
end;
$$;

revoke execute on function public.budget_create(text, text, jsonb) from public;
revoke execute on function public.budget_get(text, text) from public;
revoke execute on function public.budget_put(text, text, jsonb, bigint) from public;
grant execute on function public.budget_create(text, text, jsonb) to anon, authenticated;
grant execute on function public.budget_get(text, text) to anon, authenticated;
grant execute on function public.budget_put(text, text, jsonb, bigint) to anon, authenticated;
