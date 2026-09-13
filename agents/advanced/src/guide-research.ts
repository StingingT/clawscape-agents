import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type TcpNetConnectOpts } from "node:net";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { ResearchClaim } from "./contracts.ts";

export type ResearchSummary = {
  claims: z.infer<typeof ResearchClaim>[];
  /** Research leads only. NEVER a catalog, capability, or permission to fight. */
  suggestedMonsters: string[];
  rejected: string[];
  status: string;
  /** Latest successful source retrieval, in Unix milliseconds; 0 means none. */
  fetchedAt: number;
};
export type ResearchOptions = { profileId: string; cachePath: string; maxRequests: number };
export const RESEARCH_LIMITS = Object.freeze({
  requests: 2, redirects: 1, timeoutMs: 8_000, bodyBytes: 524_288,
  cacheBytes: 65_536, ttlMs: 7 * 24 * 60 * 60 * 1_000, failureTtlMs: 15 * 60 * 1_000,
});

// Exact documents, not host-wide permissions. URLs are never taken from page text.
// The public Clawscape README currently returns 404; retain that as a real failure.
export const GUIDE_SOURCES = Object.freeze([
  Object.freeze({ url: "https://raw.githubusercontent.com/Joostrothweiler/clawscape/main/README.md",
    title: "Clawscape README", version: "Clawscape; deployment compatibility unknown", kind: "clawscape" }),
  Object.freeze({ url: "https://lostcity.rs/t/combat-training/6607",
    title: "Combat training! — Lost City community replies", version: "Lost City 2004Scape community advice", kind: "lostcity" }),
  Object.freeze({ url: "https://oldschool.runescape.wiki/w/Free-to-play_melee_training",
    title: "Free-to-play melee training — OSRS Wiki", version: "Modern OSRS; not a Clawscape content catalog", kind: "wiki" }),
] as const);
type Source = (typeof GUIDE_SOURCES)[number];
const CANDIDATES = ["Chicken", "Cow"] as const;
const UNSUPPORTED = ["Sand crab", "Ammonite crab", "Brutus", "Scurrius", "Obor", "Bryophyta", "Ogress warrior", "Giant frog",
  "Lumbridge Swamp fishing spot"] as const;
function rejection(url: string, name: string): string {
  const reason = name === "Lumbridge Swamp fishing spot" ? "CONTRADICTED_UPSTREAM_FISHING_NO_SPOTS" : "UNSUPPORTED_NO_APPROVED_CATALOG";
  return `${url} | ${name}: ${reason}`;
}
const FAILURE_CODES = ["DNS_POLICY", "SOURCE_POLICY", "REDIRECT_POLICY", "REDIRECT_LIMIT", "REQUEST_QUOTA",
  "TIMEOUT", "NETWORK", "HTTP_STATUS", "CONTENT_TYPE", "CONTENT_ENCODING", "BODY_LIMIT", "TEXT_ENCODING",
  "UNSUPPORTED_CONTENT"] as const;
type Failure = (typeof FAILURE_CODES)[number];
class ResearchError extends Error {
  constructor(readonly code: Failure) { super(code); }
}
function fail(code: Failure): never { throw new ResearchError(code); }

export function assertSourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("SOURCE_POLICY"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search
    || !GUIDE_SOURCES.some(source => source.url === raw)) fail("SOURCE_POLICY");
  return url;
}

/** Conservative public-unicast policy; reject transition/mapped/special IPv6 too. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const a = parts[0]!, b = parts[1]!, c = parts[2]!;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(x => parseInt(x, 16));
  const a = words[0]!, b = words[1]!;
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) // special-use /23 and documentation
    && a !== 0x2002 // 6to4 can embed a private IPv4 address
    && !(a === 0x3fff && b <= 0x0fff); // documentation /20
}

export type DnsAddress = { address: string; family: number };
export type GuideResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
};
export type ResearchDependencies = {
  resolve(hostname: string): Promise<DnsAddress[]>;
  /** Trusted test seam. Production pins this validated address at socket lookup. */
  request(url: URL, pinned: DnsAddress, signal: AbortSignal): Promise<GuideResponse>;
  now(): number;
  timeoutMs: number;
};

