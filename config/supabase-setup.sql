-- ClassPing Attendance storage table.
-- Run this once in Supabase Dashboard > SQL Editor.
-- The app uses a server-side Supabase Secret key. Never put that key in browser code or GitHub.

create table if not exists public.classping_state (
  id text primary key check (id = 'main'),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.classping_state enable row level security;

-- No direct browser access. Only the backend's Supabase Secret key can access this table.
revoke all on table public.classping_state from anon, authenticated;
grant all on table public.classping_state to service_role;
