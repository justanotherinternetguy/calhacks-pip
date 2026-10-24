// POST /functions/v1/purge  (service role / CRON_SECRET only) → purge_old_data()
import { isServiceCaller, json, preflight, serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (!isServiceCaller(req)) return json({ error: "unauthorized" }, 401);
  const { data, error } = await serviceClient().rpc("purge_old_data");
  if (error) return json({ error: error.message }, 500);
  return json({ purged: data });
});
