import { assertEquals } from "@std/assert";
import { computePresence, latestTokens } from "./presence.ts";

Deno.test("computePresence: overlapping tokens → together, otherwise separated", () => {
  assertEquals(
    computePresence({ a: ["x", "y"], b: ["y", "z"], c: ["q"] }),
    { a: true, b: true, c: false },
  );
});

Deno.test("computePresence: single user is separated; users without tokens are omitted", () => {
  assertEquals(computePresence({ a: ["x"] }), { a: false });
  assertEquals(computePresence({ a: ["x"], b: [] }), { a: false });
  assertEquals(computePresence({}), {});
});

Deno.test("computePresence: transitive groups mark everyone touching anyone", () => {
  // a~b and b~c but a!~c: all three are 'together' with at least one friend
  assertEquals(computePresence({ a: ["1"], b: ["1", "2"], c: ["2"] }), { a: true, b: true, c: true });
});

Deno.test("latestTokens keeps the newest fresh row per user", () => {
  const now = Date.parse("2026-10-24T01:00:00Z");
  const rows = [
    { user_id: "a", tokens: ["old"], created_at: "2026-10-24T00:58:00Z" },
    { user_id: "a", tokens: ["new"], created_at: "2026-10-24T00:59:30Z" },
    { user_id: "b", tokens: ["stale"], created_at: "2026-10-24T00:40:00Z" },
    { user_id: "c", tokens: ["bad"], created_at: "not a date" },
  ];
  assertEquals(latestTokens(rows, now, 5 * 60_000), { a: ["new"] });
});
