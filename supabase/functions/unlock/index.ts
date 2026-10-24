// POST /functions/v1/unlock  { incidentId }   → { requestId }
//   runs open_unlock_request() as the caller; the RPC enforces the
//   offline/battery_dying + membership rules and raises otherwise.
// GET  /functions/v1/unlock?requestId=...      → approvals vs threshold (+ members, enabled = members >= 3)
import { callerId, json, preflight, readJson, serviceClient, userClient } from "../_shared/supabase.ts";
import { rpcErrorStatus, unlockStatus } from "./status.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const uid = await callerId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);

  if (req.method === "POST") {
    const { incidentId } = await readJson<{ incidentId?: string }>(req);
    if (!incidentId) return json({ error: "incidentId required" }, 400);
    const { data, error } = await userClient(req).rpc("open_unlock_request", { incident_id: incidentId });
    if (error) return json({ error: error.message, code: error.code }, rpcErrorStatus(error.code));
    return json({ requestId: data }, 201);
  }

  if (req.method === "GET") {
    const requestId = new URL(req.url).searchParams.get("requestId");
    if (!requestId) return json({ error: "requestId required" }, 400);
    const db = serviceClient();
    const { data: reqRow, error } = await db
      .from("unlock_requests")
      .select("id, status, requester_id, incident_id, incidents!inner(user_id, group_id, groups!inner(threshold_k))")
      .eq("id", requestId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!reqRow) return json({ error: "not found" }, 404);

    // deno-lint-ignore no-explicit-any
    const inc = (reqRow as any).incidents as { user_id: string; group_id: string; groups: { threshold_k: number } };
    const { data: member } = await db
      .from("group_members")
      .select("user_id")
      .eq("group_id", inc.group_id)
      .eq("user_id", uid)
      .eq("status", "active")
      .maybeSingle();
    if (!member && uid !== inc.user_id && uid !== reqRow.requester_id) return json({ error: "forbidden" }, 403);

    const [{ count }, { count: members }] = await Promise.all([
      db.from("unlock_approvals").select("id", { count: "exact", head: true }).eq("request_id", requestId),
      db.from("group_members").select("user_id", { count: "exact", head: true }).eq("group_id", inc.group_id).eq("status", "active"),
    ]);
    const status = unlockStatus(requestId, reqRow.status, count ?? 0, inc.groups.threshold_k, members ?? 0);
    if (status.fulfilled && reqRow.status === "open") {
      await db.from("unlock_requests").update({ status: "fulfilled" }).eq("id", requestId);
    }
    return json(status);
  }

  return json({ error: "method not allowed" }, 405);
});