const defaults: ResearchDependencies = {
  resolve: hostname => lookup(hostname, { all: true, verbatim: true }),
  now: Date.now,
  timeoutMs: RESEARCH_LIMITS.timeoutMs,
  request: (url, pinned, signal) => new Promise((accept, reject) => {
    // HTTPS forwards connection options, but the installed HTTPS typings omit this
    // net option. The intersection retains type checking and single-address lookup.
    const options: RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
      method: "GET", agent: false, signal, rejectUnauthorized: true, servername: url.hostname,
      family: pinned.family, autoSelectFamily: false,
      maxHeaderSize: 16_384,
      // No second DNS lookup: Host/SNI/certificate validation still use the source hostname.
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { "User-Agent": "AstraGuideResearch/1.0", Accept: "text/html, text/plain, text/markdown",
        "Accept-Encoding": "identity" },
    };
    const req = httpsRequest(url, options, response => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key] = Array.isArray(value) ? value.join(",") : value;
      }
      accept({ status: response.statusCode ?? 0, headers, body: response,
        cancel: () => { response.destroy(); req.destroy(); } });
    });
    req.on("error", reject);
    req.end();
  }),
};

function sourceFor(url: string): Source {
  assertSourceUrl(url);
  return GUIDE_SOURCES.find(source => source.url === url)!;
}
function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function paraphrase(name: string): string {
  return `Curated early-melee research lead: ${name}. The fetched document mentions this name. `
    + "A name match does not prove a recommendation, supported content, safety, access, equipment suitability, or local rates. "
    + "Require unambiguous static catalog resolution and bounded live trials before use.";
}

function guideText(body: string): string {
  // Linear scan: repeated malformed '<script' or comment openers cannot trigger
  // quadratic regex backtracking. Unterminated markup is discarded conservatively.
  const lower = body.toLowerCase(), parts: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("<", cursor);
    if (start < 0) { parts.push(body.slice(cursor)); break; }
    parts.push(body.slice(cursor, start), " ");
    if (lower.startsWith("<!--", start)) {
      const end = lower.indexOf("-->", start + 4);
      cursor = end < 0 ? body.length : end + 3;
      continue;
    }
    const end = body.indexOf(">", start + 1);
    if (end < 0) break;
    const inert = /^<\s*(script|style|template|noscript)\b/i.exec(body.slice(start, end + 1))?.[1]?.toLowerCase();
    if (inert) {
      const close = lower.indexOf(`</${inert}`, end + 1);
      const closeEnd = close < 0 ? -1 : body.indexOf(">", close);
      cursor = closeEnd < 0 ? body.length : closeEnd + 1;
    } else cursor = end + 1;
  }
  return parts.join("").replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, " ").replace(/\s+/g, " ");
}

/** Text extraction only; no DOM, scripts, external resources, page URLs, or commands. */
export function parseGuide(body: string, sourceUrl: string, profileId: string, retrievedAt: number): {
  claims: ResearchSummary["claims"]; rejected: string[];
} {
  const source = sourceFor(sourceUrl);
  if (Buffer.byteLength(body, "utf8") > RESEARCH_LIMITS.bodyBytes) fail("BODY_LIMIT");
  const text = guideText(body);
  if (/verify you are human|just a moment|access denied|captcha|checking your browser/i.test(text)) fail("UNSUPPORTED_CONTENT");
  const identified = source.kind === "clawscape" ? /clawscape/i.test(text)
    : source.kind === "lostcity" ? /combat training/i.test(text) && /BukLau|nihaowdy/.test(text)
    : /free-to-play melee training/i.test(text);
  if (!identified) fail("UNSUPPORTED_CONTENT");
  const rejected = UNSUPPORTED.filter(name => name === "Lumbridge Swamp fishing spot"
    ? (/lumbridge\s+swamp/i.test(text) && /\b(fishing|net|bait|shrimps?)\b/i.test(text)) || /\b3239\s*[,/]\s*3147\b/.test(text)
    : new RegExp(`\\b${name}s?\\b`, "i").test(text)).map(name => rejection(source.url, name));
  const fingerprint = hash(body);
  // Manually selected baseline: document-wide matches only confirm mention, not semantics.
  const claims = (source.kind === "clawscape" ? [] : CANDIDATES.filter(name => new RegExp(`\\b${name}s?\\b`, "i").test(text)))
    .map(name => ResearchClaim.parse({
      schema_version: "1.0", claim_id: `guide-${hash(`${source.url}|${profileId}|${name}|${fingerprint}`).slice(0, 32)}`,
      source_url: source.url, title: source.title, retrieved_at: retrievedAt, content_date: null,
      game_version: source.version, requirements: [name], paraphrase: paraphrase(name),
      fingerprint, profile_id: profileId, validation_evidence: [], status: "UNVERIFIED",
    }));
  return { claims, rejected };
}

