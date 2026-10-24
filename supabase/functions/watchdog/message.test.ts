import { assertEquals } from "@std/assert";
import { watchdogMessage } from "./message.ts";

const base = { id: "i", user_id: "u", group_id: "g" };

Deno.test("offline message uses the SQL summary and is critical", () => {
  const m = watchdogMessage({ ...base, level: "offline", summary: "phone went offline at 01:42 UTC" }, "Sam");
  assertEquals(m, { title: "Sam's phone went offline", body: "phone went offline at 01:42 UTC", critical: true });
});

Deno.test("battery message falls back to a generic name", () => {
  const m = watchdogMessage({ ...base, level: "battery_dying", summary: "" }, null);
  assertEquals(m.title, "Your friend's phone is about to die");
  assertEquals(m.critical, true);
});

Deno.test("heads_up is not critical", () => {
  assertEquals(watchdogMessage({ ...base, level: "heads_up", summary: "s" }, "A").critical, false);
});
