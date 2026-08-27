-- Runtime configuration (key-value, read by the Edge Function on every request)
create table config (
  key   text primary key,
  value jsonb not null
);

alter table config enable row level security;

-- Per-install tracking
create table installs (
  install_id        uuid primary key,
  created_at        timestamptz not null default now(),
  requests_used     int not null default 0,
  requests_limit    int not null default 20,
  last_seen_at      timestamptz not null default now(),
  first_seen_ip_hash text
);

alter table installs enable row level security;

-- One row per proxied request
create table usage_events (
  id                 bigserial primary key,
  install_id         uuid not null references installs(install_id),
  mode               text not null,
  created_at         timestamptz not null default now(),
  prompt_tokens      int,
  completion_tokens  int,
  estimated_cost_usd numeric(10,6) not null default 0,
  status             text not null default 'ok'
);

create index idx_usage_events_install_created
  on usage_events (install_id, created_at);

alter table usage_events enable row level security;

-- Aggregated daily spend, maintained by trigger (not a materialized view —
-- those require manual refresh, which is a footgun for a safety control).
create table daily_spend (
  day       date primary key,
  total_usd numeric(10,6) not null default 0
);

alter table daily_spend enable row level security;

-- Trigger: on each usage_events INSERT, upsert into daily_spend
create or replace function update_daily_spend()
returns trigger as $$
begin
  insert into daily_spend (day, total_usd)
  values (date(new.created_at), new.estimated_cost_usd)
  on conflict (day)
  do update set total_usd = daily_spend.total_usd + excluded.total_usd;
  return new;
end;
$$ language plpgsql;

create trigger trg_update_daily_spend
after insert on usage_events
for each row
execute function update_daily_spend();

-- Upsert an install: creates on first sight with default limits,
-- updates last_seen_at on return visits. Returns the row so the
-- caller can check quotas without a second round trip.
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
$$ language plpgsql;
