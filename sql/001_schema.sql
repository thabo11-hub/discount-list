-- TrolleyScout database schema (Supabase Postgres 15+).
--
-- Security model
--  * All tables live in the private "dl" schema. The Supabase Data API does not expose it,
--    and the anon / authenticated roles get no privileges on it (RLS is also enabled).
--  * The app server reaches data only through the public.dl_* functions below. Each one is
--    SECURITY DEFINER with an empty search_path and starts with dl.gate(p_key): the caller
--    must present the server key. Only the SHA-256 hash of that key is stored here.
--  * No dynamic SQL runs with user input: every statement is static and every value is a
--    typed function parameter (parameterized by construction).

create schema if not exists dl;
revoke all on schema dl from public;
revoke all on schema dl from anon, authenticated;

-- ---------------------------------------------------------------- tables

create table if not exists dl.server_keys (
  key_hash   text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  label      text not null default 'server' check (char_length(label) <= 60),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists dl.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null unique
                      check (email = lower(email) and char_length(email) between 3 and 254),
  name                text not null check (char_length(name) between 1 and 60),
  pw_hash             text not null check (char_length(pw_hash) between 20 and 300),
  role                text not null default 'user' check (role in ('user', 'admin')),
  failed_logins       int  not null default 0,
  locked_until        timestamptz,
  created_at          timestamptz not null default now(),
  password_changed_at timestamptz not null default now()
);

create table if not exists dl.sessions (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id      uuid not null references dl.users(id) on delete cascade,
  csrf_token   text not null check (char_length(csrf_token) between 32 and 128),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists sessions_user_idx on dl.sessions(user_id);
create index if not exists sessions_expiry_idx on dl.sessions(expires_at);

create table if not exists dl.reset_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null references dl.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists reset_user_idx on dl.reset_tokens(user_id);

create table if not exists dl.admin_setup (
  code_hash  text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid references dl.users(id) on delete set null
);

create table if not exists dl.stores (
  id    text primary key check (id ~ '^[a-z0-9-]{2,30}$'),
  name  text not null check (char_length(name) between 1 and 60),
  chain text not null check (char_length(chain) between 1 and 40),
  kind  text not null check (char_length(kind) between 1 and 80),
  sort  int  not null default 0
);

create table if not exists dl.products (
  id          text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name        text not null check (char_length(name) between 1 and 60),
  unit        text not null default 'item' check (unit in ('item', 'litre')),
  default_qty int  not null default 1 check (default_qty between 1 and 99),
  sort        int  not null default 0,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

create table if not exists dl.offers (
  product_id       text not null references dl.products(id) on delete cascade,
  store_id         text not null references dl.stores(id) on delete cascade,
  brand            text not null default '' check (char_length(brand) <= 60),
  deal_text        text not null default '' check (char_length(deal_text) <= 80),
  deal_qty         int  not null default 1 check (deal_qty between 1 and 100),
  deal_price_cents int  check (deal_price_cents between 1 and 10000000),
  pack_amount      numeric(8,3) not null default 1 check (pack_amount > 0 and pack_amount <= 1000),
  in_stock         boolean not null default true,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references dl.users(id) on delete set null,
  primary key (product_id, store_id),
  check (not in_stock or deal_price_cents is not null)
);

create table if not exists dl.lists (
  user_id    uuid primary key references dl.users(id) on delete cascade,
  items      jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 60),
  updated_at timestamptz not null default now()
);

create table if not exists dl.uploads (
  id          uuid primary key default gen_random_uuid(),
  mime        text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes       bytea not null check (octet_length(bytes) between 12 and 2097152),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  caption     text not null default '' check (char_length(caption) <= 80),
  uploaded_by uuid references dl.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists dl.audit_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  event    text not null check (event ~ '^[a-z_]{2,40}$'),
  severity text not null default 'info' check (severity in ('info', 'warn', 'alert')),
  user_id  uuid,
  ip_hash  text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{16,64}$'),
  detail   jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 4000)
);
create index if not exists audit_at_idx on dl.audit_log(at desc);
create index if not exists audit_event_idx on dl.audit_log(event, at desc);

create table if not exists dl.rate_limits (
  bucket       text not null check (char_length(bucket) between 3 and 200),
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);

