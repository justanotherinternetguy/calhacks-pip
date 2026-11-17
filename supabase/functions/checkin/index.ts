// POST /functions/v1/checkin — friends check in on each other (docs/CONTRACTS.md §13).
//   { action: "ask", targetId }                      → sticky "You okay?" on the target's phone
//   { action: "answer", checkInId, status: ok|help } → tells the asker (help is critical)
//   { action: "cancel", checkInId }                  → clears the target's sticky notification
// Authorization and state live in the SQL RPCs (ask_check_in / answer_check_in / cancel_check_in), called as the
// user so auth.uid() and RLS apply; this function only adds the pushes. Pushes carry no location.
import { callerId, json, preflight, readJson, serviceClient, userClient } from "../_shared/supabase.ts";
import { pushToUsers } from "../_shared/push.ts";
import { answerMessage, askMessage, type CheckInRow, parseRequest, statusForPgCode } from "./validate.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const uid = await callerId(req);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const parsed = parseRequest(await readJson<unknown>(req));
  if (typeof parsed === "string") return json({ error: parsed }, 400);

  const asUser = userClient(req);
  const rpc = parsed.action === "ask"
    ? asUser.rpc("ask_check_in", { p_target: parsed.targetId })
    : parsed.action === "answer"
    ? asUser.rpc("answer_check_in", { p_id: parsed.checkInId, p_status: parsed.status })
    : asUser.rpc("cancel_check_in", { p_id: parsed.checkInId });
  const { data, error } = await rpc;
  if (error) return json({ error: error.message }, statusForPgCode(error.code));
  const row = data as CheckInRow;

  const db = serviceClient();
  const nameOf = async (id: string) =>
    ((await db.from("profiles").select("display_name").eq("id", id).maybeSingle()).data?.display_name as string | undefined) ?? null;

  let sent = 0;
  try {
    if (parsed.action === "ask" && row.status === "pending") {
      const msg = askMessage(await nameOf(row.asker_id), row.deadline_at);
      const r = await pushToUsers(db, [row.target_id], {
        checkInId: row.id, kind: "checkin_request", title: msg.title, body: msg.body, critical: true,
        data: { ...msg.data, askerId: row.asker_id },
      });
      sent = r.filter((x) => x.ok).length;
    } else if (parsed.action === "answer" && (row.status === "ok" || row.status === "help")) {
      const msg = answerMessage(await nameOf(row.target_id), row.status);
      const r = await pushToUsers(db, [row.asker_id], {
        checkInId: row.id, kind: "checkin_answered", title: msg.title, body: msg.body, critical: msg.critical,
        data: { status: row.status, targetId: row.target_id },
      });
      sent = r.filter((x) => x.ok).length;
    } else if (parsed.action === "cancel") {
      const r = await pushToUsers(db, [row.target_id], {
        checkInId: row.id, kind: "checkin_cancelled", title: "Check-in cancelled", body: "", data: {},
      });
      sent = r.filter((x) => x.ok).length;
    }
  } catch (e) {
    // The row is saved either way; the phones also reconcile on their next sync.
    console.error(`checkin push failed (${parsed.action} ${row.id}):`, e);
  }
  return json({ checkIn: row, sent });
});
