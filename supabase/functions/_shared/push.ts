// Push fan-out: APNs (HTTP/2 + ES256 provider token) and FCM v1 (OAuth2 via
// service-account JWT). The pure builders are exported for unit tests; only
// `sendToDevices` touches the network.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PushInput {
  incidentId: string;
  /** incident_events.kind or incident level, e.g. 'heads_up', 'ring', 'offline' */
  kind: string;
  title: string;
  body: string;
  critical?: boolean;
  data?: Record<string, unknown>;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  platform: "ios" | "android";
  push_token: string | null;
  push_kind: "apns" | "fcm" | null;
}

export interface PushResult {
  deviceId: string;
  userId: string;
  kind: "apns" | "fcm" | "none";
  ok: boolean;
  status?: number;
  error?: string;
}

// ---------------------------------------------------------------- encoding
const te = new TextEncoder();

export function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? te.encode(input)
    : input instanceof Uint8Array
    ? input
    : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesOf(bin: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return bytesOf(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad));
}

/** PEM (PKCS#8) -> DER bytes. Accepts literal "\n" escapes as found in env vars. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return bytesOf(atob(body));
}

// ---------------------------------------------------------------- JWTs
export interface JwtParts {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signature: Uint8Array<ArrayBuffer>;
  signingInput: string;
}

export function decodeJwt(token: string): JwtParts {
  const [h, c, s] = token.split(".");
  if (!h || !c || !s) throw new Error("malformed jwt");
  const td = new TextDecoder();
  return {
    header: JSON.parse(td.decode(b64urlDecode(h))),
    claims: JSON.parse(td.decode(b64urlDecode(c))),
    signature: b64urlDecode(s),
    signingInput: `${h}.${c}`,
  };
}

async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algo: AlgorithmIdentifier | EcdsaParams,
): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(algo, key, te.encode(input));
  return `${input}.${b64url(sig)}`;
}

/** APNs provider token: ES256, header {alg, kid}, claims {iss: teamId, iat}. */
export async function makeApnsJwt(opts: {
  keyId: string;
  teamId: string;
  p8Pem: string;
  now?: number; // seconds
}): Promise<string> {
  const iat = opts.now ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(opts.p8Pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto ECDSA emits raw r||s, which is exactly the JWS ES256 format.
  return signJwt(
    { alg: "ES256", kid: opts.keyId, typ: "JWT" },
    { iss: opts.teamId, iat },
    key,
    { name: "ECDSA", hash: "SHA-256" },
  );
}

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google service-account assertion: RS256, aud = token endpoint, 1h expiry. */
export async function makeGoogleJwt(opts: {
  clientEmail: string;
  privateKeyPem: string;
  scope?: string;
  now?: number; // seconds
  ttlSeconds?: number;
}): Promise<string> {
  const iat = opts.now ?? Math.floor(Date.now() / 1000);
  const exp = iat + Math.min(opts.ttlSeconds ?? 3600, 3600);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(opts.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return signJwt(
    { alg: "RS256", typ: "JWT" },
    { iss: opts.clientEmail, scope: opts.scope ?? FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp },
    key,
    { name: "RSASSA-PKCS1-v1_5" },
  );
}

// ---------------------------------------------------------------- payloads
function stringifyData(input: PushInput): Record<string, string> {
  const out: Record<string, string> = { incidentId: input.incidentId, kind: input.kind };
  for (const [k, v] of Object.entries(input.data ?? {})) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export const APNS_SOUND_CRITICAL = "alarm.caf";
export const APNS_SOUND_DEFAULT = "default";

/**
 * APNs JSON body. Critical alerts need the entitlement; if Apple has not
 * granted it the device falls back to time-sensitive.
 */
export function buildApnsPayload(input: PushInput): Record<string, unknown> {
  const critical = !!input.critical;
  const aps: Record<string, unknown> = {
    alert: { title: input.title, body: input.body },
    sound: critical ? { critical: 1, name: APNS_SOUND_CRITICAL, volume: 1.0 } : APNS_SOUND_DEFAULT,
    "interruption-level": critical ? "critical" : "time-sensitive",
    "relevance-score": critical ? 1.0 : 0.8,
    "thread-id": input.incidentId,
    category: input.kind,
    "mutable-content": 1,
  };
  return { aps, ...stringifyData(input) };
}

export function buildApnsHeaders(input: PushInput, topic: string, jwt: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": "0",
    "apns-collapse-id": `${input.incidentId}:${input.kind}`.slice(0, 64),
    "content-type": "application/json",
  };
}

export const FCM_CHANNEL = "alarm";

/** FCM v1 `message` object for one token. */
export function buildFcmMessage(token: string, input: PushInput): Record<string, unknown> {
  const critical = !!input.critical;
  return {
    message: {
      token,
      notification: { title: input.title, body: input.body },
      data: { ...stringifyData(input), critical: String(critical), title: input.title, body: input.body },
      android: {
        priority: "HIGH",
        ttl: "600s",
        collapse_key: `${input.incidentId}:${input.kind}`.slice(0, 64),
        notification: {
          channel_id: FCM_CHANNEL,
          sound: critical ? "alarm" : "default",
          notification_priority: critical ? "PRIORITY_MAX" : "PRIORITY_HIGH",
          visibility: "PUBLIC",
          default_vibrate_timings: true,
          tag: input.incidentId,
        },
      },
    },
  };
}

// ---------------------------------------------------------------- senders
export interface ApnsEnv {
  keyId: string;
  teamId: string;
  p8Pem: string;
  topic: string; // bundle id
  sandbox: boolean;
}

export interface FcmEnv {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

export function apnsEnvFromDeno(): ApnsEnv | null {
  const keyId = Deno.env.get("APNS_KEY_ID");
  const teamId = Deno.env.get("APNS_TEAM_ID");
  const p8Pem = Deno.env.get("APNS_P8");
  const topic = Deno.env.get("APNS_BUNDLE_ID");
  if (!keyId || !teamId || !p8Pem || !topic) return null;
  return { keyId, teamId, p8Pem, topic, sandbox: Deno.env.get("APNS_SANDBOX") === "true" };
}

export function fcmEnvFromDeno(): FcmEnv | null {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.project_id || !sa.client_email || !sa.private_key) return null;
    return { projectId: sa.project_id, clientEmail: sa.client_email, privateKeyPem: sa.private_key };
  } catch {
    return null;
  }
}

let apnsJwtCache: { token: string; iat: number } | null = null;
async function apnsJwt(env: ApnsEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && now - apnsJwtCache.iat < 50 * 60) return apnsJwtCache.token;
  const token = await makeApnsJwt({ keyId: env.keyId, teamId: env.teamId, p8Pem: env.p8Pem, now });
  apnsJwtCache = { token, iat: now };
  return token;
}

