-- Private shopper items: a signed-in shopper adds a product with the prices they found at each
-- shop. Only that shopper can see, change or compare it. Also allows comparing per kg.

alter table dl.products drop constraint if exists products_unit_check;
alter table dl.products add constraint products_unit_check check (unit in ('item', 'litre', 'kg'));

create table if not exists dl.user_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references dl.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  unit       text not null default 'item' check (unit in ('item', 'litre', 'kg')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_items_user_idx on dl.user_items(user_id);

create table if not exists dl.user_item_offers (
  item_id          uuid not null references dl.user_items(id) on delete cascade,
  store_id         text not null references dl.stores(id) on delete cascade,
  brand            text not null default '' check (char_length(brand) <= 60),
  deal_text        text not null default '' check (char_length(deal_text) <= 80),
  deal_qty         int  not null default 1 check (deal_qty between 1 and 100),
  deal_price_cents int  check (deal_price_cents between 1 and 10000000),
  pack_amount      numeric(8,3) not null default 1 check (pack_amount > 0 and pack_amount <= 1000),
  in_stock         boolean not null default true,
  primary key (item_id, store_id),
  check (not in_stock or deal_price_cents is not null)
);

alter table dl.user_items enable row level security;
alter table dl.user_item_offers enable row level security;
revoke all on table dl.user_items from public, anon, authenticated;
revoke all on table dl.user_item_offers from public, anon, authenticated;

-- Every function is scoped to p_user_id, which the server takes from the signed-in session.
create or replace function public.dl_user_items(p_key text, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', i.id, 'name', i.name, 'unit', i.unit, 'updated_at', i.updated_at,
             'offers', coalesce((select jsonb_agg(jsonb_build_object(
                          'store_id', o.store_id, 'brand', o.brand, 'deal_text', o.deal_text,
                          'deal_qty', o.deal_qty, 'deal_price_cents', o.deal_price_cents,
                          'pack_amount', o.pack_amount, 'in_stock', o.in_stock) order by o.store_id)
                        from dl.user_item_offers o where o.item_id = i.id), '[]'::jsonb))
           order by i.created_at)
      from dl.user_items i where i.user_id = p_user_id), '[]'::jsonb);
end $$;

create or replace function public.dl_user_item_save(p_key text, p_user_id uuid, p_id uuid, p_name text,
                                                    p_unit text, p_offers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform dl.gate(p_key);
  if p_offers is null or jsonb_typeof(p_offers) <> 'array'
     or jsonb_array_length(p_offers) not between 1 and 10 then
    raise exception 'bad_offers' using errcode = '22023';
  end if;
  perform 1 from dl.users where id = p_user_id for update;   -- serialise saves per shopper
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_id is null then
    if (select count(*) from dl.user_items where user_id = p_user_id) >= 50 then
      raise exception 'too_many_items' using errcode = 'P0001';
    end if;
    insert into dl.user_items (user_id, name, unit) values (p_user_id, p_name, p_unit) returning id into v_id;
  else
    update dl.user_items set name = p_name, unit = p_unit, updated_at = now()
     where id = p_id and user_id = p_user_id
    returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    delete from dl.user_item_offers where item_id = v_id;
  end if;
  insert into dl.user_item_offers (item_id, store_id, brand, deal_text, deal_qty, deal_price_cents, pack_amount, in_stock)
  select v_id, x.store_id, coalesce(x.brand, ''), coalesce(x.deal_text, ''), coalesce(x.deal_qty, 1),
         x.deal_price_cents, coalesce(x.pack_amount, 1), coalesce(x.in_stock, true)
    from jsonb_to_recordset(p_offers)
      as x(store_id text, brand text, deal_text text, deal_qty int, deal_price_cents int,
           pack_amount numeric, in_stock boolean);
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.dl_user_item_delete(p_key text, p_user_id uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform dl.gate(p_key);
  delete from dl.user_items where id = p_id and user_id = p_user_id returning id into v_id;
  return jsonb_build_object('deleted', v_id is not null);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('dl_user_items', 'dl_user_item_save', 'dl_user_item_delete') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to anon, service_role', f.sig);
  end loop;
end $$;
