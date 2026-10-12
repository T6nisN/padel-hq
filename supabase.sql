-- Padel HQ schema. Run in Supabase → SQL Editor (safe to re-run),
-- then run supabase-seed.local.sql once to create the players and their passwords.
--
-- Access model:
--   * Players log in with name + password via login(); they get a random session token.
--   * The app sends that token in an `x-session` header; every policy resolves it to a player.
--   * Passwords are bcrypt-hashed and never leave the database. 10 wrong guesses lock a
--     player for 15 minutes.
--   * Admins (players.is_admin) can delete anything, settle any debt and reset passwords.
--     Only admins delete matches. Everyone: log matches, settle debts they're part of, undo own settlements.

create extension if not exists pgcrypto with schema extensions;

-- ---------- players & sessions (not reachable directly; only via functions below) ----------
create table if not exists public.players (
  id              text primary key,            -- must match ids in config.js
  name            text not null,
  is_admin        boolean not null default false,
  password_hash   text not null,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  must_change_password boolean not null default true   -- forced on first login / after admin reset
);
alter table public.players add column if not exists must_change_password boolean not null default true;

create table if not exists public.sessions (
  token       text primary key,
  player_id   text not null references public.players (id) on delete cascade,
  created_at  timestamptz not null default now()
);

alter table public.players  enable row level security;   -- no policies = no direct access
alter table public.sessions enable row level security;
revoke all on public.players, public.sessions from anon, authenticated;

-- ---------- data ----------
create table if not exists public.matches (
  id          uuid primary key default gen_random_uuid(),
  played_at   timestamptz not null default now(),
  team_a      text[] not null check (array_length(team_a, 1) = 2),
  team_b      text[] not null check (array_length(team_b, 1) = 2),
  sets        jsonb  not null,               -- regular: [[6,4],[3,6]] games per set; americano: [[16,8]] points
  winner      text   not null check (winner in ('A', 'B')),
  game_type   text   not null default 'regular' check (game_type in ('regular', 'americano')),
  created_by  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.settlements (
  id          uuid primary key default gen_random_uuid(),
  from_player text not null,                 -- who paid the beers
  to_player   text not null,                 -- who drank them
  beers       int  not null check (beers > 0),
  created_by  text,
  created_at  timestamptz not null default now()
);

-- For databases created with an earlier version of this script.
alter table public.matches     add column if not exists created_by text;
alter table public.settlements add column if not exists created_by text;
alter table public.matches     add column if not exists game_type text not null default 'regular'
  check (game_type in ('regular', 'americano'));
-- Groups the rounds of one Americano training (shown as one card).
alter table public.matches     add column if not exists session_id uuid;
-- A substitute appears in team_a/team_b as 'guest'; this is just their display name.
-- Guests are excluded from stats and beers in the app.
alter table public.matches     add column if not exists guest_name text check (length(guest_name) <= 30);

-- ---------- identity helpers ----------
create or replace function public.current_player() returns text
language sql stable security definer set search_path = public as $$
  select player_id from public.sessions
  where token = coalesce(current_setting('request.headers', true)::json ->> 'x-session', '')
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.players where id = public.current_player()), false)
$$;

-- Returns {player, is_admin, must_change} for a valid session, null otherwise.
create or replace function public.whoami() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('player', id, 'is_admin', is_admin, 'must_change', must_change_password)
  from public.players where id = public.current_player()
$$;

