import { assertEquals } from "@std/assert";
import { MIN_UNLOCK_MEMBERS, rpcErrorStatus, unlockStatus } from "./status.ts";

Deno.test("unlockStatus: k floor of 2, fulfilled when approvals reach k", () => {
  assertEquals(unlockStatus("r", "open", 1, 1, 3), {
    requestId: "r", status: "open", approvals: 1, threshold: 2, fulfilled: false, remaining: 1, members: 3, enabled: true,
  });
  assertEquals(unlockStatus("r", "open", 2, 2, 3).fulfilled, true);
  assertEquals(unlockStatus("r", "open", 2, 2, 3).status, "fulfilled");
  assertEquals(unlockStatus("r", "denied", 5, 2, 3).fulfilled, false);
  assertEquals(unlockStatus("r", "open", 1, 3, 4).remaining, 2);
});

Deno.test("unlockStatus: members + enabled (v1.1 needs >= 3 active members)", () => {
  assertEquals(MIN_UNLOCK_MEMBERS, 3);
  assertEquals(unlockStatus("r", "open", 0, 2, 2).members, 2);
  assertEquals(unlockStatus("r", "open", 0, 2, 2).enabled, false);
  assertEquals(unlockStatus("r", "open", 0, 2, 3).enabled, true);
  assertEquals(unlockStatus("r", "open", 0, 2, 4).enabled, true);
  // defensive: a missing/negative count never enables
  assertEquals(unlockStatus("r", "open", 0, 2, -1), { ...unlockStatus("r", "open", 0, 2, 0), members: 0, enabled: false });
  assertEquals(unlockStatus("r", "open", 0, 2, NaN).members, 0);
});

Deno.test("rpcErrorStatus maps the RPC's errcodes", () => {
  assertEquals(rpcErrorStatus("P0001"), 409);
  assertEquals(rpcErrorStatus("P0002"), 404);
  assertEquals(rpcErrorStatus("42501"), 403);
  assertEquals(rpcErrorStatus("28000"), 401);
  assertEquals(rpcErrorStatus(undefined), 500);
});
