-- Filmujha loyalty: Supabase table (SQL Editor mein ek baar chalaiye)
-- Poora app data ek jsonb row mein rehta hai (id = 'main').

create table if not exists public.app_state (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Security: RLS on aur koi policy nahi, yani public/anon key se koi bhi
-- is table ko padh ya badal nahi sakta. Sirf server (secret/service_role key) access karta hai.
alter table public.app_state enable row level security;
