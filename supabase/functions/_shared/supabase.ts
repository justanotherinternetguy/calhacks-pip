// Shared Supabase helpers for edge functions.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

/** Service-role client: bypasses RLS. Only ever used server-side. */
export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client acting as the caller (RLS applies, auth.uid() works in RPCs). */
export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  });
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** Resolve the calling user's id from their JWT, or null. */
export async function callerId(req: Request): Promise<string | null> {
  const jwt = bearer(req);
  if (!jwt) return null;
  const { data, error } = await serviceClient().auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * For cron-style functions (watchdog, proximity, purge): the caller must
 * present the service-role key or the shared CRON_SECRET.
 */
export function isServiceCaller(req: Request): boolean {
  const token = bearer(req);
  if (!token) return false;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cron = Deno.env.get("CRON_SECRET");
  return (!!svc && token === svc) || (!!cron && token === cron) ||
    req.headers.get("x-cron-secret") === cron && !!cron;
}

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...headers },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders }) : null;
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
