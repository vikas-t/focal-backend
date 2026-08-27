-- Fix: consume_quota returns a row with all-null fields instead of SQL NULL
-- when quota is exhausted. Use FOUND to detect if the UPDATE matched.
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

  if not found then
    return null;
  end if;

  return result;
end;
$$ language plpgsql security definer;
