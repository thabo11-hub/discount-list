-- Shopper prices: a signed-in shopper reports the price on the shelf at a shop (found by barcode).
-- A report stays private until the admin approves it. Approved prices show for everyone, marked
-- with the day they were seen, and drop off after 30 days because shelf prices change.

create table if not exists dl.price_reports (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references dl.users(id) on delete set null,
  gtin             text not null check (gtin ~ '^([0-9]{8}|[0-9]{12,14})$'),
  store_id         text not null references dl.stores(id) on delete cascade,
  branch           text not null default '' check (char_length(branch) <= 80),
  name             text not null check (char_length(name) between 1 and 60),
  brand            text not null default '' check (char_length(brand) <= 60),
  deal_qty         int  not null default 1 check (deal_qty between 1 and 100),
  deal_price_cents int  not null check (deal_price_cents between 1 and 10000000),
  seen_on          date not null,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at       timestamptz not null default now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid references dl.users(id) on delete set null
);
create index if not exists price_reports_status_idx on dl.price_reports(status, created_at desc);
create index if not exists price_reports_user_idx on dl.price_reports(user_id, created_at desc);
create index if not exists price_reports_live_idx on dl.price_reports(gtin, store_id, seen_on desc) where status = 'approved';
-- One open report per shopper, product, shop and day: a second one updates the first.
create unique index if not exists price_reports_one_open
  on dl.price_reports(user_id, gtin, store_id, seen_on) where status = 'pending';

alter table dl.price_reports enable row level security;
revoke all on table dl.price_reports from public, anon, authenticated;

-- A shopper's report. p_user_id comes from the signed-in session, never from the browser.
create or replace function public.dl_report_create(p_key text, p_user_id uuid, p_gtin text, p_store_id text,
                                                   p_branch text, p_name text, p_brand text, p_deal_qty int,
                                                   p_price_cents int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  perform dl.gate(p_key);
  perform 1 from dl.users where id = p_user_id for update;   -- serialise reports per shopper
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from dl.price_reports where user_id = p_user_id and status = 'pending') >= 40
     and not exists (select 1 from dl.price_reports where user_id = p_user_id and gtin = p_gtin
                        and store_id = p_store_id and seen_on = v_today and status = 'pending') then
    raise exception 'too_many_pending' using errcode = 'P0001';
  end if;
  insert into dl.price_reports (user_id, gtin, store_id, branch, name, brand, deal_qty, deal_price_cents, seen_on)
  values (p_user_id, p_gtin, p_store_id, coalesce(p_branch, ''), p_name, coalesce(p_brand, ''), p_deal_qty,
          p_price_cents, v_today)
  on conflict (user_id, gtin, store_id, seen_on) where status = 'pending'
  do update set branch = excluded.branch, name = excluded.name, brand = excluded.brand,
                deal_qty = excluded.deal_qty, deal_price_cents = excluded.deal_price_cents, created_at = now()
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.dl_reports_mine(p_key text, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'gtin', r.gtin, 'store_id', r.store_id, 'branch', r.branch,
                                        'name', r.name, 'brand', r.brand, 'deal_qty', r.deal_qty,
                                        'deal_price_cents', r.deal_price_cents, 'seen_on', r.seen_on,
                                        'status', r.status) order by r.created_at desc)
      from (select * from dl.price_reports where user_id = p_user_id order by created_at desc limit 20) r), '[]'::jsonb);
end $$;

