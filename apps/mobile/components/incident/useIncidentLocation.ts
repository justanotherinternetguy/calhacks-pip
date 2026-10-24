// Released-keys → decrypted trail for one incident (normal unlock path: keys the subject's phone sealed to me).
// Shared by the incident screen and the monitor's escalation dock. Keeps itself live: new released keys and new
// location blobs both refresh the trail (the blob subscription reads the latest keys through a ref, so a key that
// arrives after mount is not missed).
import { useCallback, useEffect, useRef, useState } from 'react';
import { SafetyNative, type DecryptedLocation } from '@/modules/safety-native';
import { listLocationBlobs, listReleasedKeysForMe, subscribe } from '@/lib/db';
import type { ReleasedKey, Uuid } from '@/lib/types';

type State = { key: string; trail: DecryptedLocation[]; keys: ReleasedKey[]; error: string | null };

export function useIncidentLocation(incidentId: Uuid | null | undefined, subjectId: Uuid | null | undefined, me: Uuid | null | undefined) {
  // State is tagged with the incident it belongs to, so switching incidents never shows the previous trail.
  const key = `${incidentId ?? ''}|${subjectId ?? ''}|${me ?? ''}`;
  const [st, setSt] = useState<State>({ key, trail: [], keys: [], error: null });
  const keysRef = useRef<ReleasedKey[]>([]);
  const view = st.key === key ? st : { key, trail: [], keys: [], error: null };

  const load = useCallback(async (k: string, ks: ReleasedKey[]) => {
    if (!subjectId || !ks.length) return;
    try {
      for (const rk of ks) {
        await SafetyNative.openReleasedKey({ subjectUserId: subjectId, epochId: rk.epoch_id, hourIndex: rk.hour_index, sealedB64: rk.sealed, senderEd25519Pub: rk.sender_ed25519_pub });
      }
      const epochIds = [...new Set(ks.map((x) => x.epoch_id))];
      const blobs = (await Promise.all(epochIds.map((e) => listLocationBlobs(subjectId, e)))).flat();
      const hours = new Set(ks.map((x) => x.hour_index));
      const usable = blobs.filter((b) => hours.has(b.hour_index));
      const pts = await SafetyNative.decryptLocations(subjectId, usable.map((b) => ({ epochId: b.epoch_id, seq: Number(b.seq), hourIndex: b.hour_index, ciphertextB64: b.ciphertext })));
      setSt((s) => ({ ...(s.key === k ? s : { key: k, keys: ks }), trail: pts.sort((a, b) => a.tMs - b.tMs), error: null }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSt((s) => ({ ...(s.key === k ? s : { key: k, keys: ks, trail: [] }), error: msg }));
    }
  }, [subjectId]);

  useEffect(() => {
    keysRef.current = [];
    if (!incidentId || !subjectId || !me) return;
    const apply = (ks: ReleasedKey[]) => {
      keysRef.current = ks;
      setSt((s) => ({ ...(s.key === key ? s : { key, trail: [], error: null }), keys: ks }));
      void load(key, ks);
    };
    listReleasedKeysForMe(incidentId, me).then(apply).catch(() => {});
    const chans = [
      subscribe('released_keys', `incident_id=eq.${incidentId}`, (row) => {
        if (row.recipient_user_id !== me) return;
        apply([...keysRef.current.filter((x) => x.id !== row.id), row]);
      }),
      subscribe('location_blobs', `user_id=eq.${subjectId}`, () => { if (keysRef.current.length) void load(key, keysRef.current); }),
    ];
    return () => chans.forEach((c) => c.unsubscribe());
  }, [incidentId, subjectId, me, key, load]);

  return { trail: view.trail, keys: view.keys, last: view.trail[view.trail.length - 1] as DecryptedLocation | undefined, released: view.keys.length > 0, error: view.error };
}
