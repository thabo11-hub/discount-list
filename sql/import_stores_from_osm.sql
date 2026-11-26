-- (Re)import Checkers, Pick n Pay and Makro locations in South Africa from OpenStreetMap.
-- Run in the Supabase SQL editor when you want fresher store data (first loaded 26 Nov 2026:
-- 247 Checkers, 453 Pick n Pay, 21 Makro). It turns the http extension on only for the import
-- and off again afterwards. Store data © OpenStreetMap contributors (ODbL).

create extension if not exists http with schema extensions;
select extensions.http_set_curlopt('CURLOPT_TIMEOUT', '120');

-- Pass 1: shops tagged with the brand (fast exact-tag lookup).
with r as (
  select status, content from extensions.http_post(
    'https://overpass-api.de/api/interpreter',
    'data=' || extensions.urlencode('[out:json][timeout:80];
(
  nwr["brand"="Checkers"]; nwr["brand"="Checkers Hyper"];
  nwr["brand"="Pick n Pay"]; nwr["brand"="Pick n Pay Hyper"]; nwr["brand"="Pick n Pay Family"]; nwr["brand"="Pick n Pay Local"];
  nwr["brand"="Makro"];
);
out center tags;'),
    'application/x-www-form-urlencoded')
)
select status, case when status = 200 and content like '{%' then dl.import_stores(content::jsonb) end as stores_loaded,
       case when status <> 200 or content not like '{%' then left(content, 300) end as problem
  from r;

-- Pass 2: shops tagged only by name, inside South Africa's bounding box.
with r as (
  select status, content from extensions.http_post(
    'https://overpass-api.de/api/interpreter',
    'data=' || extensions.urlencode('[out:json][timeout:110][bbox:-35,16,-22,33];
nwr["shop"]["name"~"^(Checkers|Pick n Pay|Makro)",i];
out center tags;'),
    'application/x-www-form-urlencoded')
)
select status, case when status = 200 and content like '{%' then dl.import_stores(content::jsonb) end as stores_loaded,
       case when status <> 200 or content not like '{%' then left(content, 300) end as problem
  from r;

drop extension if exists http;
select chain, count(*) from dl.store_locations group by chain order by chain;
