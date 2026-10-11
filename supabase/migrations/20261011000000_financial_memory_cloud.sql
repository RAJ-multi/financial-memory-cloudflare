-- Financial Memory cloud sync (private per-user JSON payload).
-- Safe to run in the Supabase SQL Editor more than once.
create table if not exists public.financial_memory_cloud (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint financial_memory_cloud_payload_is_object
    check (jsonb_typeof(payload) = 'object')
);

alter table public.financial_memory_cloud enable row level security;

revoke all on table public.financial_memory_cloud from public, anon;
grant select, insert, update, delete on table public.financial_memory_cloud to authenticated;

drop policy if exists "Users can read their own financial data" on public.financial_memory_cloud;
create policy "Users can read their own financial data"
  on public.financial_memory_cloud
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own financial data" on public.financial_memory_cloud;
create policy "Users can insert their own financial data"
  on public.financial_memory_cloud
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own financial data" on public.financial_memory_cloud;
create policy "Users can update their own financial data"
  on public.financial_memory_cloud
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own financial data" on public.financial_memory_cloud;
create policy "Users can delete their own financial data"
  on public.financial_memory_cloud
  for delete to authenticated
  using (auth.uid() = user_id);
