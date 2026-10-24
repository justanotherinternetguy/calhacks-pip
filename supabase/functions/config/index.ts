// GET /functions/v1/config → latest model_configs row { version, toml, signature }
// Public (model_configs is world-readable); clients verify `signature` on-device.
import { corsHeaders, json, preflight, serviceClient } from "../_shared/supabase.ts";
import { cacheHeaders, isNotModified, type ModelConfig } from "./cache.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const version = new URL(req.url).searchParams.get("version");
  let q = serviceClient().from("model_configs").select("version, toml, signature");
  q = version ? q.eq("version", version) : q.order("created_at", { ascending: false });
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "no model config" }, 404);

  const cfg = data as ModelConfig;
  const headers = cacheHeaders(cfg);
  if (isNotModified(req.headers.get("If-None-Match"), cfg)) {
    return new Response(null, { status: 304, headers: { ...corsHeaders, ...headers } });
  }
  return json(cfg, 200, headers);
});
