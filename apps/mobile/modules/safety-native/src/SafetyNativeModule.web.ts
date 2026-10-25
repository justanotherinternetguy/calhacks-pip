/**
 * Web build of the SafetyNative facade: the FRIEND role in a phone browser (iPhone Safari etc.).
 *
 * - No sensing / detection on web — status, night mode, check-ins, scenarios are delegated to the JS
 *   mock (`MockSafetyNative`), exactly like Expo Go.
 * - Escrow crypto is REAL, via the Rust `safety-crypto` crate compiled to wasm (`./wasm.ts`): a web
 *   friend can open released hour keys, decrypt location blobs, approve fallback unlocks (re-sealing
 *   their Shamir share) and recover K_day from approvals. All AADs follow CONTRACTS.md §5.
 * - Nothing is published from here: the web user never rotates a day key or uploads shares/blobs
 *   (that is the subject phone's job). `setGroup` only remembers member keys.
 */
import type {
  ApproveUnlockInput,
  BlobInput,
  ConfigureOptions,
  DecryptedLocation,
  GroupConfig,
  HomePlace,
  Identity,
  NightMode,
  Permissions,
  RecoverInput,
  ReleasedKeyInput,
  SafetyNativeEventName,
  SafetyNativeEvents,
  SafetyNativeModuleType,
  Subscription,
  TypingRecord,
} from './SafetyNative.types';
import { MockSafetyNative } from './MockSafetyNative';
import { loadWasm, type SafetyWasm, type WasmIdentity, type WasmShare } from './wasm';
import { supabase } from '@/lib/supabase';

// ---- byte helpers (base64 on the wire, Uint8Array into wasm)
const utf8 = (s: string) => new TextEncoder().encode(s);
function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Device identity lives in localStorage as base64 JSON. Hackathon trade-off: on native the secret
 * halves sit in Keychain/Keystore; a browser has no equivalent that survives reloads short of
 * non-extractable WebCrypto keys, which HPKE/Ed25519 via wasm cannot use. Clearing site data = new device.
 */
const IDENTITY_KEY = 'safe.web.identity.v1';
type StoredIdentity = Record<keyof WasmIdentity, string>;

export class WebSafetyNative implements SafetyNativeModuleType {
  /** Sensing is still the JS mock on web; only the escrow crypto is real. Keeps onboarding permissive. */
  readonly isMock = true;
  private readonly mock: SafetyNativeModuleType = new MockSafetyNative();
  /** Set by configure(); until then [uid] falls back to the signed-in Supabase user. Never a placeholder. */
  private userId: string | null = null;

  /**
   * The signed-in user's id. Screens can call getIdentity() before onAuthSession has run configure(); the session
   * is already in supabase-js by then, so read it from there instead of handing out a placeholder id.
   */
  private async uid(): Promise<string> {
    if (this.userId) return this.userId;
    const { data } = await supabase.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new Error('Not signed in');
    return id;
  }
  private identity: Promise<WasmIdentity> | null = null;
  private groups = new Map<string, GroupConfig>();
  /** `${subject}|${epoch}|${hourIndex}` → K_h */
  private hourKeys = new Map<string, Uint8Array>();
  /** `${subject}|${epoch}` → K_day (from recoverFromShares) */
  private dayKeys = new Map<string, Uint8Array>();
  private alarm: { stop: () => void } | null = null;

  // ---- wasm + identity -------------------------------------------------------------------------
  private w(): Promise<SafetyWasm> {
    return loadWasm();
  }

  private loadIdentity(): Promise<WasmIdentity> {
    if (this.identity) return this.identity;
    this.identity = (async () => {
      const w = await this.w();
      try {
        const raw = globalThis.localStorage?.getItem(IDENTITY_KEY);
        if (raw) {
          const s = JSON.parse(raw) as StoredIdentity;
          const id: WasmIdentity = {
            x25519Secret: fromB64(s.x25519Secret), x25519Public: fromB64(s.x25519Public),
            ed25519Secret: fromB64(s.ed25519Secret), ed25519Public: fromB64(s.ed25519Public),
          };
          if (Object.values(id).every((b) => b.length === 32)) return id;
        }
      } catch (e) { console.warn('[SafetyNative web] stored identity unreadable, regenerating', e); }
      const id = w.generate_identity();
      try {
        const s: StoredIdentity = {
          x25519Secret: toB64(id.x25519Secret), x25519Public: toB64(id.x25519Public),
          ed25519Secret: toB64(id.ed25519Secret), ed25519Public: toB64(id.ed25519Public),
        };
        globalThis.localStorage?.setItem(IDENTITY_KEY, JSON.stringify(s));
      } catch (e) { console.warn('[SafetyNative web] could not persist identity (private mode?)', e); }
      return id;
    })();
    this.identity.catch(() => { this.identity = null; });
    return this.identity;
  }