-- Returns {token, player, is_admin, must_change} on success, {error: 'wrong' | 'locked'} on failure.
create or replace function public.login(p_player text, p_password text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v public.players;
  v_token text;
begin
  select * into v from public.players where id = p_player;
  if v.id is null then
    return json_build_object('error', 'wrong');
  end if;
  if v.locked_until is not null and v.locked_until > now() then
    return json_build_object('error', 'locked');
  end if;
  if v.password_hash <> crypt(p_password, v.password_hash) then
    update public.players
       set failed_attempts = case when failed_attempts + 1 >= 10 then 0 else failed_attempts + 1 end,
           locked_until    = case when failed_attempts + 1 >= 10 then now() + interval '15 minutes' else locked_until end
     where id = v.id;
    return json_build_object('error', 'wrong');
  end if;

  update public.players set failed_attempts = 0, locked_until = null where id = v.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.sessions (token, player_id) values (v_token, v.id);
  return json_build_object('token', v_token, 'player', v.id, 'is_admin', v.is_admin,
                           'must_change', v.must_change_password);
end $$;

-- Logged-in player changes their own password. Signs out their other devices.
-- Returns {ok: true} or {error: 'session' | 'wrong' | 'short'}.
create or replace function public.change_password(p_current text, p_new text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v public.players;
begin
  select * into v from public.players where id = public.current_player();
  if v.id is null then
    return json_build_object('error', 'session');
  end if;
  if v.password_hash <> crypt(coalesce(p_current, ''), v.password_hash) then
    return json_build_object('error', 'wrong');
  end if;
  if length(coalesce(p_new, '')) < 6 then
    return json_build_object('error', 'short');
  end if;
  update public.players
     set password_hash = crypt(p_new, gen_salt('bf', 8)), must_change_password = false
   where id = v.id;
  delete from public.sessions
   where player_id = v.id
     and token <> coalesce(current_setting('request.headers', true)::json ->> 'x-session', '');
  return json_build_object('ok', true);
end $$;

-- Admin only. Sets a new password and signs the player out everywhere
-- (except the admin's own current device, if resetting their own password).
create or replace function public.set_password(p_player text, p_password text) returns boolean
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'password too short';
  end if;
  -- Others must pick their own password at next login; an admin resetting themselves doesn't.
  update public.players
     set password_hash = crypt(p_password, gen_salt('bf', 8)), failed_attempts = 0, locked_until = null,
         must_change_password = (p_player <> public.current_player())
   where id = p_player;
  if not found then
    return false;
  end if;
  delete from public.sessions
   where player_id = p_player
     and token <> coalesce(current_setting('request.headers', true)::json ->> 'x-session', '');
  return true;
end $$;

-- ---------- row-level security ----------
alter table public.matches     enable row level security;
alter table public.settlements enable row level security;

-- Drop policies from all earlier versions before their functions.
drop policy if exists club_only    on public.matches;
drop policy if exists club_only    on public.settlements;
drop policy if exists players_only on public.matches;
drop policy if exists players_only on public.settlements;
drop policy if exists read_all     on public.matches;
drop policy if exists add_own      on public.matches;
drop policy if exists delete_own   on public.matches;
drop policy if exists read_all     on public.settlements;
drop policy if exists add_own      on public.settlements;
drop policy if exists delete_own   on public.settlements;
drop function if exists public.check_club_key();
drop function if exists public.has_club_key();
drop function if exists public.is_player();

-- `(select fn())` makes Postgres evaluate the function once per query, not once per row.
create policy read_all on public.matches for select to anon
  using ((select public.current_player()) is not null);
create policy add_own on public.matches for insert to anon
  with check (created_by = (select public.current_player()));
-- Only the admin can delete matches.
create policy delete_own on public.matches for delete to anon
  using ((select public.is_admin()));

create policy read_all on public.settlements for select to anon
  using ((select public.current_player()) is not null);
-- Either side of the debt (or an admin) can mark beers as paid.
create policy add_own on public.settlements for insert to anon
  with check (created_by = (select public.current_player())
              and ((select public.current_player()) in (from_player, to_player) or (select public.is_admin())));
create policy delete_own on public.settlements for delete to anon
  using (created_by = (select public.current_player()) or (select public.is_admin()));

grant select, insert, delete on public.matches     to anon;
grant select, insert, delete on public.settlements to anon;
grant execute on function public.current_player()          to anon;
grant execute on function public.is_admin()                to anon;
grant execute on function public.whoami()                  to anon;
grant execute on function public.login(text, text)         to anon;
grant execute on function public.set_password(text, text)  to anon;
grant execute on function public.change_password(text, text) to anon;
