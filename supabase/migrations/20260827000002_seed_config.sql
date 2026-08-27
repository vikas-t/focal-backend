insert into config (key, value) values
  ('free_requests_per_install', '20'),
  ('daily_spend_cap_usd', '3.00'),
  ('rate_limit_per_minute', '10'),
  ('model', '"gpt-4o-mini"'),
  ('kill_switch', 'false')
on conflict (key) do nothing;
