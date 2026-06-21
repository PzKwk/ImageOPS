import fs from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { AppError } from "./http.js";

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  credits: number;
  createdAt: string;
};

export type StoredUser = PublicUser & {
  passwordHash: string;
};

export type ImageJob = {
  id: string;
  userId: string;
  prompt: string;
  size: string;
  background?: "opaque" | "transparent";
  targetSize?: string;
  baseCost: number;
  upscaleCost: number;
  totalCost: number;
  status: "pending" | "completed" | "partial" | "failed";
  sourceImageUrl?: string;
  sourceImageJpgUrl?: string;
  imageUrl?: string;
  imageJpgUrl?: string;
  error?: string;
  referenceCount: number;
  createdAt: string;
  completedAt?: string;
};

export type PayPalOrder = {
  id: string;
  userId: string;
  packageId: string;
  paypalOrderId: string;
  credits: number;
  amount: string;
  currency: string;
  status: "created" | "captured";
  createdAt: string;
  capturedAt?: string;
};

export type DataStore = {
  users: StoredUser[];
  imageJobs: ImageJob[];
  paypalOrders: PayPalOrder[];
};

const emptyStore: DataStore = {
  users: [],
  imageJobs: [],
  paypalOrders: []
};

let lock: Promise<void> = Promise.resolve();
let supabaseClient: SupabaseClient | null = null;

type AppUserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  credits: number;
  created_at: string;
};

type ImageJobRow = {
  id: string;
  user_id: string;
  prompt: string;
  size: string;
  background: "opaque" | "transparent" | null;
  target_size: string | null;
  base_cost: number;
  upscale_cost: number;
  total_cost: number;
  status: ImageJob["status"];
  source_image_url: string | null;
  source_image_jpg_url: string | null;
  image_url: string | null;
  image_jpg_url: string | null;
  error: string | null;
  reference_count: number;
  created_at: string;
  completed_at: string | null;
};

type PayPalOrderRow = {
  id: string;
  user_id: string;
  package_id: string;
  paypal_order_id: string;
  credits: number;
  amount: string;
  currency: string;
  status: PayPalOrder["status"];
  created_at: string;
  captured_at: string | null;
};

function useSupabase() {
  return config.dataBackend.toLowerCase() === "supabase";
}

function getSupabase() {
  if (!useSupabase()) {
    return null;
  }

  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new AppError(
      503,
      "supabase_not_configured",
      "DATA_BACKEND=supabase benoetigt SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  if (!supabaseClient) {
    supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return supabaseClient;
}

function userFromRow(row: AppUserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    credits: row.credits,
    createdAt: row.created_at
  };
}

function userToRow(user: StoredUser): AppUserRow {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    password_hash: user.passwordHash,
    credits: user.credits,
    created_at: user.createdAt
  };
}

function jobFromRow(row: ImageJobRow): ImageJob {
  return {
    id: row.id,
    userId: row.user_id,
    prompt: row.prompt,
    size: row.size,
    background: row.background ?? undefined,
    targetSize: row.target_size ?? undefined,
    baseCost: row.base_cost,
    upscaleCost: row.upscale_cost,
    totalCost: row.total_cost,
    status: row.status,
    sourceImageUrl: row.source_image_url ?? undefined,
    sourceImageJpgUrl: row.source_image_jpg_url ?? undefined,
    imageUrl: row.image_url ?? undefined,
    imageJpgUrl: row.image_jpg_url ?? undefined,
    error: row.error ?? undefined,
    referenceCount: row.reference_count,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined
  };
}

function jobToRow(job: ImageJob): ImageJobRow {
  return {
    id: job.id,
    user_id: job.userId,
    prompt: job.prompt,
    size: job.size,
    background: job.background ?? null,
    target_size: job.targetSize ?? null,
    base_cost: job.baseCost,
    upscale_cost: job.upscaleCost,
    total_cost: job.totalCost,
    status: job.status,
    source_image_url: job.sourceImageUrl ?? null,
    source_image_jpg_url: job.sourceImageJpgUrl ?? null,
    image_url: job.imageUrl ?? null,
    image_jpg_url: job.imageJpgUrl ?? null,
    error: job.error ?? null,
    reference_count: job.referenceCount,
    created_at: job.createdAt,
    completed_at: job.completedAt ?? null
  };
}

