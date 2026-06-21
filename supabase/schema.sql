create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  credits integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.image_jobs (
  id uuid primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  prompt text not null,
  size text not null,
  background text check (background in ('opaque', 'transparent')),
  target_size text,
  base_cost integer not null default 0 check (base_cost >= 0),
  upscale_cost integer not null default 0 check (upscale_cost >= 0),
  total_cost integer not null default 0 check (total_cost >= 0),
  status text not null check (status in ('pending', 'completed', 'partial', 'failed')),
  source_image_url text,
  source_image_jpg_url text,
  image_url text,
  image_jpg_url text,
  error text,
  reference_count integer not null default 0 check (reference_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists image_jobs_user_created_idx
  on public.image_jobs(user_id, created_at desc);

create table if not exists public.paypal_orders (
  id uuid primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  package_id text not null,
  paypal_order_id text not null unique,
  credits integer not null check (credits > 0),
  amount numeric(12, 2) not null,
  currency text not null,
  status text not null check (status in ('created', 'captured')),
  created_at timestamptz not null default now(),
  captured_at timestamptz
);

create index if not exists paypal_orders_user_created_idx
  on public.paypal_orders(user_id, created_at desc);

alter table public.app_users enable row level security;
alter table public.image_jobs enable row level security;
alter table public.paypal_orders enable row level security;

-- The Node server uses SUPABASE_SERVICE_ROLE_KEY and bypasses RLS.
-- Do not expose that key in frontend code.
