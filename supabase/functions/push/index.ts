// POST /functions/v1/push
// { incidentId, kind, title, body, recipients?: userId[], critical?: boolean, data? }
// Caller must be the subject or an active member of the incident's group.
import { callerId, json, preflight, readJson, serviceClient } from "../_shared/supabase.ts";
import { groupMemberIds, type PushInput, pushToUsers } from "../_shared/push.ts";
import { type PushBody, resolveRecipients, validateBody } from "./validate.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const uid = await callerId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const body = await readJson<PushBody>(req);
  const invalid = validateBody(body);
  if (invalid) return json({ error: invalid }, 400);

  const db = serviceClient();
  const { data: incident, error } = await db
    .from("incidents")
    .select("id, user_id, group_id, resolved_at")
    .eq("id", body.incidentId!)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!incident) return json({ error: "incident not found" }, 404);

  const members = await groupMemberIds(db, incident.group_id);
  const allowed = new Set([...members, incident.user_id]);
  if (!allowed.has(uid)) return json({ error: "forbidden" }, 403);

  // Default: everyone in the group except the caller. Explicit recipients are
  // clamped to the group (so 'ring' can target just the subject).
  const recipients = resolveRecipients(allowed, uid, body.recipients);

  const input: PushInput = {
    incidentId: body.incidentId!,
    kind: body.kind!,
    title: body.title!,
    body: body.body!,
    critical: !!body.critical,
    data: body.data,
  };
  const results = await pushToUsers(db, recipients, input);
  return json({ recipients, sent: results.filter((r) => r.ok).length, results });
});
