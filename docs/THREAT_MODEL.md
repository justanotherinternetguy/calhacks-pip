# Threat model

Scope: the location-escrow, proximity and alerting design in PLAN §5–6 as implemented in
`core/crates/safety-crypto`, `safety-ffi/crypto.rs` and `supabase/`. Detection accuracy is out of
scope here (see `tools/collect` for the tuning plan).

## Assets

| Asset | Where | Protection |
|---|---|---|
| Live location during night mode | `location_blobs` (ciphertext) | XChaCha20-Poly1305 under hourly key `K_h = HKDF(K_day, hour)`, AAD `user|epoch|seq`; server holds only ciphertext, purged after 6 h |
| Day key `K_day` | subject phone (zeroized at day end); Shamir shares on friends' phones | k-of-n GF(256) shares, each HPKE-sealed to one friend's X25519 key and Ed25519-signed by the subject |
| Device identity keys | Keychain / Keystore, usable while locked | Never leave the device; fingerprint verified in person via QR |
| Home places, baselines, evening window | device only, encrypted at rest | Never uploaded |
| Microphone audio | RAM only | Only YAMNet class scores enter the engine; nothing stored or sent |
| Coarse status | `devices.{night_mode,battery_pct,risk_band,status_level}`, `incidents.summary` | Visible to group members and the server by design |
| Proximity | `proximity_tokens` (HMAC(group_epoch_key, geohash7)[..16], 9 cells), `presence` | Server learns only together/separated |

## Adversaries and what they learn

| Adversary | Can learn | Cannot learn | Why |
|---|---|---|---|
| **Server / operator** (Supabase project owner, honest-but-curious or compromised) | Who is in which group; when night mode is on; risk band every 2 min; that an incident happened and its coarse summary; who is together/separated; timing of unlocks | Any location, ever; `K_day` or `K_h`; share contents; home places | Only ciphertext and HMAC tokens reach the server; no key material is ever uploaded unsealed; the server has no private key anything is sealed to |
| **Server actively malicious** (swaps keys, replays, forges incidents) | Can deny service, delay pushes, fabricate an `incident` row | Cannot insert its own key into a group (fingerprints exchanged by QR in person); cannot forge a share or released key (Ed25519 signature from subject's device key); cannot make a fallback unlock succeed without k honest friends re-sealing shares | Trust is anchored in device keys, not in the database |
| **Single friend** (honest member, or their phone stolen) | Their own sealed share (useless alone); the subject's coarse status; location **only after** a normal unlock (subject's phone releases `K_h` for current+next hour) or a successful fallback unlock | `K_day` from one share (k ≥ 2 floor); location outside an incident; location from past days (keys zeroized, blobs purged) | Shamir threshold; hourly key scoping; release is initiated by the subject's own phone |
| **Colluding friends (≥ k)** | Can reconstruct `K_day` for the current day **if** they also hold the ciphertext, which RLS gives only to members during an incident, via an `unlock_request` the server only accepts during an `offline`/`battery_dying` incident | Silent tracking: every approval and reconstruction writes `audit_log` + `incident_events(unlock_requested/unlock_approved)` visible to the subject and the whole group | Accepted risk, deterred by audit visibility and by `k = max(2, ⌈n/2⌉)` default |
| **Server + one friend colluding** | Server can hand the friend other members' `proximity_tokens`; a friend knows `group_epoch_key`, so they can brute-force geohash7 cells (~150 m) near guessed locations and learn where a member is to ~150 m during night mode | Precise location; anything when night mode is off (no tokens uploaded) | **Accepted risk** (PLAN §5). Mitigation in v1.1: per-pair keys or PSI |
| **Thief** (has the unlocked or locked phone) | Nothing extra from the app; the check-in requires device unlock; snatch alert fires toward friends with the snatch-moment location | Cannot dismiss a snatch alert (biometric-only); cannot read baselines/keys without unlocking | Dismiss paths require unlock/biometric; keys are Keystore/Keychain-protected |
| **Abusive partner inside the group** | Coarse status (night mode on/off, risk band, together/separated with *them*); location only during a real incident or a k-of-n unlock they cannot complete alone | Cannot unlock alone (k ≥ 2); cannot force night mode or incidents remotely; cannot see home places; cannot add themselves (mutual consent; QR in person) | Subject can leave instantly and silently, which rotates keys and invalidates shares; audit log shows any unlock attempt |
| **Network observer** | TLS metadata to Supabase | Content | TLS; payloads are already ciphertext |

## Mitigations in place

- k-of-n Shamir with a hard floor of k ≥ 2; fallback unlock disabled and surfaced in the UI below 2 friends.
- Normal unlock releases only `K_h` for the current and next hour, not `K_day`.
- Daily key rotation; old keys and shares zeroized (`zeroize` crate) at day end; rotation on any membership change.
- HPKE (X25519-HKDF-SHA256 + ChaCha20-Poly1305) with an appended Ed25519 signature on every share and released key; recipients verify the sender's pinned key.
- Fallback unlock gated server-side (`unlock` function + RLS) to `offline`/`battery_dying` incidents, and every step is logged to `audit_log` visible to the subject.
- RLS on every table: members-only reads, no decrypt function anywhere in Postgres; pgTAP tests assert a non-member cannot read blobs and that fallback is refused without an incident.
- Push goes directly to APNs/FCM; payloads carry no location.
- Mutual-consent group joining; in-person QR key exchange; safety-number re-verification on key change.
- 6 h retention of ciphertext (`purge`), 2-min heartbeats carry no location.

## Accepted risks

1. **Geohash brute force by server + friend** (above). Cells are ~150 m; HMAC keyed by `group_epoch_key` known to all members.
2. **k ≥ 2 colluding friends during a legitimate offline incident** can locate the subject; this is the feature. Deterrent is audit visibility, not prevention.
3. **Coarse status leaks pattern-of-life** (when you are out, how risky the night looked). Visible to group and server.
4. **Audit log is visible to the whole group**, including the person who may be the problem; the subject sees it too, which is the point.
5. **Device compromise** (rooted/jailbroken phone, malware) defeats all local protections.
6. **Snatch alert includes the snatch-moment location in plaintext to friends** by design; it is one point, not a trail.

## Open items

- [ ] External cryptographic review of `safety-crypto` (Shamir over GF(256), HPKE usage, AAD binding, zeroization) before launch (M8).
- [ ] Formalize `group_epoch_key` derivation and rotation (currently per-group, per-day; should rotate with membership).
- [ ] Pairwise proximity keys or PSI to close the server+friend brute-force gap.
- [ ] Replay protection on `released_keys` (bind to `incident_id` in AAD, not only `epoch|hour`).
- [ ] Rate-limit `unlock_requests` per requester per subject.
- [ ] Verify Keychain/Keystore classes allow key use while locked but not on a stolen locked device after reboot.
- [ ] Signed `model_configs` verification on device (signature field exists; verify path is TODO).