-- RLS on, no policies, no grants: nothing is reachable except through the gated functions.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'dl' loop
    execute format('alter table dl.%I enable row level security', t);
    execute format('revoke all on table dl.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- internal helpers

create or replace function dl.gate(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null or char_length(p_key) not between 32 and 200 or not exists (
       select 1 from dl.server_keys k
        where k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
          and k.revoked_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function dl.require_admin(p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or not exists (select 1 from dl.users where id = p_actor and role = 'admin') then
    raise exception 'not_admin' using errcode = '42501';
  end if;
end $$;

create or replace function dl.audit_insert(p_event text, p_severity text, p_user uuid, p_ip_hash text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into dl.audit_log (event, severity, user_id, ip_hash, detail)
  values (p_event, coalesce(p_severity, 'info'), p_user, p_ip_hash, coalesce(p_detail, '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------- health, rate limits, audit

create or replace function public.dl_health(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return jsonb_build_object('ok', true, 'offers', (select count(*) from dl.offers), 'at', now());
end $$;

create or replace function public.dl_rate_hit(p_key text, p_bucket text, p_limit int, p_window_s int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_hits  int;
begin
  perform dl.gate(p_key);
  if p_bucket is null or char_length(p_bucket) not between 3 and 200
     or p_limit not between 1 and 100000 or p_window_s not between 1 and 86400 then
    raise exception 'bad_input' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now())::double precision / p_window_s) * p_window_s);
  insert into dl.rate_limits as r (bucket, window_start, hits) values (p_bucket, v_start, 1)
    on conflict (bucket, window_start) do update set hits = r.hits + 1
    returning r.hits into v_hits;
  return jsonb_build_object(
    'allowed', v_hits <= p_limit,
    'hits', v_hits,
    'retry_after', greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_s) - now())))::int));
end $$;

create or replace function public.dl_audit(p_key text, p_event text, p_severity text, p_user_id uuid,
                                           p_ip_hash text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  perform dl.audit_insert(p_event, p_severity, p_user_id, p_ip_hash, p_detail);
end $$;

create or replace function public.dl_admin_overview(p_key text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  return jsonb_build_object(
    'events', coalesce((select jsonb_agg(e order by e.at desc) from (
        select a.id, a.at, a.event, a.severity, a.user_id, left(a.ip_hash, 8) as ip, a.detail
          from dl.audit_log a order by a.at desc limit 60) e), '[]'::jsonb),
    'counts_1h', coalesce((select jsonb_object_agg(c.event, c.n) from (
        select a.event, count(*) as n from dl.audit_log a
         where a.at > now() - interval '1 hour' group by a.event) c), '{}'::jsonb),
    'counts_24h', coalesce((select jsonb_object_agg(c.event, c.n) from (
        select a.event, count(*) as n from dl.audit_log a
         where a.at > now() - interval '24 hours' group by a.event) c), '{}'::jsonb),
    'users', (select count(*) from dl.users),
    'admins', (select count(*) from dl.users where role = 'admin'));
end $$;

-- ---------------------------------------------------------------- users and sessions

create or replace function public.dl_user_create(p_key text, p_email text, p_name text, p_pw_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform dl.gate(p_key);
  insert into dl.users (email, name, pw_hash) values (p_email, p_name, p_pw_hash) returning id into v_id;
  return jsonb_build_object('id', v_id);
exception when unique_violation then
  raise exception 'email_taken' using errcode = 'P0001';
end $$;

create or replace function public.dl_user_by_email(p_key text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform dl.gate(p_key);
  select jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'pw_hash', u.pw_hash,
                            'role', u.role, 'locked_until', u.locked_until)
    into v from dl.users u where u.email = p_email;
  return v;
end $$;

create or replace function public.dl_user_by_id(p_key text, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform dl.gate(p_key);
  select jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'pw_hash', u.pw_hash, 'role', u.role)
    into v from dl.users u where u.id = p_user_id;
  return v;
end $$;

create or replace function public.dl_login_record(p_key text, p_user_id uuid, p_success boolean,
                                                  p_max_fail int, p_lock_s int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_failed int;
  v_until  timestamptz;
begin
  perform dl.gate(p_key);
  if p_success then
    update dl.users set failed_logins = 0, locked_until = null where id = p_user_id;
    return jsonb_build_object('failed', 0, 'locked_until', null);
  end if;
  update dl.users set failed_logins = failed_logins + 1 where id = p_user_id returning failed_logins into v_failed;
  if v_failed >= p_max_fail then
    update dl.users set failed_logins = 0, locked_until = now() + make_interval(secs => p_lock_s)
     where id = p_user_id returning locked_until into v_until;
  end if;
  return jsonb_build_object('failed', v_failed, 'locked_until', v_until);
end $$;

create or replace function public.dl_user_rehash(p_key text, p_user_id uuid, p_pw_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  update dl.users set pw_hash = p_pw_hash where id = p_user_id;
end $$;

create or replace function public.dl_user_change_password(p_key text, p_user_id uuid, p_pw_hash text,
                                                          p_keep_token_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  update dl.users set pw_hash = p_pw_hash, password_changed_at = now(), failed_logins = 0, locked_until = null
   where id = p_user_id;
  delete from dl.sessions where user_id = p_user_id and token_hash <> coalesce(p_keep_token_hash, '');
  delete from dl.reset_tokens where user_id = p_user_id;
end $$;

create or replace function public.dl_session_create(p_key text, p_user_id uuid, p_token_hash text,
                                                    p_csrf text, p_ttl_s int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  if p_ttl_s not between 60 and 2592000 then
    raise exception 'bad_input' using errcode = '22023';
  end if;
  delete from dl.sessions where user_id = p_user_id and expires_at < now();
  insert into dl.sessions (token_hash, user_id, csrf_token, expires_at)
  values (p_token_hash, p_user_id, p_csrf, now() + make_interval(secs => p_ttl_s));
  -- keep at most 10 live sessions per account
  delete from dl.sessions where token_hash in (
    select s.token_hash from dl.sessions s where s.user_id = p_user_id order by s.created_at desc offset 10);
end $$;

create or replace function public.dl_session_get(p_key text, p_token_hash text, p_idle_s int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  perform dl.gate(p_key);
  select s.user_id, s.csrf_token, s.created_at, s.last_seen_at, s.expires_at, u.email, u.name, u.role
    into v
    from dl.sessions s join dl.users u on u.id = s.user_id
   where s.token_hash = p_token_hash;
  if not found then
    return null;
  end if;
  if v.expires_at < now() or v.last_seen_at < now() - make_interval(secs => p_idle_s) then
    delete from dl.sessions where token_hash = p_token_hash;
    return null;
  end if;
  if v.last_seen_at < now() - interval '5 minutes' then
    update dl.sessions set last_seen_at = now() where token_hash = p_token_hash;
  end if;
  return jsonb_build_object('user_id', v.user_id, 'email', v.email, 'name', v.name, 'role', v.role,
                            'csrf', v.csrf_token, 'created_at', v.created_at);
end $$;

create or replace function public.dl_session_delete(p_key text, p_token_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  delete from dl.sessions where token_hash = p_token_hash;
end $$;

-- ---------------------------------------------------------------- password reset

create or replace function public.dl_reset_create(p_key text, p_user_id uuid, p_token_hash text, p_ttl_s int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  if p_ttl_s not between 60 and 3600 then
    raise exception 'bad_input' using errcode = '22023';
  end if;
  delete from dl.reset_tokens where user_id = p_user_id;          -- only the newest link works
  insert into dl.reset_tokens (token_hash, user_id, expires_at)
  values (p_token_hash, p_user_id, now() + make_interval(secs => p_ttl_s));
end $$;

create or replace function public.dl_reset_check(p_key text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return jsonb_build_object('valid', exists (
    select 1 from dl.reset_tokens where token_hash = p_token_hash and used_at is null and expires_at > now()));
end $$;

create or replace function public.dl_reset_consume(p_key text, p_token_hash text, p_pw_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  perform dl.gate(p_key);
  select user_id into v_uid from dl.reset_tokens
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   for update;
  if v_uid is null then
    return jsonb_build_object('ok', false);
  end if;
  update dl.reset_tokens set used_at = now() where user_id = v_uid and used_at is null;
  update dl.users set pw_hash = p_pw_hash, password_changed_at = now(), failed_logins = 0, locked_until = null
   where id = v_uid;
  delete from dl.sessions where user_id = v_uid;                  -- sign out everywhere
  return jsonb_build_object('ok', true, 'user_id', v_uid);
end $$;

-- ---------------------------------------------------------------- deals

create or replace function public.dl_deals(p_key text, p_include_inactive boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return jsonb_build_object(
    'stores', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'chain', s.chain,
                                                          'kind', s.kind) order by s.sort, s.id)
                          from dl.stores s), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'unit', p.unit,
                                                            'default_qty', p.default_qty, 'sort', p.sort,
                                                            'active', p.active) order by p.sort, p.id)
                            from dl.products p where p.active or p_include_inactive), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object('product_id', o.product_id, 'store_id', o.store_id,
                                                          'brand', o.brand, 'deal_text', o.deal_text,
                                                          'deal_qty', o.deal_qty,
                                                          'deal_price_cents', o.deal_price_cents,
                                                          'pack_amount', o.pack_amount, 'in_stock', o.in_stock,
                                                          'updated_at', o.updated_at)
                                       order by o.product_id, o.store_id)
                          from dl.offers o join dl.products p on p.id = o.product_id
                         where p.active or p_include_inactive), '[]'::jsonb),
    'updated_at', greatest((select max(updated_at) from dl.offers), (select max(updated_at) from dl.products)));
end $$;

create or replace function public.dl_offer_upsert(p_key text, p_actor uuid, p_product_id text, p_store_id text,
                                                  p_brand text, p_deal_text text, p_deal_qty int,
                                                  p_deal_price_cents int, p_pack_amount numeric, p_in_stock boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  select to_jsonb(o) into v_before from dl.offers o where o.product_id = p_product_id and o.store_id = p_store_id;
  insert into dl.offers as o (product_id, store_id, brand, deal_text, deal_qty, deal_price_cents, pack_amount,
                              in_stock, updated_at, updated_by)
  values (p_product_id, p_store_id, p_brand, p_deal_text, p_deal_qty, p_deal_price_cents, p_pack_amount,
          p_in_stock, now(), p_actor)
  on conflict (product_id, store_id) do update
     set brand = excluded.brand, deal_text = excluded.deal_text, deal_qty = excluded.deal_qty,
         deal_price_cents = excluded.deal_price_cents, pack_amount = excluded.pack_amount,
         in_stock = excluded.in_stock, updated_at = now(), updated_by = p_actor
  returning to_jsonb(o.*) into v_after;
  perform dl.audit_insert('offer_changed', 'info', p_actor, null,
                          jsonb_build_object('before', v_before, 'after', v_after));
  return v_after;
end $$;

create or replace function public.dl_offer_delete(p_key text, p_actor uuid, p_product_id text, p_store_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  delete from dl.offers o where o.product_id = p_product_id and o.store_id = p_store_id
  returning to_jsonb(o.*) into v_before;
  perform dl.audit_insert('offer_deleted', 'info', p_actor, null, jsonb_build_object('before', v_before));
end $$;

create or replace function public.dl_product_upsert(p_key text, p_actor uuid, p_id text, p_name text, p_unit text,
                                                    p_default_qty int, p_sort int, p_active boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_after jsonb;
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  insert into dl.products as p (id, name, unit, default_qty, sort, active, updated_at)
  values (p_id, p_name, p_unit, p_default_qty, p_sort, p_active, now())
  on conflict (id) do update
     set name = excluded.name, unit = excluded.unit, default_qty = excluded.default_qty,
         sort = excluded.sort, active = excluded.active, updated_at = now()
  returning to_jsonb(p.*) into v_after;
  perform dl.audit_insert('product_changed', 'info', p_actor, null, jsonb_build_object('after', v_after));
  return v_after;
end $$;

-- ---------------------------------------------------------------- saved trolley lists (user-scoped)

create or replace function public.dl_list_get(p_key text, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return coalesce((select l.items from dl.lists l where l.user_id = p_user_id), '[]'::jsonb);
end $$;

create or replace function public.dl_list_save(p_key text, p_user_id uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  insert into dl.lists as l (user_id, items, updated_at) values (p_user_id, p_items, now())
  on conflict (user_id) do update set items = excluded.items, updated_at = now();
end $$;

-- ---------------------------------------------------------------- flyer uploads

create or replace function public.dl_upload_create(p_key text, p_actor uuid, p_mime text, p_b64 text,
                                                   p_sha256 text, p_caption text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_bytes bytea;
  v_id    uuid;
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  if p_b64 is null or char_length(p_b64) > 2900000 then
    raise exception 'too_large' using errcode = '22023';
  end if;
  v_bytes := decode(p_b64, 'base64');
  if encode(sha256(v_bytes), 'hex') <> p_sha256 then
    raise exception 'hash_mismatch' using errcode = '22023';
  end if;
  -- second, independent magic-byte check (the server checks first)
  if not ((p_mime = 'image/jpeg' and substring(v_bytes from 1 for 3) = '\xffd8ff'::bytea)
       or (p_mime = 'image/png'  and substring(v_bytes from 1 for 8) = '\x89504e470d0a1a0a'::bytea)
       or (p_mime = 'image/webp' and substring(v_bytes from 1 for 4) = '\x52494646'::bytea
                                 and substring(v_bytes from 9 for 4) = '\x57454250'::bytea)) then
    raise exception 'bad_image' using errcode = '22023';
  end if;
  insert into dl.uploads (mime, bytes, sha256, caption, uploaded_by)
  values (p_mime, v_bytes, p_sha256, coalesce(p_caption, ''), p_actor) returning id into v_id;
  perform dl.audit_insert('upload_added', 'info', p_actor, null,
                          jsonb_build_object('id', v_id, 'mime', p_mime, 'bytes', octet_length(v_bytes)));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.dl_upload_get(p_key text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform dl.gate(p_key);
  select jsonb_build_object('mime', u.mime, 'b64', encode(u.bytes, 'base64'), 'sha256', u.sha256)
    into v from dl.uploads u where u.id = p_id;
  return v;
end $$;

create or replace function public.dl_upload_list(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
      select u.id, u.caption, u.mime, octet_length(u.bytes) as size, u.created_at
        from dl.uploads u order by u.created_at desc limit 24) x), '[]'::jsonb);
end $$;

create or replace function public.dl_upload_delete(p_key text, p_actor uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  delete from dl.uploads where id = p_id;
  perform dl.audit_insert('upload_deleted', 'info', p_actor, null, jsonb_build_object('id', p_id));
end $$;

-- ---------------------------------------------------------------- admin bootstrap (one-time code)

create or replace function public.dl_admin_claim(p_key text, p_user_id uuid, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  perform dl.gate(p_key);
  select code_hash into v_code from dl.admin_setup
   where code_hash = p_code_hash and used_at is null and expires_at > now()
   for update;
  if v_code is null then
    return jsonb_build_object('ok', false);
  end if;
  update dl.admin_setup set used_at = now(), used_by = p_user_id where code_hash = v_code;
  update dl.users set role = 'admin' where id = p_user_id;
  perform dl.audit_insert('admin_granted', 'alert', p_user_id, null, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- housekeeping (daily cron)

create or replace function public.dl_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_sessions int;
  v_resets   int;
  v_rates    int;
  v_audit    int;
begin
  perform dl.gate(p_key);
  delete from dl.sessions where expires_at < now();
  get diagnostics v_sessions = row_count;
  delete from dl.reset_tokens where expires_at < now() - interval '1 day' or used_at < now() - interval '1 day';
  get diagnostics v_resets = row_count;
  delete from dl.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rates = row_count;
  delete from dl.audit_log where at < now() - interval '180 days';
  get diagnostics v_audit = row_count;
  return jsonb_build_object('sessions', v_sessions, 'reset_tokens', v_resets, 'rate_limits', v_rates,
                            'audit_log', v_audit);
end $$;

-- ---------------------------------------------------------------- privileges

do $$
declare f record;
begin
  -- internal helpers: owner only
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'dl' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- API functions: callable through the Data API, but useless without the server key
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'dl\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to anon, service_role', f.sig);
  end loop;
end $$;
