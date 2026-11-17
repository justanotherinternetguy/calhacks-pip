import { assertEquals } from "@std/assert";
import { answerMessage, askMessage, parseRequest, statusForPgCode } from "./validate.ts";

const ID = "00000000-0000-0000-0000-00000000000a";

Deno.test("parseRequest accepts the three actions", () => {
  assertEquals(parseRequest({ action: "ask", targetId: ID }), { action: "ask", targetId: ID });
  assertEquals(parseRequest({ action: "answer", checkInId: ID, status: "help" }), { action: "answer", checkInId: ID, status: "help" });
  assertEquals(parseRequest({ action: "cancel", checkInId: ID }), { action: "cancel", checkInId: ID });
});

Deno.test("parseRequest rejects bad input before any database call", () => {
  assertEquals(parseRequest(null), "json body required");
  assertEquals(parseRequest({ action: "nudge" }), "action must be ask, answer or cancel");
  assertEquals(parseRequest({ action: "ask", targetId: "bob" }), "targetId required");
  assertEquals(parseRequest({ action: "answer", checkInId: ID, status: "fine" }), "status must be ok or help");
  assertEquals(parseRequest({ action: "cancel" }), "checkInId required");
});

Deno.test("push copy names the friend and never carries a location", () => {
  const ask = askMessage("Sam", "2026-11-12T01:10:00Z");
  assertEquals(ask.title, "Sam asks: you okay?");
  assertEquals(ask.data.deadlineMs, String(Date.parse("2026-11-12T01:10:00Z")));
  assertEquals(askMessage("  ", "2026-11-12T01:10:00Z").title, "A friend asks: you okay?");
  assertEquals(answerMessage("Kai", "ok"), { title: "Kai is okay", body: "Kai answered your check-in.", critical: false });
  assertEquals(answerMessage("Kai", "help").critical, true);
});

Deno.test("RPC error codes map to HTTP statuses", () => {
  assertEquals(statusForPgCode("42501"), 403);
  assertEquals(statusForPgCode("P0001"), 409);
  assertEquals(statusForPgCode("P0002"), 404);
  assertEquals(statusForPgCode(undefined), 500);
});