  private hourKeyFor(w: SafetyWasm, subject: string, epochId: string, hourIndex: number): Uint8Array | null {
    const hk = `${subject}|${epochId}|${hourIndex}`;
    const cached = this.hourKeys.get(hk);
    if (cached) return cached;
    const day = this.dayKeys.get(`${subject}|${epochId}`);
    if (!day) return null;
    const derived = w.derive_hour_key(day, hourIndex);
    this.hourKeys.set(hk, derived);
    return derived;
  }

  // ---- delegated to the mock (no sensing on web) ----------------------------------------------
  addListener<K extends SafetyNativeEventName>(name: K, cb: (e: SafetyNativeEvents[K]) => void): Subscription {
    return this.mock.addListener(name, cb);
  }
  async configure(opts: ConfigureOptions) {
    this.userId = opts.userId;
    this.w().catch((e) => console.warn('[SafetyNative web] wasm preload failed', e));
    await this.mock.configure(opts);
  }
  setAccessToken(token: string) { return this.mock.setAccessToken(token); }
  setSession(s: { accessToken: string; refreshToken: string }) { return this.mock.setSession(s); }
  getSession() { return this.mock.getSession(); }
  clearSession() { return this.mock.clearSession(); }
  requestPermission(kind: keyof Permissions) { return this.mock.requestPermission(kind); }
  setHomePlaces(places: HomePlace[]) { return this.mock.setHomePlaces(places); }
  setEveningWindow(startHour: number, endHour: number) { return this.mock.setEveningWindow(startHour, endHour); }
  setNightMode(mode: NightMode) { return this.mock.setNightMode(mode); }
  getStatus() { return this.mock.getStatus(); }
  submitCheckIn(r: TypingRecord) { return this.mock.submitCheckIn(r); }
  needHelp() { return this.mock.needHelp(); }
  openCheckIn() { return this.mock.openCheckIn(); }
  triggerSos() { return this.mock.triggerSos(); }
  cancelSos() { return this.mock.cancelSos(); }
  startBaselineWalk() { return this.mock.startBaselineWalk(); }
  stopBaselineWalk() { return this.mock.stopBaselineWalk(); }
  recordTypingPractice(r: TypingRecord) { return this.mock.recordTypingPractice(r); }
  injectTrace(json: string) { return this.mock.injectTrace(json); }
  // §6 personal dashboard: no sensing on web, so the live metrics/incident log are the mock's.
  getDashboard() { return this.mock.getDashboard(); }
  setDashboardStreaming(on: boolean) { return this.mock.setDashboardStreaming(on); }
  resetIncidents() { return this.mock.resetIncidents(); }
  // §7 telemetry: a browser never publishes; the web monitor subscribes via lib/telemetry.ts. Preference only.
  setTelemetry(on: boolean) { return this.mock.setTelemetry(on); }
  getTelemetryStatus() { return this.mock.getTelemetryStatus(); }
  // Demo sensitivity: no engine on web; the mock remembers the switch so Settings round-trips.
  setDemoSensitivity(on: boolean) { return this.mock.setDemoSensitivity(on); }
  getDemoSensitivity() { return this.mock.getDemoSensitivity(); }
  setCollectAllowed(on: boolean) { return this.mock.setCollectAllowed(on); }
  getCollect() { return this.mock.getCollect(); }
  stopCollect() { return this.mock.stopCollect(); }

  // ---- real crypto -------------------------------------------------------------------------------
  async getIdentity(): Promise<Identity> {
    const [w, id, userId] = await Promise.all([this.w(), this.loadIdentity(), this.uid()]);
    return {
      userId,
      x25519Pub: toB64(id.x25519Public),
      ed25519Pub: toB64(id.ed25519Public),
      fingerprint: w.fingerprint(userId, id.x25519Public, id.ed25519Public),
    };
  }

  /** Friend-only: remember member keys. No day-key rotation / share upload — a browser never senses. */
  async setGroup(g: GroupConfig) {
    this.groups.set(g.groupId, g);
  }

  /** released_keys row → cache K_h. aad = "hour|{epochId}|{hourIndex}" (CONTRACTS §5). */
  async openReleasedKey(r: ReleasedKeyInput) {
    const [w, id] = await Promise.all([this.w(), this.loadIdentity()]);
    const key = w.open_sealed(id.x25519Secret, fromB64(r.senderEd25519Pub), fromB64(r.sealedB64), utf8(`hour|${r.epochId}|${r.hourIndex}`));
    if (key.length !== 32) throw new Error(`released key must be 32 bytes, got ${key.length}`);
    this.hourKeys.set(`${r.subjectUserId}|${r.epochId}|${r.hourIndex}`, key);
  }

