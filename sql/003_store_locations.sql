-- Store locations (Checkers, Pick n Pay, Makro) imported from OpenStreetMap, so "shops near you"
-- is answered from our own database instead of a live call to a public map server.

create table if not exists dl.store_locations (
  osm_id     text primary key check (osm_id ~ '^(node|way|relation)/[0-9]{1,15}$'),
  chain      text not null check (chain in ('Checkers', 'Pick n Pay', 'Makro')),
  name       text not null check (char_length(name) between 1 and 80),
  address    text not null default '' check (char_length(address) <= 120),
  lat        double precision not null check (lat between -35.5 and -21.5),
  lng        double precision not null check (lng between 16 and 33.5),
  updated_at timestamptz not null default now()
);
alter table dl.store_locations enable row level security;
revoke all on table dl.store_locations from public, anon, authenticated;

-- Internal: load an Overpass API JSON reply. Not callable through the Data API.
create or replace function dl.import_stores(p_reply jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  with els as (
    select e,
           coalesce((e ->> 'lat')::float8, (e -> 'center' ->> 'lat')::float8) as lat,
           coalesce((e ->> 'lon')::float8, (e -> 'center' ->> 'lon')::float8) as lng,
           coalesce(e -> 'tags' ->> 'brand', '') || ' ' || coalesce(e -> 'tags' ->> 'name', '') as label
      from jsonb_array_elements(coalesce(p_reply -> 'elements', '[]'::jsonb)) e
  ), m as (
    select (e ->> 'type') || '/' || (e ->> 'id') as osm_id,
           case when label ~* 'checkers' then 'Checkers'
                when label ~* 'pick\s*n\s*pay|pick''n''pay|picknpay' then 'Pick n Pay'
                when label ~* 'makro' then 'Makro' end as chain,
           left(regexp_replace(coalesce(e -> 'tags' ->> 'name', ''), '[<>`[:cntrl:]]', '', 'g'), 80) as name,
           left(regexp_replace(concat_ws(', ',
                  nullif(trim(concat_ws(' ', e -> 'tags' ->> 'addr:housenumber', e -> 'tags' ->> 'addr:street')), ''),
                  e -> 'tags' ->> 'addr:suburb', e -> 'tags' ->> 'addr:city'), '[<>`[:cntrl:]]', '', 'g'), 120) as address,
           lat, lng, label
      from els
     where lat between -35.5 and -21.5 and lng between 16 and 33.5
  )
  insert into dl.store_locations (osm_id, chain, name, address, lat, lng, updated_at)
  select osm_id, chain, coalesce(nullif(name, ''), chain), address, lat, lng, now()
    from m
   where chain is not null
     and osm_id ~ '^(node|way|relation)/[0-9]{1,15}$'
     and label !~* '\m(liquor\w*|clothing|pharmacy|pet\w*|home|express|forecourt|kiosk)\M'
  on conflict (osm_id) do update
     set chain = excluded.chain, name = excluded.name, address = excluded.address,
         lat = excluded.lat, lng = excluded.lng, updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function dl.import_stores(jsonb) from public, anon, authenticated;

-- Nearest stores per chain (Checkers and Pick n Pay within 30 km, Makro within 400 km).
create or replace function public.dl_nearby_stores(p_key text, p_lat double precision, p_lng double precision,
                                                   p_per_chain int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  if p_lat not between -35.5 and -21.5 or p_lng not between 16 and 33.5 or p_per_chain not between 1 and 10 then
    raise exception 'bad_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('chain', x.chain, 'name', x.name, 'address', x.address,
                                        'lat', round(x.lat::numeric, 5), 'lng', round(x.lng::numeric, 5),
                                        'km', round(x.km::numeric, 1), 'bearing', round(x.bearing::numeric))
                     order by x.km)
      from (
        select d.*, row_number() over (partition by d.chain order by d.km) as rn
          from (
            select s.chain, s.name, s.address, s.lat, s.lng,
                   2 * 6371 * asin(sqrt(power(sin(radians(s.lat - p_lat) / 2), 2)
                     + cos(radians(p_lat)) * cos(radians(s.lat)) * power(sin(radians(s.lng - p_lng) / 2), 2))) as km,
                   mod((degrees(atan2(sin(radians(s.lng - p_lng)) * cos(radians(s.lat)),
                     cos(radians(p_lat)) * sin(radians(s.lat))
                     - sin(radians(p_lat)) * cos(radians(s.lat)) * cos(radians(s.lng - p_lng)))) + 360)::numeric, 360) as bearing
              from dl.store_locations s
             where s.lat between p_lat - 4 and p_lat + 4 and s.lng between p_lng - 4.5 and p_lng + 4.5
          ) d
         where (d.chain = 'Makro' and d.km <= 400) or (d.chain <> 'Makro' and d.km <= 30)
      ) x
     where x.rn <= p_per_chain), '[]'::jsonb);
end $$;

create or replace function public.dl_store_count(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform dl.gate(p_key);
  return jsonb_build_object('stores', (select count(*) from dl.store_locations),
                            'updated_at', (select max(updated_at) from dl.store_locations));
end $$;

revoke all on function public.dl_nearby_stores(text, double precision, double precision, int) from public, anon, authenticated;
grant execute on function public.dl_nearby_stores(text, double precision, double precision, int) to anon, service_role;
revoke all on function public.dl_store_count(text) from public, anon, authenticated;
grant execute on function public.dl_store_count(text) to anon, service_role;
