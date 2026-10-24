import { assertEquals } from "@std/assert";
import { rpcErrorStatus, unlockStatus } from "./status.ts";

Deno.test("unlockStatus: k floor of 2, fulfilled when approvals reach k", () => {
  assertEquals(unlockStatus("r", "open", 1, 1), { requestId: "r", status: "open", approvals: 1, threshold: 2, fulfilled: false, remaining: 1 });
  assertEquals(unlockStatus("r", "open", 2, 2).fulfilled, true);
  assertEquals(unlockStatus("r", "open", 2, 2).status, "fulfilled");
  assertEquals(unlockStatus("r", "denied", 5, 2).fulfilled, false);
  assertEquals(unlockStatus("r", "open", 1, 3).remaining, 2);
});

Deno.test("rpcErrorStatus maps the RPC's errcodes", () => {
  assertEquals(rpcErrorStatus("P0001"), 409);
  assertEquals(rpcErrorStatus("P0002"), 404);
  assertEquals(rpcErrorStatus("42501"), 403);
  assertEquals(rpcErrorStatus("28000"), 401);
  assertEquals(rpcErrorStatus(undefined), 500);
});