  /** Decrypt every blob we hold a key for (released K_h, or K_h derived from a recovered K_day). */
  async decryptLocations(subjectUserId: string, blobs: BlobInput[]): Promise<DecryptedLocation[]> {
    if (!blobs.length) return [];
    const w = await this.w();
    const out: DecryptedLocation[] = [];
    let noKey = 0, failed = 0;
    for (const b of blobs) {
      const key = this.hourKeyFor(w, subjectUserId, b.epochId, b.hourIndex);
      if (!key) { noKey++; continue; }
      try {
        const l = w.decrypt_location(key, subjectUserId, b.epochId, b.seq, fromB64(b.ciphertextB64));
        out.push({ lat: l.lat, lng: l.lng, accuracyM: l.accuracyM, tMs: l.tMs });
      } catch (e) { failed++; console.warn(`[SafetyNative web] blob seq=${b.seq} hour=${b.hourIndex}: ${(e as Error).message}`); }
    }
    if (!out.length && noKey) throw new Error(`no key for ${noKey} blob(s) of ${subjectUserId.slice(0, 8)}: open a released key or recover shares first`);
    if (noKey || failed) console.warn(`[SafetyNative web] decrypted ${out.length}/${blobs.length} (no key: ${noKey}, failed: ${failed})`);
    return out;
  }

  /**
   * Fallback unlock, approver side. My escrowed share is in `key_shares` (sealed to me by the subject,
   * aad "share|{epochId}|{me}"); open it and re-seal `[index] ++ share` to the requester with
   * aad "approval|{subjectUserId}|{epochId}". The caller inserts the `unlock_approvals` row.
   */
  async approveUnlock(r: ApproveUnlockInput): Promise<{ sealedShareB64: string }> {
    const [w, id, me] = await Promise.all([this.w(), this.loadIdentity(), this.uid()]);
    const { data, error } = await supabase
      .from('key_shares')
      .select('share_index, sealed, sender_ed25519_pub')
      .eq('epoch_id', r.epochId)
      .eq('recipient_user_id', me)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`key_shares: ${error.message}`);
    if (!data) throw new Error('No escrowed share for this epoch was sealed to this device');
    const row = data as { share_index: number; sealed: string; sender_ed25519_pub: string };
    const share = w.open_sealed(id.x25519Secret, fromB64(row.sender_ed25519_pub), fromB64(row.sealed), utf8(`share|${r.epochId}|${me}`));
    const payload = new Uint8Array(1 + share.length);
    payload[0] = row.share_index & 0xff;
    payload.set(share, 1);
    const sealed = w.seal_to(fromB64(r.requesterX25519Pub), id.ed25519Secret, payload, utf8(`approval|${r.subjectUserId}|${r.epochId}`));
    return { sealedShareB64: toB64(sealed) };
  }

  /** Requester side: open each approval (aad "approval|…", signed by that approver), combine → K_day. */
  async recoverFromShares(r: RecoverInput): Promise<{ ok: boolean }> {
    if (r.sealedShares.length < 2) return { ok: false };
    const [w, id] = await Promise.all([this.w(), this.loadIdentity()]);
    const aad = utf8(`approval|${r.subjectUserId}|${r.epochId}`);
    const shares: WasmShare[] = [];
    for (const s of r.sealedShares) {
      const bytes = w.open_sealed(id.x25519Secret, fromB64(s.approverEd25519Pub), fromB64(s.sealedB64), aad);
      if (bytes.length < 2) throw new Error('approval payload too short');
      shares.push({ index: bytes[0], data: bytes.slice(1) });
    }
    const dayKey = w.combine_shares(shares);
    this.dayKeys.set(`${r.subjectUserId}|${r.epochId}`, dayKey);
    // Hour keys are derived lazily in decryptLocations and cached per hourIndex.
    return { ok: true };
  }

  // ---- alarm (WebAudio; needs a prior user gesture on iOS Safari, which the "Ring" button is) --------
  async ringAlarm(seconds: number) {
    await this.stopAlarm();
    const Ctx = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error('WebAudio is not available in this browser');
    const ctx = new Ctx();
    await ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.connect(gain);
    osc.start();
    // Two-tone siren: 880/1175 Hz alternating every 250 ms, with a short gap so it reads as an alarm.
    let hi = false;
    const beat = setInterval(() => {
      hi = !hi;
      osc.frequency.setValueAtTime(hi ? 1175 : 880, ctx.currentTime);
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + 0.2);
    }, 250);
    const vib = typeof globalThis.navigator?.vibrate === 'function' ? setInterval(() => navigator.vibrate([200, 50]), 250) : null;
    const timeout = setTimeout(() => void this.stopAlarm(), Math.max(1, seconds) * 1000);
    this.alarm = {
      stop: () => {
        clearInterval(beat); clearTimeout(timeout); if (vib) clearInterval(vib);
        try { osc.stop(); } catch {}
        void ctx.close().catch(() => {});
      },
    };
  }
  async stopAlarm() {
    this.alarm?.stop();
    this.alarm = null;
  }
}

const SafetyNative: SafetyNativeModuleType = new WebSafetyNative();
export default SafetyNative;
