-- Add separate validate quota: 5 free validates per install

alter table installs
  add column validates_used  int not null default 0,
  add column validates_limit int not null default 5;

-- Atomic consume for validate requests
create or replace function consume_validate_quota(
  p_install_id uuid,
  p_validates_limit int,
  p_ip_hash text default null
)
returns installs as $$
declare
  result installs;
begin
  insert into installs (install_id, validates_limit, first_seen_ip_hash)
  values (p_install_id, p_validates_limit, p_ip_hash)
  on conflict (install_id)
  do update set last_seen_at = now();

  update installs
     set validates_used = validates_used + 1,
         last_seen_at   = now()
   where install_id = p_install_id
     and validates_used < validates_limit
  returning * into result;

  if not found then
    return null;
  end if;

  return result;
end;
$$ language plpgsql security definer;

-- Enable validate in free_modes
update config set value = '["explain", "summarize", "worth_reading", "validate"]'
  where key = 'free_modes';

-- Add config for validate limit
insert into config (key, value) values ('free_validates_per_install', '5')
  on conflict (key) do nothing;