const RecordSchema = z.strictObject({
  url: z.string(), checkedAt: z.number().int().nonnegative(), fetchedAt: z.number().int().nonnegative(),
  failure: z.enum(FAILURE_CODES).nullable(), claims: z.array(ResearchClaim).max(2),
  // Only fixed unsupported names, never raw page strings or network errors.
  unsupported: z.array(z.enum(UNSUPPORTED)).max(UNSUPPORTED.length),
});
const CacheSchema = z.strictObject({
  owner: z.literal("astra-guide-research"), version: z.literal(1), question: z.literal("early-melee-candidates-v1"),
  profileId: z.string().min(1).max(240), records: z.array(RecordSchema).max(GUIDE_SOURCES.length),
});
type Cache = z.infer<typeof CacheSchema>;
type SourceRecord = z.infer<typeof RecordSchema>;
function emptyCache(profileId: string): Cache {
  return { owner: "astra-guide-research", version: 1, question: "early-melee-candidates-v1", profileId, records: [] };
}

/** Invalid/corrupt/foreign caches fail closed; no cached status can promote a claim. */
export function parseResearchCache(text: string, profileId: string, now: number): Cache | null {
  try {
    if (Buffer.byteLength(text) > RESEARCH_LIMITS.cacheBytes) return null;
    const cache = CacheSchema.parse(JSON.parse(text));
    if (cache.profileId !== profileId || new Set(cache.records.map(r => r.url)).size !== cache.records.length) return null;
    for (const record of cache.records) {
      const source = sourceFor(record.url);
      if (record.checkedAt > now || record.fetchedAt > record.checkedAt
        || (!record.fetchedAt && record.claims.length)) return null;
      for (const claim of record.claims) {
        const name = claim.requirements[0];
        if (source.kind === "clawscape" || !CANDIDATES.some(n => n === name)
          || claim.requirements.length !== 1 || claim.status !== "UNVERIFIED" || claim.validation_evidence.length
          || claim.profile_id !== profileId || claim.source_url !== record.url || claim.title !== source.title
          || claim.game_version !== source.version || claim.content_date !== null
          || claim.retrieved_at !== record.fetchedAt || !/^[a-f0-9]{64}$/.test(claim.fingerprint)
          || claim.paraphrase !== paraphrase(name!)
          || claim.claim_id !== `guide-${hash(`${source.url}|${profileId}|${name}|${claim.fingerprint}`).slice(0, 32)}`) return null;
      }
      if (new Set(record.claims.map(c => c.claim_id)).size !== record.claims.length) return null;
    }
    return cache;
  } catch { return null; }
}

async function readCache(path: string, profile: string, now: number): Promise<Cache | null> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > RESEARCH_LIMITS.cacheBytes) throw new Error("CACHE_POLICY");
  const file = await open(path, "r");
  try {
    const opened = await file.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw new Error("CACHE_POLICY");
    const buffer = Buffer.alloc(RESEARCH_LIMITS.cacheBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return parseResearchCache(buffer.subarray(0, bytesRead).toString("utf8"), profile, now);
  } finally { await file.close(); }
}

