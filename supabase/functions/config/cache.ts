export interface ModelConfig {
  version: string;
  toml: string;
  signature: string;
}

export function etagFor(cfg: ModelConfig): string {
  return `"${cfg.version}:${cfg.signature.slice(0, 16)}"`;
}

export function cacheHeaders(cfg: ModelConfig, maxAgeSeconds = 300): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 4}`,
    ETag: etagFor(cfg),
    "X-Model-Version": cfg.version,
  };
}

export function isNotModified(ifNoneMatch: string | null, cfg: ModelConfig): boolean {
  if (!ifNoneMatch) return false;
  const tag = etagFor(cfg);
  return ifNoneMatch.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(tag);
}
