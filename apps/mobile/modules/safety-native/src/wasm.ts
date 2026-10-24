/**
 * Lazy loader for the browser crypto module: `core/crates/safety-wasm` compiled by wasm-pack
 * (`core/build-wasm.sh`) into `apps/mobile/public/wasm/{safety_wasm.js, safety_wasm_bg.wasm}`.
 *
 * How it loads (and why it is not a normal import):
 * - Everything in `public/` is copied verbatim into the web `dist/` and served from the site root, so
 *   the glue JS lives at `/wasm/safety_wasm.js` at runtime. It is an ES module built for the browser
 *   (`--target web`); it must NOT go through Metro, which would try to bundle it (and cannot handle
 *   `import.meta` / `.wasm` without extra config).
 * - Metro only accepts `import()` with a string literal and rewrites it into a bundled require, so
 *   the dynamic import is built at runtime via `new Function(...)` — the bundler never sees it and the
 *   browser's native module loader fetches the URL. (A `<script type="module">` injection would work
 *   too but cannot hand back the module namespace as cleanly.)
 * - `init({ module_or_path })` then fetches `safety_wasm_bg.wasm` with the same base URL and
 *   instantiates it (`WebAssembly.instantiateStreaming` when the server sends `application/wasm`,
 *   arrayBuffer fallback otherwise).
 *
 * Override the base URL with `EXPO_PUBLIC_WASM_BASE_URL` when the site is hosted under a sub-path.
 */

export type WasmIdentity = {
  x25519Secret: Uint8Array;
  x25519Public: Uint8Array;
  ed25519Secret: Uint8Array;
  ed25519Public: Uint8Array;
};
export type WasmShare = { index: number; data: Uint8Array };
export type WasmLocation = { lat: number; lng: number; accuracyM: number; tMs: number };

/** Mirrors CONTRACTS.md §1 crypto.rs. Bytes are Uint8Array; errors throw `Error` with the Rust message. */
export type SafetyWasm = {
  generate_identity(): WasmIdentity;
  fingerprint(userId: string, x25519Public: Uint8Array, ed25519Public: Uint8Array): string;
  new_day_key(): Uint8Array;
  derive_hour_key(dayKey: Uint8Array, hourIndex: number): Uint8Array;
  split_day_key(dayKey: Uint8Array, k: number, n: number): WasmShare[];
  combine_shares(shares: WasmShare[]): Uint8Array;
  seal_to(recipientX25519Public: Uint8Array, senderEd25519Secret: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  open_sealed(recipientX25519Secret: Uint8Array, senderEd25519Public: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array;
  encrypt_location(hourKey: Uint8Array, userId: string, epochId: string, seq: number, loc: WasmLocation): Uint8Array;
  decrypt_location(hourKey: Uint8Array, userId: string, epochId: string, seq: number, blob: Uint8Array): WasmLocation;
  proximity_tokens(groupEpochKey: Uint8Array, lat: number, lng: number): Uint8Array[];
  proximity_match(a: Uint8Array[], b: Uint8Array[]): boolean;
};

type WasmGlueModule = SafetyWasm & {
  default(opts: { module_or_path: string | URL | Promise<Response> }): Promise<unknown>;
};

function baseUrl(): string {
  const override = process.env.EXPO_PUBLIC_WASM_BASE_URL;
  if (override) return override.endsWith('/') ? override : `${override}/`;
  const origin = globalThis.location?.origin ?? '';
  return `${origin}/wasm/`;
}

// Hidden from Metro/Babel on purpose — see the file comment.
const nativeImport = new Function('u', 'return import(u)') as (url: string) => Promise<WasmGlueModule>;

let loading: Promise<SafetyWasm> | null = null;

/** Resolve the wasm module, loading + instantiating it on first call. Safe to call many times. */
export function loadWasm(): Promise<SafetyWasm> {
  if (loading) return loading;
  loading = (async () => {
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not available in this browser');
    const base = baseUrl();
    const glue = await nativeImport(`${base}safety_wasm.js`);
    await glue.default({ module_or_path: `${base}safety_wasm_bg.wasm` });
    return glue;
  })().catch((e) => {
    loading = null; // allow a retry (e.g. transient network failure)
    throw new Error(`safety-wasm failed to load from ${baseUrl()}: ${e instanceof Error ? e.message : String(e)}`);
  });
  return loading;
}
