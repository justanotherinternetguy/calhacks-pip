import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  b64url,
  b64urlDecode,
  buildApnsHeaders,
  buildApnsPayload,
  buildFcmMessage,
  decodeJwt,
  FCM_SCOPE,
  GOOGLE_TOKEN_URL,
  makeApnsJwt,
  makeGoogleJwt,
  pemToDer,
  sendToDevices,
} from "./push.ts";

const input = {
  incidentId: "inc-1",
  kind: "heads_up",
  title: "Sam might not be okay",
  body: "Gait drift, no answer to check-in",
  data: { level: "heads_up", nested: { a: 1 } },
};

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

Deno.test("b64url round-trips", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assertEquals(b64urlDecode(b64url(bytes)), bytes);
  assert(!b64url(bytes).includes("+") && !b64url(bytes).includes("/") && !b64url(bytes).includes("="));
});

Deno.test("buildApnsPayload: critical alert shape", () => {
  const p = buildApnsPayload({ ...input, critical: true }) as { aps: Record<string, unknown> } & Record<string, unknown>;
  assertEquals(p.aps["interruption-level"], "critical");
  assertEquals(p.aps.sound, { critical: 1, name: "alarm.caf", volume: 1.0 });
  assertEquals(p.aps.alert, { title: input.title, body: input.body });
  assertEquals(p.aps["thread-id"], "inc-1");
  assertEquals(p.incidentId, "inc-1");
  assertEquals(p.kind, "heads_up");
  assertEquals(p.nested, JSON.stringify({ a: 1 }), "non-string data is stringified");
});

Deno.test("buildApnsPayload: non-critical is time-sensitive with default sound", () => {
  const p = buildApnsPayload(input) as { aps: Record<string, unknown> };
  assertEquals(p.aps["interruption-level"], "time-sensitive");
  assertEquals(p.aps.sound, "default");
});

Deno.test("buildApnsHeaders", () => {
  const h = buildApnsHeaders(input, "com.example.safe", "JWT");
  assertEquals(h["apns-topic"], "com.example.safe");
  assertEquals(h["apns-push-type"], "alert");
  assertEquals(h["apns-priority"], "10");
  assertEquals(h.authorization, "bearer JWT");
  assertEquals(h["apns-collapse-id"], "inc-1:heads_up");
});

Deno.test("buildFcmMessage: high priority on alarm channel, data all strings", () => {
  const m = buildFcmMessage("tok", { ...input, critical: true }) as {
    message: { token: string; android: { priority: string; notification: Record<string, unknown> }; data: Record<string, unknown> };
  };
  assertEquals(m.message.token, "tok");
  assertEquals(m.message.android.priority, "HIGH");
  assertEquals(m.message.android.notification.channel_id, "alarm");
  assertEquals(m.message.android.notification.notification_priority, "PRIORITY_MAX");
  for (const v of Object.values(m.message.data)) assertEquals(typeof v, "string");
  assertEquals(m.message.data.critical, "true");
});

Deno.test("makeApnsJwt: ES256 header/claims and verifiable signature", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY");
  const token = await makeApnsJwt({ keyId: "KEY123", teamId: "TEAM456", p8Pem: pem, now: 1700000000 });
  const { header, claims, signature, signingInput } = decodeJwt(token);
  assertEquals(header, { alg: "ES256", kid: "KEY123", typ: "JWT" });
  assertEquals(claims, { iss: "TEAM456", iat: 1700000000 });
  assertEquals(signature.length, 64, "raw r||s");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    kp.publicKey,
    signature,
    new TextEncoder().encode(signingInput),
  );
  assert(ok, "signature verifies with the public key");
});

Deno.test("makeApnsJwt accepts PEM with escaped newlines (env var style)", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY").replace(/\n/g, "\\n");
  assertEquals(pemToDer(pem).length > 100, true);
  const token = await makeApnsJwt({ keyId: "k", teamId: "t", p8Pem: pem });
  assertMatch(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

Deno.test("makeGoogleJwt: RS256 assertion with FCM scope and 1h expiry", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY");
  const token = await makeGoogleJwt({ clientEmail: "svc@proj.iam.gserviceaccount.com", privateKeyPem: pem, now: 1700000000 });
  const { header, claims, signature, signingInput } = decodeJwt(token);
  assertEquals(header, { alg: "RS256", typ: "JWT" });
  assertEquals(claims, {
    iss: "svc@proj.iam.gserviceaccount.com",
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: 1700000000,
    exp: 1700003600,
  });
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    kp.publicKey,
    signature,
    new TextEncoder().encode(signingInput),
  );
  assert(ok);
});

Deno.test("sendToDevices is fail-soft: unconfigured transports and missing tokens never throw", async () => {
  const results = await sendToDevices(
    [
      { id: "d1", user_id: "u1", platform: "ios", push_token: "a", push_kind: "apns" },
      { id: "d2", user_id: "u2", platform: "android", push_token: "b", push_kind: "fcm" },
      { id: "d3", user_id: "u3", platform: "android", push_token: null, push_kind: null },
    ],
    input,
    { apns: null, fcm: null },
  );
  assertEquals(results.length, 3);
  assert(results.every((r) => r.ok === false));
  assertEquals(results.find((r) => r.deviceId === "d3")?.kind, "none");
  assertMatch(results.find((r) => r.deviceId === "d1")!.error!, /APNs not configured/);
  assertMatch(results.find((r) => r.deviceId === "d2")!.error!, /FCM not configured/);
});
