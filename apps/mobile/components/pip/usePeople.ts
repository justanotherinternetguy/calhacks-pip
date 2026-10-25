import { useMemo } from 'react';
import { useNow } from '@/components/monitor/useMonitorData';
import { concernOf, toneRank, type Concern } from '@/lib/concern';
import { ZONE_RADIUS_M, bearingDeg, distanceM, useFriends, type FriendLive, type LatLng } from '@/lib/friends';

/** One person as the interface shows them: live state, the concern it adds up to, and where they are from me. */
export type Person = { f: FriendLive; c: Concern; distM: number | null; bearing: number | null };

/** Everyone in my groups with their concern, worst first, plus me. Refreshed once a second. */
export function usePeople() {
  const friends = useFriends((s) => s.friends);
  const anchor = useFriends((s) => s.anchor);
  const ready = useFriends((s) => s.ready);
  const now = useNow(1000);
  return useMemo(() => {
    const meLive = friends.find((f) => f.isMe) ?? null;
    const myLoc: LatLng | null = meLive?.loc ?? null;
    const people: Person[] = friends.map((f) => {
      const inZone = !!f.loc && distanceM(f.loc, anchor) <= ZONE_RADIUS_M;
      const here = f.loc && myLoc && !f.isMe;
      return { f, c: concernOf(f, now, { inZone }), distM: here ? distanceM(myLoc, f.loc!) : null, bearing: here ? bearingDeg(myLoc, f.loc!) : null };
    });
    const others = people
      .filter((p) => !p.f.isMe)
      .sort((a, b) => toneRank[b.c.tone] - toneRank[a.c.tone] || b.c.dots - a.c.dots || (a.distM ?? Infinity) - (b.distM ?? Infinity) || a.f.name.localeCompare(b.f.name));
    const me = people.find((p) => p.f.isMe) ?? null;
    const out = others.filter((p) => p.c.tone !== 'home').length;
    return { ready, now, me, myLoc, others, counts: { out, home: others.length - out } };
  }, [friends, anchor, ready, now]);
}
