-- Test-only: lets scripts/fake-postgrest.mjs call public.dl_* functions the way the Supabase
-- Data API does (as the anon role, arguments matched by name). Never applied to production.
create schema if not exists test;
grant usage on schema test to anon;

create or replace function test.rpc(p_fn text, p_args jsonb) returns jsonb
language plpgsql as $$
declare
  v_oid   oid;
  v_names text[];
  v_types oid[];
  v_ret   oid;
  v_list  text := '';
  v_keys  text[];
  v_res   jsonb;
  i       int;
begin
  select p.oid, p.proargnames, array(select unnest(p.proargtypes)), p.prorettype
    into v_oid, v_names, v_types, v_ret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_fn;
  if v_oid is null then
    raise exception 'Could not find the function public.%', p_fn using errcode = 'PT404';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(p_args) k;
  if v_keys is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(v_names) x) then
    raise exception 'Could not find the function public.% with those arguments', p_fn using errcode = 'PT404';
  end if;
  for i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    v_list := v_list || case when i > 1 then ', ' else '' end || format('%I => ', v_names[i]) ||
      case when v_types[i] = 'jsonb'::regtype then format('($1 -> %L)', v_names[i])
           else format('($1 ->> %L)::%s', v_names[i], format_type(v_types[i], null)) end;
  end loop;
  if v_ret = 'void'::regtype then
    execute format('select public.%I(%s)', p_fn, v_list) using p_args;
    return null;
  end if;
  execute format('select to_jsonb(public.%I(%s))', p_fn, v_list) using p_args into v_res;
  return v_res;
end $$;
grant execute on function test.rpc(text, jsonb) to anon;
