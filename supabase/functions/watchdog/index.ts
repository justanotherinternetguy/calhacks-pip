// POST /functions/v1/watchdog   (service role / CRON_SECRET only)
// Body optional: { incidentIds?: string[] } — when pg_cron already ran
// watchdog_tick() it posts the new ids here; otherwise we run the tick.
import { isServiceCaller, json, preflight, readJson, serviceClient } from "../_shared/supabase.ts";
import { groupMemberIds, pushToUsers } from "../_shared/push.ts";
import { type IncidentRow, watchdogMessage } from "./message.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (!isServiceCaller(req)) return json({ error: "unauthorized" }, 401);

  const db = serviceClient();
  const body = req.method === "POST" ? await readJson<{ incidentIds?: string[] }>(req) : {};

  let incidents: IncidentRow[] = [];
  if (body.incidentIds?.length) {
    const { data, error } = await db
      .from("incidents")
      .select("id, user_id, group_id, level, summary, opened_at")
      .in("id", body.incidentIds);
    if (error) return json({ error: error.message }, 500);
    incidents = (data ?? []) as IncidentRow[];
  } else {
    const { data, error } = await db.rpc("watchdog_tick");
    if (error) return json({ error: error.message }, 500);
    incidents = (data ?? []) as IncidentRow[];
  }

  const out = [];
  for (const inc of incidents) {
    try {
      const { data: profile } = await db.from("profiles").select("display_name").eq("id", inc.user_id).maybeSingle();
      const msg = watchdogMessage(inc, profile?.display_name);
      const recipients = await groupMemberIds(db, inc.group_id, [inc.user_id]);
      const results = await pushToUsers(db, recipients, {
        incidentId: inc.id,
        kind: inc.level,
        title: msg.title,
        body: msg.body,
        critical: msg.critical,
        data: { level: inc.level, userId: inc.user_id, groupId: inc.group_id },
      });
      out.push({ incidentId: inc.id, level: inc.level, recipients: recipients.length, sent: results.filter((r) => r.ok).length });
    } catch (e) {
      console.error(`watchdog push failed for incident ${inc.id}:`, e);
      out.push({ incidentId: inc.id, level: inc.level, error: String(e) });
    }
  }
  return json({ opened: incidents.length, pushed: out });
});
