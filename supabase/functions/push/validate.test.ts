import { assertEquals } from "@std/assert";
import { resolveRecipients, validateBody } from "./validate.ts";

Deno.test("validateBody rejects missing fields", () => {
  assertEquals(validateBody({} as never), "incidentId required");
  assertEquals(validateBody({ incidentId: "i" }), "kind required");
  assertEquals(validateBody({ incidentId: "i", kind: "ring" }), "title required");
  assertEquals(validateBody({ incidentId: "i", kind: "ring", title: "t" }), "body required");
  assertEquals(validateBody({ incidentId: "i", kind: "ring", title: "t", body: "", recipients: "x" as never }), "recipients must be an array");
  assertEquals(validateBody({ incidentId: "i", kind: "ring", title: "t", body: "b" }), null);
});

Deno.test("resolveRecipients defaults to group minus caller and clamps explicit lists", () => {
  const allowed = new Set(["a", "b", "c"]);
  assertEquals(resolveRecipients(allowed, "a").sort(), ["b", "c"]);
  assertEquals(resolveRecipients(allowed, "b", ["a", "zzz", "b", "a"]), ["a"]);
  assertEquals(resolveRecipients(allowed, "a", []).sort(), ["b", "c"]);
});
