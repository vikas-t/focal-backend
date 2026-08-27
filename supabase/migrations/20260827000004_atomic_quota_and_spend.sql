-- Issue 1: Atomic quota check-and-increment.
-- Collapses the old steps 3-6 (upsert, check, rate limit, reserve) into a
-- single atomic operation for the quota part. Returns NULL if quota exhausted.
create or replace function consume_quota(
  p_install_id uuid,
  p_requests_limit int,
  p_ip_hash text default null
)
returns installs as $$
declare
  result installs;
begin
  -- Upsert: create on first sight, touch last_seen on return
  insert into installs (install_id, requests_limit, first_seen_ip_hash)
  values (p_install_id, p_requests_limit, p_ip_hash)
  on conflict (install_id)
  do update set last_seen_at = now();

  -- Atomic check-and-increment: only succeeds if under limit
  update installs
     set requests_used = requests_used + 1,
         last_seen_at  = now()
   where install_id = p_install_id
     and requests_used < requests_limit
  returning * into result;

  return result;  -- NULL means quota exhausted
end;
$$ language plpgsql security definer;

-- Issue 2: Atomic spend reservation.
-- Reserves estimated cost in daily_spend BEFORE the OpenAI call.
-- Returns the new total. If the reservation would exceed the cap, returns NULL.
create or replace function reserve_daily_spend(
  p_estimated_cost numeric,
  p_cap numeric
)
returns numeric as $$
declare
  new_total numeric;
begin
  insert into daily_spend (day, total_usd)
  values (current_date, p_estimated_cost)
  on conflict (day)
  do update set total_usd = daily_spend.total_usd + p_estimated_cost
  returning total_usd into new_total;

  if new_total > p_cap + p_estimated_cost then
    -- We just pushed it over; roll back our reservation
    update daily_spend
       set total_usd = total_usd - p_estimated_cost
     where day = current_date;
    return null;
  end if;

  return new_total;
end;
$$ language plpgsql security definer;

-- Issue 2 follow-up: Reconcile after the OpenAI call completes.
-- Adjusts the reserved amount to the actual cost.
create or replace function reconcile_daily_spend(
  p_reserved numeric,
  p_actual numeric
)
returns void as $$
begin
  update daily_spend
     set total_usd = total_usd + (p_actual - p_reserved)
   where day = current_date;
end;
$$ language plpgsql security definer;

-- Issue 3: Seed free_modes config
insert into config (key, value) values
  ('free_modes', '["explain", "summarize", "worth_reading"]')
on conflict (key) do nothing;
