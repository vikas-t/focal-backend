-- Fix: RLS blocks service_role from accessing tables.
-- Two approaches combined:
-- 1. RPC functions use SECURITY DEFINER to run as the owner (postgres), bypassing RLS.
-- 2. Grant service_role direct access to tables the Edge Function queries directly.

-- Make upsert_install run as owner (postgres) to bypass RLS
create or replace function upsert_install(
  p_install_id uuid,
  p_requests_limit int,
  p_ip_hash text default null
)
returns installs as $$
declare
  result installs;
begin
  insert into installs (install_id, requests_limit, first_seen_ip_hash)
  values (p_install_id, p_requests_limit, p_ip_hash)
  on conflict (install_id)
  do update set last_seen_at = now()
  returning * into result;
  return result;
end;
$$ language plpgsql security definer;

-- Make daily_spend trigger run as owner too
create or replace function update_daily_spend()
returns trigger as $$
begin
  insert into daily_spend (day, total_usd)
  values (date(new.created_at), new.estimated_cost_usd)
  on conflict (day)
  do update set total_usd = daily_spend.total_usd + excluded.total_usd;
  return new;
end;
$$ language plpgsql security definer;

-- Grant service_role access to all tables (Edge Functions use service_role key)
grant select, insert, update on config to service_role;
grant select, insert, update on installs to service_role;
grant select, insert on usage_events to service_role;
grant usage on sequence usage_events_id_seq to service_role;
grant select, insert, update on daily_spend to service_role;
