// Friend-side decryption of a subject's trail, lifted from app/incident/[id].tsx so the incident screen
// and the desktop monitor share one implementation of the escrow flow:
//   released_keys (sealed to me) → SafetyNative.openReleasedKey → location_blobs → SafetyNative.decryptLocations
// plus the fallback unlock (unlock_requests / unlock_approvals → recoverFromShares) when the phone is offline.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SafetyNative, type DecryptedLocation } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { getIncident, listLocationBlobs, listReleasedKeysForMe, listUnlockApprovals, listUnlockRequests, subscribe } from '@/lib/db';
import type { Incident, ReleasedKey, UnlockApproval, UnlockRequest } from '@/lib/types';

export type IncidentLocations = {
  incident: Incident | null;
  /** Decrypted points, oldest first. Empty until a key has been released to me (or recovered from shares). */
  trail: DecryptedLocation[];
  last: DecryptedLocation | undefined;
  keys: ReleasedKey[];
  /** Open fallback-unlock request for this incident, if any. */
  req: UnlockRequest | null;
  setReq: (r: UnlockRequest | null) => void;
  approvals: UnlockApproval[];
  /** Shamir threshold for the fallback unlock (from the unlock fn / epoch; default 2). */
  k: number;
  setK: (k: number) => void;
  error: string | null;
};

type S = { forId: string | null; trail: DecryptedLocation[]; keys: ReleasedKey[]; req: UnlockRequest | null; approvals: UnlockApproval[]; k: number; error: string | null };
const EMPTY: S = { forId: null, trail: [], keys: [], req: null, approvals: [], k: 2, error: null };

export function useIncidentLocations(incidentId: string | null | undefined): IncidentLocations {
  const id = incidentId ?? null;
  const me = useStore((s) => s.session?.user.id ?? null);
  const stored = useStore((s) => s.incidents.find((i) => i.id === id) ?? null);
  const [fetched, setFetched] = useState<Incident | null>(null);
  const incident = stored ?? (fetched && fetched.id === id ? fetched : null);
  const subject = incident?.user_id ?? null;

  // All per-incident state lives in one object tagged with the incident it belongs to, so switching
  // incidents shows a clean slate immediately without a reset effect.
  const [raw, setRaw] = useState<S>(EMPTY);
  const s = raw.forId === id ? raw : EMPTY;
  const patch = useCallback((p: Partial<S> | ((cur: S) => Partial<S>)) => {
    setRaw((prev) => {
      const base = prev.forId === id ? prev : { ...EMPTY, forId: id };
      return { ...base, ...(typeof p === 'function' ? p(base) : p) };
    });
  }, [id]);
  const keysRef = useRef<ReleasedKey[]>([]);
  useEffect(() => { keysRef.current = s.keys; }, [s.keys]);

  // Decrypt whatever blobs we can with the keys we've been given (normal unlock path).
  const loadTrail = useCallback(async (ks: ReleasedKey[]) => {
    if (!subject || !ks.length) return;
    try {
      for (const rk of ks) await SafetyNative.openReleasedKey({ subjectUserId: subject, epochId: rk.epoch_id, hourIndex: rk.hour_index, sealedB64: rk.sealed, senderEd25519Pub: rk.sender_ed25519_pub });
      const epochIds = [...new Set(ks.map((x) => x.epoch_id))];
      const blobs = (await Promise.all(epochIds.map((e) => listLocationBlobs(subject, e)))).flat();
      const hours = new Set(ks.map((x) => x.hour_index));
      const usable = blobs.filter((b) => hours.has(b.hour_index));
      const pts = await SafetyNative.decryptLocations(subject, usable.map((b) => ({ epochId: b.epoch_id, seq: Number(b.seq), hourIndex: b.hour_index, ciphertextB64: b.ciphertext })));
      patch({ trail: pts.sort((a, b) => a.tMs - b.tMs) });
    } catch (e) { console.warn('trail', e); }
  }, [subject, patch]);

  useEffect(() => {
    if (!id || !me) return;
    if (!stored) getIncident(id).then(setFetched).catch(() => {});
    listReleasedKeysForMe(id, me).then((ks) => { patch({ keys: ks }); void loadTrail(ks); }).catch(() => {});
    listUnlockRequests(id).then((rs) => patch({ req: rs.find((r) => r.status !== 'denied') ?? null })).catch(() => {});
    const chans = [
      subscribe('released_keys', `incident_id=eq.${id}`, (row) => {
        if (row.recipient_user_id !== me) return;
        patch((cur) => { const n = [...cur.keys.filter((x) => x.id !== row.id), row]; void loadTrail(n); return { keys: n }; });
      }),
      subscribe('location_blobs', undefined, (row) => { if (row.user_id === subject && keysRef.current.length) void loadTrail(keysRef.current); }),
      subscribe('unlock_requests', `incident_id=eq.${id}`, (row) => patch({ req: row })),
    ];
    return () => chans.forEach((c) => c.unsubscribe());
  }, [id, me, subject, stored, loadTrail, patch]);

  // Fallback unlock: watch approvals; when ≥k, recover K_day and decrypt.
  const req = s.req;
  useEffect(() => {
    if (!req || !subject) return;
    listUnlockApprovals(req.id).then((a) => patch({ approvals: a })).catch(() => {});
    const ch = subscribe('unlock_approvals', `request_id=eq.${req.id}`, (row) => patch((cur) => ({ approvals: cur.approvals.some((x) => x.id === row.id) ? cur.approvals : [...cur.approvals, row] })));
    return () => { ch.unsubscribe(); };
  }, [req, subject, patch]);
  const { approvals, k, trail } = s;
  useEffect(() => {
    if (!req || !subject || req.requester_id !== me || approvals.length < k || trail.length) return;
    (async () => {
      const r = await SafetyNative.recoverFromShares({ subjectUserId: subject, epochId: req.epoch_id, sealedShares: approvals.map((a) => ({ sealedB64: a.sealed_share, approverEd25519Pub: a.approver_ed25519_pub })) });
      if (!r.ok) return;
      const blobs = await listLocationBlobs(subject, req.epoch_id);
      const pts = await SafetyNative.decryptLocations(subject, blobs.map((b) => ({ epochId: b.epoch_id, seq: Number(b.seq), hourIndex: b.hour_index, ciphertextB64: b.ciphertext })));
      patch({ trail: pts.sort((a, b) => a.tMs - b.tMs) });
    })().catch((e: Error) => patch({ error: `Recovery failed: ${e.message}` }));
  }, [approvals, k, req, subject, me, trail.length, patch]);

  return {
    incident, trail, last: trail[trail.length - 1], keys: s.keys, req, approvals, k, error: s.error,
    setReq: (r) => patch({ req: r }),
    setK: (n) => patch({ k: n }),
  };
}