// One owned cache file; no directory creation, journals, logs, game DBs or policy writes.
async function writeCache(path: string, cache: Cache): Promise<void> {
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > RESEARCH_LIMITS.cacheBytes) throw new Error("CACHE_POLICY");
    file = await open(path, "r+");
    try {
      const opened = await file.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw new Error("CACHE_POLICY");
      const buffer = Buffer.alloc(RESEARCH_LIMITS.cacheBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      // A valid older-profile cache is ours and may be invalidated. Foreign files are never overwritten.
      CacheSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    } catch (error) { await file.close(); throw error; }
  }
  try {
    const bytes = Buffer.from(JSON.stringify(cache));
    if (bytes.length > RESEARCH_LIMITS.cacheBytes) throw new Error("CACHE_POLICY");
    await file.writeFile(bytes); // positioned reads above do not advance this handle's offset
    await file.truncate(bytes.length);
  } finally { await file.close(); }
}

async function retrieve(urlText: string, deps: ResearchDependencies): Promise<
  { redirect: string } | { body: string }
> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ResearchError("TIMEOUT")); }, deps.timeoutMs);
  });
  const operation = async () => {
    const url = assertSourceUrl(urlText);
    const addresses = await deps.resolve(url.hostname);
    controller.signal.throwIfAborted();
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) fail("DNS_POLICY");
    const response = await deps.request(url, addresses[0]!, controller.signal);
    const abort = () => response.cancel();
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      controller.signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) fail("REDIRECT_POLICY");
        let destination: string;
        try { destination = new URL(location, url).href; assertSourceUrl(destination); }
        catch { return fail("REDIRECT_POLICY"); }
        return { redirect: destination };
      }
      if (response.status !== 200) fail("HTTP_STATUS");
      const type = response.headers["content-type"] ?? "";
      if (!/^(text\/(?:html|plain|markdown))(?:\s*;|$)/i.test(type)) fail("CONTENT_TYPE");
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1]?.toLowerCase();
      if (charset && !["utf-8", "utf8", "us-ascii"].includes(charset)) fail("TEXT_ENCODING");
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding.toLowerCase() !== "identity") fail("CONTENT_ENCODING");
      const length = response.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > RESEARCH_LIMITS.bodyBytes)) fail("BODY_LIMIT");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > RESEARCH_LIMITS.bodyBytes) fail("BODY_LIMIT");
        chunks.push(chunk);
      }
      if (length !== undefined && size !== Number(length)) fail("NETWORK");
      try { return { body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) }; }
      catch { return fail("TEXT_ENCODING"); }
    } finally {
      controller.signal.removeEventListener("abort", abort);
      response.cancel();
    }
  };
  try { return await Promise.race([operation(), timeout]); }
  finally { clearTimeout(timer!); }
}

