import { assertEquals } from "@std/assert";
import { cacheHeaders, etagFor, isNotModified } from "./cache.ts";

const cfg = { version: "v1", toml: "a = 1", signature: "unsigned-dev" };

Deno.test("etag and cache headers", () => {
  assertEquals(etagFor(cfg), '"v1:unsigned-dev"');
  const h = cacheHeaders(cfg, 60);
  assertEquals(h["Cache-Control"], "public, max-age=60, stale-while-revalidate=240");
  assertEquals(h["X-Model-Version"], "v1");
});

Deno.test("If-None-Match matching, including weak tags and lists", () => {
  assertEquals(isNotModified(null, cfg), false);
  assertEquals(isNotModified('"v1:unsigned-dev"', cfg), true);
  assertEquals(isNotModified('W/"v1:unsigned-dev"', cfg), true);
  assertEquals(isNotModified('"x", "v1:unsigned-dev"', cfg), true);
  assertEquals(isNotModified('"v0:unsigned-dev"', cfg), false);
});
