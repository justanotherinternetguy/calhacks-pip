/**
 * tokensByUser: each user's *latest* token set (HMAC(group_epoch_key, geohash7)
 * for own cell + 8 neighbours). Two users are together if any token matches.
 * Returns together/separated per user that has tokens; users without tokens
 * are omitted (we do not know where they are, so we do not overwrite presence).
 */
export function computePresence(tokensByUser: Record<string, string[]>): Record<string, boolean> {
  const users = Object.keys(tokensByUser).filter((u) => (tokensByUser[u]?.length ?? 0) > 0);
  const sets = new Map(users.map((u) => [u, new Set(tokensByUser[u])]));
  const out: Record<string, boolean> = {};
  for (const u of users) out[u] = false;
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const a = sets.get(users[i])!;
      const b = sets.get(users[j])!;
      let hit = false;
      for (const t of a) {
        if (b.has(t)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        out[users[i]] = true;
        out[users[j]] = true;
      }
    }
  }
  return out;
}

export interface TokenRow {
  user_id: string;
  tokens: string[];
  created_at: string;
}

/** Keep each user's newest row that is not older than maxAgeMs. */
export function latestTokens(rows: TokenRow[], now: number, maxAgeMs: number): Record<string, string[]> {
  const out: Record<string, { at: number; tokens: string[] }> = {};
  for (const r of rows) {
    const at = Date.parse(r.created_at);
    if (Number.isNaN(at) || now - at > maxAgeMs) continue;
    const cur = out[r.user_id];
    if (!cur || at > cur.at) out[r.user_id] = { at, tokens: r.tokens ?? [] };
  }
  return Object.fromEntries(Object.entries(out).map(([u, v]) => [u, v.tokens]));
}