/** Dependency injection is for trusted tests, never configurable through page content. */
export function createResearchTraining(overrides: Partial<ResearchDependencies> = {}): (options: ResearchOptions) => Promise<ResearchSummary> {
  const deps = { ...defaults, ...overrides };
  if (!Number.isFinite(deps.timeoutMs) || deps.timeoutMs <= 0 || deps.timeoutMs > RESEARCH_LIMITS.timeoutMs) throw new Error("INVALID_TIMEOUT");
  const locks = new Map<string, Promise<unknown>>();
  async function run(options: ResearchOptions): Promise<ResearchSummary> {
    const { profileId, cachePath, maxRequests } = options;
    const now = deps.now();
    let cache: Cache;
    try { cache = await readCache(cachePath, profileId, now) ?? emptyCache(profileId); }
    catch { cache = emptyCache(profileId); }
    const quota = Math.min(maxRequests, RESEARCH_LIMITS.requests);
    let requests = 0, fetched = 0;
    const notes: string[] = [];
    const fresh = (r: SourceRecord) => r.fetchedAt > 0 && now - r.fetchedAt < RESEARCH_LIMITS.ttlMs;
    const due = GUIDE_SOURCES.filter(source => {
      const r = cache.records.find(record => record.url === source.url);
      return !r || (r.failure ? now - r.checkedAt >= RESEARCH_LIMITS.failureTtlMs : !fresh(r));
    }).sort((a, b) => (cache.records.find(r => r.url === a.url)?.checkedAt ?? -1)
      - (cache.records.find(r => r.url === b.url)?.checkedAt ?? -1));
    for (const source of due) {
      if (requests >= quota) break;
      const old = cache.records.find(r => r.url === source.url);
      let url = source.url as string, redirects = 0;
      const visited = new Set<string>();
      try {
        while (true) {
          if (requests >= quota) fail("REQUEST_QUOTA");
          if (visited.has(url)) fail("REDIRECT_LIMIT");
          visited.add(url);
          requests++; // Failed DNS and redirect hops consume the same hard quota.
          const result = await retrieve(url, deps);
          if ("redirect" in result) {
            if (++redirects > RESEARCH_LIMITS.redirects) fail("REDIRECT_LIMIT");
            url = result.redirect;
            continue;
          }
          const at = deps.now();
          const parsed = parseGuide(result.body, url, profileId, at);
          const record: SourceRecord = { url, checkedAt: at, fetchedAt: at, failure: null, claims: parsed.claims,
            unsupported: UNSUPPORTED.filter(name => parsed.rejected.includes(rejection(url, name))) };
          cache.records = cache.records.filter(r => r.url !== url);
          cache.records.push(record);
          // A redirected source never inherits the destination's claims or freshness.
          if (url !== source.url) {
            cache.records = cache.records.filter(r => r.url !== source.url);
            cache.records.push({ url: source.url, checkedAt: at, fetchedAt: old?.fetchedAt ?? 0,
              failure: "REDIRECT_POLICY", claims: old?.claims ?? [], unsupported: old?.unsupported ?? [] });
          }
          fetched++;
          break;
        }
      } catch (error) {
        const code = error instanceof ResearchError ? error.code : "NETWORK";
        cache.records = cache.records.filter(r => r.url !== source.url);
        cache.records.push({ url: source.url, checkedAt: deps.now(), fetchedAt: old?.fetchedAt ?? 0,
          failure: code, claims: old?.claims ?? [], unsupported: old?.unsupported ?? [] });
      }
    }
    if (requests) {
      try { await writeCache(cachePath, cache); } catch { notes.push("CACHE_NOT_SAVED"); }
    }
    const end = deps.now();
    const usable = (r: SourceRecord) => !r.failure && r.fetchedAt > 0 && end - r.fetchedAt < RESEARCH_LIMITS.ttlMs;
    const claims = cache.records.flatMap(r => r.claims.map(c => ({ ...c,
      status: usable(r) ? "UNVERIFIED" as const : "STALE" as const })));
    const suggestedMonsters = [...new Set(claims.filter(c => c.status === "UNVERIFIED").flatMap(c => c.requirements))];
    const rejected = [...notes, ...cache.records.flatMap(r => [
      ...(r.failure ? [`${r.url} | ${r.failure}`] : []),
      ...r.unsupported.map(name => rejection(r.url, name)),
      ...(r.fetchedAt && !r.claims.length ? [`${r.url} | NO_CURATED_CANDIDATES`] : []),
    ])];
    const missing = GUIDE_SOURCES.filter(s => !cache.records.some(r => r.url === s.url));
    if (missing.length) rejected.push(`QUEUED_SOURCES:${missing.length}`);
    const failures = cache.records.some(r => r.failure);
    const status = suggestedMonsters.length
      ? fetched ? (failures ? "PARTIAL_UNVERIFIED" : "FETCHED_UNVERIFIED") : "CACHED_UNVERIFIED"
      : claims.length ? "STALE_EVIDENCE" : requests ? "NO_USABLE_EVIDENCE"
      : failures ? "CACHED_FAILURE" : "NO_REQUESTS";
    return { claims, suggestedMonsters, rejected, status,
      fetchedAt: Math.max(0, ...cache.records.map(r => r.fetchedAt)) };
  }
  return async options => {
    if (!options || typeof options.profileId !== "string" || !options.profileId.trim() || options.profileId.length > 240
      || typeof options.cachePath !== "string" || !options.cachePath || options.cachePath.includes("\0")
      || !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 0) throw new Error("INVALID_RESEARCH_OPTIONS");
    const key = resolvePath(options.cachePath);
    const previous = locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => run({ ...options, cachePath: key }));
    locks.set(key, pending);
    try { return await pending; }
    finally { if (locks.get(key) === pending) locks.delete(key); }
  };
}

/** Importing this module has no I/O. Only an explicit runner call can fetch/save evidence. */
export async function researchTraining(options: ResearchOptions): Promise<ResearchSummary> {
  return defaultResearch(options);
}
const defaultResearch = createResearchTraining();
