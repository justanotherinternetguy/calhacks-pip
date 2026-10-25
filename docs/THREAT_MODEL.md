# Threat model

Scope: the location-escrow, proximity, and alerting design in PLAN §5 and §6, as implemented in
`core/crates/safety-crypto`, `safety-ffi/crypto.rs`, and `supabase/`. Detection accuracy is out of
scope here (see `tools/collect` for the tuning plan).

## Assets

| Asset | Where | Protection |
|---|---|---|
| Live location during night mode | `location_blobs` (ciphertext) | XChaCha20-Poly1305 under hourly key `K_h = HKDF(K_day, hour)`, AAD `user|epoch|seq`. The server holds only ciphertext and purges it after 6 h |
| Day key `K_day` | subject phone (zeroized at day end), Shamir shares on friends' phones | k-of-n GF(256) shares, each HPKE-sealed to one friend's X25519 key and Ed25519-signed by the subject |
| Device identity keys | Keychain / Keystore, usable while locked | Never leave the device. Fingerprint verified in person via QR |
| Home places, baselines, evening window | device only, encrypted at rest | Never uploaded |
| Microphone audio | RAM only, listening windows only (after a fall, drop, grab, missed check-in or unsteady gait) | Only YAMNet class scores + a sound level enter the engine. Nothing stored or sent |
| Coarse status | `devices.{night_mode,battery_pct,status_level}`, `incidents.summary` | Visible to group members and the server by design |
| Proximity | `proximity_tokens` (HMAC(group_epoch_key, geohash7)[..16], 9 cells), `presence` | Server learns only together/separated |

## Adversaries and what they learn

| Adversary | Can learn | Cannot learn | Why |
|---|---|---|---|
| **Server / operator** (Supabase project owner, honest-but-curious or compromised) | Who is in which group. When night mode is on. Escalation status every 2 min. That an incident happened, and its coarse summary. Who is together/separated. Timing of unlocks | Any location, ever. `K_day` or `K_h`. Share contents. Home places | Only ciphertext and HMAC tokens reach the server. No key material is ever uploaded unsealed. The server has no private key that anything is sealed to |
| **Server actively malicious** (swaps keys, replays, forges incidents) | Can deny service, delay pushes, fabricate an `incident` row | Cannot insert its own key into a group (fingerprints exchanged by QR in person). Cannot forge a share or released key (Ed25519 signature from subject's device key). Cannot make a fallback unlock succeed without k honest friends re-sealing shares | Trust is anchored in device keys, not in the database |
| **Single friend** (honest member, or their phone stolen) | Their own sealed share (useless alone). The subject's coarse status. Location **only after** a normal unlock (subject's phone releases `K_h` for current+next hour) or a successful fallback unlock | `K_day` from one share (k ≥ 2 floor). Location outside an incident. Location from past days (keys zeroized, blobs purged) | Shamir threshold. Hourly key scoping. The subject's own phone starts the release |
| **Colluding friends (≥ k)** | Can reconstruct `K_day` for the current day, **if** they also hold the ciphertext. RLS gives the ciphertext only to members during an incident. They reconstruct through an `unlock_request`, which the server accepts only during an `offline`/`battery_dying` incident | Silent tracking: every approval and reconstruction writes `audit_log` + `incident_events(unlock_requested/unlock_approved)` visible to the subject and the whole group | Accepted risk. Audit visibility and the `k = max(2, ⌈n/2⌉)` default deter it |
| **Server + one friend colluding** | The server can give the friend other members' `proximity_tokens`. A friend knows `group_epoch_key`, so they can brute-force geohash7 cells (~150 m) near guessed locations. They then learn where a member is, to ~150 m, during night mode | Precise location. Anything when night mode is off (no tokens uploaded) | **Accepted risk** (PLAN §5). Mitigation in v1.1: per-pair keys or PSI |
| **Thief** (has the unlocked or locked phone) | Nothing extra from the app. The check-in requires device unlock. The snatch alert fires toward friends with the snatch-moment location | Cannot dismiss a snatch alert (biometric-only). Cannot read baselines/keys without unlocking | Dismiss paths require unlock/biometric. Keys are Keystore/Keychain-protected |
| **Abusive partner inside the group** | Coarse status (night mode on/off, escalation status, together/separated with *them*). Location only during a real incident or a k-of-n unlock they cannot complete alone | Cannot unlock alone (k ≥ 2). Cannot force night mode or incidents remotely. **Can** remotely wipe the member's incident log and reset their sensing from the web monitor. This is an accepted risk (migration 0012): an erased log hides earlier signals but does not stop new detection. Cannot see home places. Cannot add themselves (mutual consent, QR in person) | The subject can leave instantly and silently, which rotates keys and invalidates shares. The audit log shows any unlock attempt |
| **Network observer** | TLS metadata to Supabase | Content | TLS. Payloads are already ciphertext |

## Mitigations in place

- k-of-n Shamir with a hard floor of k ≥ 2. Below 2 friends, the app disables fallback unlock and shows this in the UI.
- Normal unlock releases only `K_h` for the current and next hour, not `K_day`.
- Daily key rotation. Each phone zeroizes old keys and shares (`zeroize` crate) at day end. Any membership change also rotates the keys.
- HPKE (X25519-HKDF-SHA256 + ChaCha20-Poly1305) with an appended Ed25519 signature on every share and released key. Recipients verify the sender's pinned key.
- The server (`unlock` function + RLS) allows fallback unlock only for `offline`/`battery_dying` incidents. It logs every step to `audit_log`, which the subject can see.
- RLS on every table: members-only reads, no decrypt function anywhere in Postgres. pgTAP tests assert that a non-member cannot read blobs, and that the server refuses fallback without an incident.
- Push goes directly to APNs/FCM. Payloads carry no location.
- Mutual-consent group joining. In-person QR key exchange. Safety-number re-verification on key change.
- 6 h retention of ciphertext (`purge`). The 2-min heartbeats carry no location.

## Accepted risks

1. **Geohash brute force by server + friend** (above). Cells are ~150 m. The HMAC key is `group_epoch_key`, which all members know.
2. **k ≥ 2 colluding friends during a legitimate offline incident** can locate the subject. This is the feature. The deterrent is audit visibility, not prevention.
3. **Coarse status leaks pattern-of-life** (when you are out, how risky the night looked). Visible to the group and the server.
4. **Audit log is visible to the whole group**, including the person who may be the problem. The subject sees it too, which is the point.
5. **Device compromise** (rooted/jailbroken phone, malware) defeats all local protections.
6. **Snatch alert includes the snatch-moment location in plaintext to friends** by design. It is one point, not a trail.

## Open items

- [ ] External cryptographic review of `safety-crypto` (Shamir over GF(256), HPKE usage, AAD binding, zeroization) before launch (M8).
- [ ] Formalize `group_epoch_key` derivation and rotation (currently per-group and per-day, but it should rotate with membership).
- [ ] Pairwise proximity keys or PSI to close the server+friend brute-force gap.
- [ ] Replay protection on `released_keys` (bind to `incident_id` in AAD, not only `epoch|hour`).
- [ ] Rate-limit `unlock_requests` per requester per subject.
- [ ] Verify that Keychain/Keystore classes allow key use while locked, but not on a stolen locked device after reboot.
- [ ] Signed `model_configs` verification on device (the signature field exists, but the verify path is TODO).
