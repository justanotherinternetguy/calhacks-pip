// POST /functions/v1/proximity  (service role / CRON_SECRET only)
// For every group with ≥2 members in night mode, intersect their latest
// proximity tokens (<5 min old) and upsert presence(together).
import { isServiceCaller, json, preflight, serviceClient } from "../_shared/supabase.ts";
import { computePresence, latestTokens, type TokenRow } from "./presence.ts";

const MAX_AGE_MS = 5 * 60_000;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (!isServiceCaller(req)) return json({ error: "unauthorized" }, 401);

  const db = serviceClient();
  const now = Date.now();

  const { data: nightDevices, error: dErr } = await db.from("devices").select("user_id").eq("night_mode", true);
  if (dErr) return json({ error: dErr.message }, 500);
  const nightUsers = new Set((nightDevices ?? []).map((d: { user_id: string }) => d.user_id));
  if (nightUsers.size < 2) return json({ groups: 0, updated: 0 });

  const { data: memberships, error: mErr } = await db
    .from("group_members")
    .select("group_id, user_id")
    .eq("status", "active")
    .in("user_id", [...nightUsers]);
  if (mErr) return json({ error: mErr.message }, 500);

  const byGroup = new Map<string, string[]>();
  for (const m of memberships ?? []) {
    byGroup.set(m.group_id, [...(byGroup.get(m.group_id) ?? []), m.user_id]);
  }

  let groups = 0;
  let updated = 0;
  const since = new Date(now - MAX_AGE_MS).toISOString();
  for (const [groupId, users] of byGroup) {
    if (users.length < 2) continue;
    groups++;
    const { data: rows, error } = await db
      .from("proximity_tokens")
      .select("user_id, tokens, created_at")
      .eq("group_id", groupId)
      .in("user_id", users)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      console.error(`proximity: group ${groupId}: ${error.message}`);
      continue;
    }
    const presence = computePresence(latestTokens((rows ?? []) as TokenRow[], now, MAX_AGE_MS));
    const upserts = Object.entries(presence).map(([user_id, together]) => ({
      group_id: groupId,
      user_id,
      together,
      updated_at: new Date(now).toISOString(),
    }));
    if (upserts.length === 0) continue;
    const { error: uErr } = await db.from("presence").upsert(upserts, { onConflict: "group_id,user_id" });
    if (uErr) console.error(`presence upsert group ${groupId}: ${uErr.message}`);
    else updated += upserts.length;
  }
  return json({ groups, updated });
});