function paypalFromRow(row: PayPalOrderRow): PayPalOrder {
  return {
    id: row.id,
    userId: row.user_id,
    packageId: row.package_id,
    paypalOrderId: row.paypal_order_id,
    credits: row.credits,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    capturedAt: row.captured_at ?? undefined
  };
}

function paypalToRow(order: PayPalOrder): PayPalOrderRow {
  return {
    id: order.id,
    user_id: order.userId,
    package_id: order.packageId,
    paypal_order_id: order.paypalOrderId,
    credits: order.credits,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    created_at: order.createdAt,
    captured_at: order.capturedAt ?? null
  };
}

function assertNoError(error: unknown, context: string) {
  if (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    throw new AppError(502, "supabase_error", `${context}: ${message}`);
  }
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  await fs.mkdir(config.generatedDir, { recursive: true });
  try {
    await fs.access(config.dataFile);
  } catch {
    await fs.writeFile(config.dataFile, JSON.stringify(emptyStore, null, 2), "utf8");
  }
}

async function readData(): Promise<DataStore> {
  if (useSupabase()) {
    return readSupabaseData();
  }

  await ensureDataFile();
  const raw = await fs.readFile(config.dataFile, "utf8");
  const parsed = JSON.parse(raw) as Partial<DataStore>;
  return {
    users: parsed.users ?? [],
    imageJobs: parsed.imageJobs ?? [],
    paypalOrders: parsed.paypalOrders ?? []
  };
}

async function writeData(store: DataStore) {
  if (useSupabase()) {
    await writeSupabaseData(store);
    return;
  }

  await fs.writeFile(config.dataFile, JSON.stringify(store, null, 2), "utf8");
}

async function readSupabaseData(): Promise<DataStore> {
  const supabase = getSupabase();
  if (!supabase) return emptyStore;

  const [usersResult, jobsResult, ordersResult] = await Promise.all([
    supabase.from("app_users").select("*"),
    supabase.from("image_jobs").select("*"),
    supabase.from("paypal_orders").select("*")
  ]);

  assertNoError(usersResult.error, "Supabase app_users read failed");
  assertNoError(jobsResult.error, "Supabase image_jobs read failed");
  assertNoError(ordersResult.error, "Supabase paypal_orders read failed");

  return {
    users: ((usersResult.data ?? []) as AppUserRow[]).map(userFromRow),
    imageJobs: ((jobsResult.data ?? []) as ImageJobRow[]).map(jobFromRow),
    paypalOrders: ((ordersResult.data ?? []) as PayPalOrderRow[]).map(paypalFromRow)
  };
}

async function writeSupabaseData(store: DataStore) {
  const supabase = getSupabase();
  if (!supabase) return;

  if (store.users.length > 0) {
    const { error } = await supabase.from("app_users").upsert(store.users.map(userToRow));
    assertNoError(error, "Supabase app_users write failed");
  }

  if (store.imageJobs.length > 0) {
    const { error } = await supabase.from("image_jobs").upsert(store.imageJobs.map(jobToRow));
    assertNoError(error, "Supabase image_jobs write failed");
  }

  if (store.paypalOrders.length > 0) {
    const { error } = await supabase.from("paypal_orders").upsert(store.paypalOrders.map(paypalToRow));
    assertNoError(error, "Supabase paypal_orders write failed");
  }
}

export async function readStore<T>(reader: (store: DataStore) => T | Promise<T>) {
  const store = await readData();
  return reader(store);
}

export async function updateStore<T>(writer: (store: DataStore) => T | Promise<T>) {
  const run = lock.then(async () => {
    const store = await readData();
    const result = await writer(store);
    await writeData(store);
    return result;
  });

  lock = run.then(
    () => undefined,
    () => undefined
  );

  return run;
}

export function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    credits: user.credits,
    createdAt: user.createdAt
  };
}