-- Everyone: the newest approved price per product and shop from the last 30 days.
create or replace function public.dl_shopper_prices(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  perform dl.gate(p_key);
  return (
    with live as (
      select distinct on (r.gtin, r.store_id) r.*
        from dl.price_reports r
       where r.status = 'approved' and r.seen_on >= v_today - 30
       order by r.gtin, r.store_id, r.seen_on desc, r.reviewed_at desc
    ), named as (
      select distinct on (l.gtin) l.gtin, l.name
        from live l order by l.gtin, l.seen_on desc, l.reviewed_at desc
    ), top as (
      select n.* from named n
       order by (select max(l.seen_on) from live l where l.gtin = n.gtin) desc, n.gtin
       limit 300
    )
    select jsonb_build_object(
      'products', coalesce((select jsonb_agg(jsonb_build_object('id', 'c-' || t.gtin, 'gtin', t.gtin, 'name', t.name)
                                             order by t.name, t.gtin) from top t), '[]'::jsonb),
      'offers', coalesce((select jsonb_agg(jsonb_build_object('product_id', 'c-' || l.gtin, 'store_id', l.store_id,
                                                              'brand', l.brand, 'deal_text', '', 'deal_qty', l.deal_qty,
                                                              'deal_price_cents', l.deal_price_cents, 'pack_amount', 1,
                                                              'in_stock', true, 'seen_on', l.seen_on, 'branch', l.branch,
                                                              'updated_at', l.reviewed_at)
                                           order by l.gtin, l.store_id)
                            from live l where l.gtin in (select gtin from top)), '[]'::jsonb),
      'updated_at', (select max(reviewed_at) from live)));
end $$;

-- Admin: reports waiting for a check ('pending') or live ones ('approved'), newest first.
create or replace function public.dl_reports_admin(p_key text, p_actor uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  if p_status not in ('pending', 'approved') then
    raise exception 'bad_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'gtin', r.gtin, 'store_id', r.store_id, 'branch', r.branch, 'name', r.name,
             'brand', r.brand, 'deal_qty', r.deal_qty, 'deal_price_cents', r.deal_price_cents,
             'seen_on', r.seen_on, 'status', r.status, 'created_at', r.created_at,
             'reporter', case when u.email is null then 'deleted account'
                              else left(split_part(u.email, '@', 1), 2) || '…@' || split_part(u.email, '@', 2) end,
             'reporter_approved', (select count(*) from dl.price_reports a
                                    where a.user_id = r.user_id and a.status = 'approved'),
             'live_cents', (select l.deal_price_cents / l.deal_qty from dl.price_reports l
                             where l.gtin = r.gtin and l.store_id = r.store_id and l.status = 'approved'
                               and l.id <> r.id and l.seen_on >= v_today - 30
                             order by l.seen_on desc, l.reviewed_at desc limit 1))
           order by r.created_at desc)
      from (select * from dl.price_reports
             where status = p_status and (p_status = 'pending' or seen_on >= v_today - 30)
             order by created_at desc limit 100) r
      left join dl.users u on u.id = r.user_id), '[]'::jsonb);
end $$;

create or replace function public.dl_report_review(p_key text, p_actor uuid, p_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  perform dl.gate(p_key);
  perform dl.require_admin(p_actor);
  if p_decision not in ('approve', 'reject') then
    raise exception 'bad_input' using errcode = '22023';
  end if;
  update dl.price_reports
     set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
         reviewed_at = now(), reviewed_by = p_actor
   where id = p_id and status in ('pending', 'approved')
     and not (p_decision = 'approve' and status = 'approved')
  returning status into v_status;
  if v_status is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform dl.audit_insert('price_report_reviewed', 'info', p_actor, null,
                          jsonb_build_object('id', p_id, 'status', v_status));
  return jsonb_build_object('id', p_id, 'status', v_status);
end $$;

-- Old reports are not needed: rejected after 30 days, the rest after 180 days.
create or replace function public.dl_reports_cleanup(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  perform dl.gate(p_key);
  delete from dl.price_reports
   where (status = 'rejected' and coalesce(reviewed_at, created_at) < now() - interval '30 days')
      or created_at < now() - interval '180 days';
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('dl_report_create', 'dl_reports_mine', 'dl_shopper_prices', 'dl_reports_admin',
                                'dl_report_review', 'dl_reports_cleanup') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to anon, service_role', f.sig);
  end loop;
end $$;
