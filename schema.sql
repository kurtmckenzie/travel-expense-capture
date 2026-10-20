-- Travel Expenses: run this once in Supabase -> SQL Editor -> New query -> Run.

-- 1. Table ------------------------------------------------------------------
create table if not exists public.expenses (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  expense_date   date not null,
  amount         numeric(14,2) not null check (amount > 0),
  currency       text not null,
  category       text not null,
  trip           text,
  purpose        text not null,
  payment_method text,
  notes          text,
  status         text not null default 'Draft' check (status in ('Draft','Exported')),
  photo_paths    text[] not null default '{}',
  deleted        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists expenses_user_date_idx on public.expenses (user_id, expense_date);

-- 2. Row level security: each signed-in user sees only their own rows -----------
alter table public.expenses enable row level security;

drop policy if exists "own rows select" on public.expenses;
drop policy if exists "own rows insert" on public.expenses;
drop policy if exists "own rows update" on public.expenses;
drop policy if exists "own rows delete" on public.expenses;

create policy "own rows select" on public.expenses for select to authenticated using (user_id = auth.uid());
create policy "own rows insert" on public.expenses for insert to authenticated with check (user_id = auth.uid());
create policy "own rows update" on public.expenses for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows delete" on public.expenses for delete to authenticated using (user_id = auth.uid());

-- 3. Private storage bucket for receipt photos -------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = false;

-- Files live at  <user id>/<expense id>/<photo id>.jpg  so the first folder is the owner.
drop policy if exists "receipts select own" on storage.objects;
drop policy if exists "receipts insert own" on storage.objects;
drop policy if exists "receipts update own" on storage.objects;
drop policy if exists "receipts delete own" on storage.objects;

create policy "receipts select own" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts update own" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