let googleTokenCache: { token: string; exp: number } | null = null;
async function googleAccessToken(env: FcmEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (googleTokenCache && googleTokenCache.exp - 60 > now) return googleTokenCache.token;
  const assertion = await makeGoogleJwt({ clientEmail: env.clientEmail, privateKeyPem: env.privateKeyPem, now });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
  const body = await res.json();
  googleTokenCache = { token: body.access_token, exp: now + (body.expires_in ?? 3600) };
  return body.access_token;
}

export function apnsHost(sandbox: boolean): string {
  return sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

export async function sendApns(env: ApnsEnv, token: string, input: PushInput): Promise<{ status: number; body: string }> {
  const jwt = await apnsJwt(env);
  const res = await fetch(`${apnsHost(env.sandbox)}/3/device/${token}`, {
    method: "POST",
    headers: buildApnsHeaders(input, env.topic, jwt),
    body: JSON.stringify(buildApnsPayload(input)),
  });
  return { status: res.status, body: await res.text() };
}

export async function sendFcm(env: FcmEnv, token: string, input: PushInput): Promise<{ status: number; body: string }> {
  const access = await googleAccessToken(env);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify(buildFcmMessage(token, input)),
  });
  return { status: res.status, body: await res.text() };
}

/** Fail-soft: one bad device never blocks the others. */
export async function sendToDevices(
  devices: DeviceRow[],
  input: PushInput,
  envs: { apns: ApnsEnv | null; fcm: FcmEnv | null } = { apns: apnsEnvFromDeno(), fcm: fcmEnvFromDeno() },
): Promise<PushResult[]> {
  const results: PushResult[] = [];
  await Promise.all(devices.map(async (d) => {
    const base = { deviceId: d.id, userId: d.user_id };
    if (!d.push_token) {
      results.push({ ...base, kind: "none", ok: false, error: "no push token" });
      return;
    }
    const kind = d.push_kind ?? (d.platform === "ios" ? "apns" : "fcm");
    try {
      if (kind === "apns") {
        if (!envs.apns) throw new Error("APNs not configured (APNS_KEY_ID/APNS_TEAM_ID/APNS_P8/APNS_BUNDLE_ID)");
        const r = await sendApns(envs.apns, d.push_token, input);
        results.push({ ...base, kind, ok: r.status >= 200 && r.status < 300, status: r.status, error: r.status >= 300 ? r.body : undefined });
      } else {
        if (!envs.fcm) throw new Error("FCM not configured (FCM_SERVICE_ACCOUNT_JSON)");
        const r = await sendFcm(envs.fcm, d.push_token, input);
        results.push({ ...base, kind, ok: r.status >= 200 && r.status < 300, status: r.status, error: r.status >= 300 ? r.body : undefined });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`push failed device=${d.id} kind=${kind}: ${error}`);
      results.push({ ...base, kind, ok: false, error });
    }
  }));
  return results;
}

/** Look up devices for a set of users and fan out. */
export async function pushToUsers(
  supabase: SupabaseClient,
  userIds: string[],
  input: PushInput,
): Promise<PushResult[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await supabase
    .from("devices")
    .select("id, user_id, platform, push_token, push_kind")
    .in("user_id", userIds);
  if (error) throw new Error(`devices lookup: ${error.message}`);
  return sendToDevices((data ?? []) as DeviceRow[], input);
}

/** Active members of a group, optionally minus some users. */
export async function groupMemberIds(
  supabase: SupabaseClient,
  groupId: string,
  exclude: string[] = [],
): Promise<string[]> {
  const { data, error } = await supabase
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("status", "active");
  if (error) throw new Error(`group_members lookup: ${error.message}`);
  const ex = new Set(exclude);
  return (data ?? []).map((r: { user_id: string }) => r.user_id).filter((u: string) => !ex.has(u));
}
