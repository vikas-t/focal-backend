-- Fix an off-by-one in the daily spend cap.
--
-- reserve_daily_spend added the request's own cost to the ceiling before
-- comparing:
--
--     if new_total > p_cap + p_estimated_cost then
--
-- so a request was only refused once spend passed cap + one request, not cap.
-- With a $3.00 cap and a $0.025 validate call, spend at $2.99 would be allowed
-- through to $3.015 and only refused on the following request, settling at
-- $3.04 — the cap behaved as a floor rather than a ceiling.
--
-- The overshoot is exactly one request's cost, so it grew when validate joined
-- the free tier: ~$0.025 per web search against ~$0.002 for an explain, and it
-- recurs every day.
--
-- new_total already includes this request (the upsert added it above), so
-- comparing it against p_cap directly is the correct test: "would this request
-- take us past the cap?" — and if so, roll the reservation back and refuse.
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

  if new_total > p_cap then
    -- This request would breach the cap; undo our reservation and refuse.
    update daily_spend
       set total_usd = total_usd - p_estimated_cost
     where day = current_date;
    return null;
  end if;

  return new_total;
end;
$$ language plpgsql security definer;
