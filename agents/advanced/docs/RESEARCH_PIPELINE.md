# Astra bounded guide research

Implemented in `src/guide-research.ts`; tests in `tests/guide-research.test.ts`.
Scope: one fixed early-melee research question for Astra. The runner integrates this
module later. Importing it does not fetch, write, log, schedule work, or control a game.
Existing contracts, researcher validator, arbiter, observer, CLI and policies are unchanged
by this work package. No model, paid service, account, subprocess or game API is used by
the module.

## Runner API

```ts
import { researchTraining, type ResearchSummary } from "./guide-research.ts";

// Inside an explicit queued research task, outside urgent observation/action handling:
const result: ResearchSummary = await researchTraining({
  profileId: profile.profile_id,
  cachePath: ownedResearchCachePath,
  maxRequests: Math.min(2, remainingResearchRequestBudget),
});
```

The exported signature is
`researchTraining({profileId: string, cachePath: string, maxRequests: number}): Promise<ResearchSummary>`.
`claims` uses the existing `ResearchClaim` shape; `suggestedMonsters: string[]` contains
research leads only; `rejected: string[]` contains fixed reasons; `status: string`
describes retrieval/cache state; `fetchedAt: number` is the latest successfully parsed
source retrieval in Unix milliseconds, or **0 when none exists**. Individual claims
retain their own retrieval timestamps. Publication dates are left `null`: neither the
current clock nor an HTTP Date header is used as an invented content date.

The caller must provide its dedicated cache file and an existing parent directory. Only
an explicit function call can persist that cache. A positive budget permits at most two
attempts; a zero budget only reads existing evidence. Invalid inputs reject before I/O.
No endpoint or search query can be supplied through this API.

The runner owns hourly/session budgeting, targeted queue scheduling, cancellation of
obsolete proposals and checking that the returned claims still match its current profile.
Reserve the requested quota before dispatch; this module does not enforce an account-wide
hourly limit. It does not run autonomous arbitrary web search, crawl links, or fetch every
guide each tick. Calls for the same cache serialize within one factory instance. Use one
writer/factory for a cache; there is no cross-process controller or lock here.

## Exact source allowlist and evidence quality

Only these three literal HTTPS documents are allowed, including redirect destinations:

| Source | Treatment |
| --- | --- |
| [Clawscape README](https://raw.githubusercontent.com/Joostrothweiler/clawscape/main/README.md) | Repository URL found in the checked-out Clawscape README. Public access returned 404 on 7 September 2026. Kept as an explicit unavailable source; no training claims synthesized from it. |
| [Lost City: Combat training!](https://lostcity.rs/t/combat-training/6607) | Authored community replies, including BukLau and nihaowdy, checked online. Their early-training discussion motivates the manually curated Chicken/Cow research baseline. Community advice is not proof of this server's rules. |
| [OSRS Wiki: Free-to-play melee training](https://oldschool.runescape.wiki/w/Free-to-play_melee_training) | Primary community training guide, checked through web search and subsequently fetched by the production reader. Modern OSRS content and requirements are not automatically compatible. |

The queue prefers the Clawscape document, then the Lost City discussion, then the Wiki.
Fresh successful sources and recent failures are skipped, so an unvisited third source
can be fetched on a later call. An inaccessible document does not authorize another
domain, a mirror, a proxy, credentials, or a local documentation server.

The baseline is deliberately curated, not an HTML recommendation classifier. The parser
requires a known page identity; Lost City also requires a known author name in the text.
It checks whole-word mentions of **Chicken** and **Cow**, discarding markup, comments,
scripts, styles, templates and noscript blocks. These checks confirm only a mention in
the response, not the meaning of its surrounding advice or the author of that mention.
Changing text can cause conservative misses. No quotes, rates, level bands, prices,
quest completion, paths, NPC IDs, or equipment capabilities are inferred from HTML.
All saved prose is a fixed editorial paraphrase explicitly explaining this limitation.

Every emitted claim is `UNVERIFIED`, even when a name also appears in an observation.
`suggestedMonsters` is not an approved target list. The integrator must resolve requirements
against the approved static catalog and current profile using the existing validator,
then conduct bounded live trials with the ordinary safety and action pipeline. An absent
catalog entry remains unsupported; matching a visible name cannot skip catalog or variant,
access, equipment, danger, and trial checks. This module never promotes claims to
`COMPATIBLE_STATIC` or `OBSERVED`, and never creates a measured method estimate.

Sand crab, Ammonite crab, Brutus, Scurrius, Obor, Bryophyta, Ogress warrior and Giant frog
mentions produce fixed `UNSUPPORTED_NO_APPROVED_CATALOG` rejection records. Other names
also cannot enter suggestions because the positive candidate vocabulary contains only
Chicken and Cow. This is not a claim that every excluded entity is absent from every
deployment; there is no approved catalog for them in this research module.

## Actual upstream constraints for integration

Read completely on 7 September 2026 from the read-only dependency:

- [upstream/learnings/fishing.md](../../tmp/clawscape/upstream/learnings/fishing.md)
- [upstream/learnings/cooking.md](../../tmp/clawscape/upstream/learnings/cooking.md)

These local notes are the relevant source evidence for these compatibility restrictions,
not a modern guide's assumed map. They are documentation inspected by development; the
runtime reader does not read the game checkout or execute their example scripts.

| Candidate or location | Required treatment |
| --- | --- |
| Lumbridge Swamp `(3239, 3147)` fishing | The upstream fishing note explicitly says there are **no fishing spots at all** there. The parser flags a fishing/net/bait mention with Lumbridge Swamp, or this coordinate pair, as `CONTRADICTED_UPSTREAM_FISHING_NO_SPOTS`. It cannot become a candidate. A mention flag does not assert that the fetched page itself recommended the location. |
| Lumbridge `(3238, 3251)` level-one fishing | The same upstream note says there are no level-one spots here. No fishing routes or supply candidates are generated by this module. |
| Draynor `(3087, 3230)` | The upstream note identifies Net/Bait for shrimp/anchovies, with nearby dark wizards. The integrator supplies approach `(3094, 3226)` and exclusion rectangle `x=3076..3092, z=3233..3247`; those exact bounds are integration constraints supplied by the main task, not coordinates inferred from the guide reader. Recheck visible NPC options, route and threat in the normal live pipeline. |
| Range `(3230, 3196)` near Bob's Axes | Upstream cooking identifies `Range` here as requiring no quest. It is a source-supported lead, not a guarantee of current reachability or safety. |
| Castle `(3212, 3215)` | Upstream cooking identifies `Cooking range` as requiring Cook's Assistant completion. Never assume it is usable from its name or a modern guide. |

Fishing/cooking do not expand this module's fixed early-melee question or network allowlist.
The main task reports that its loop is running and M1 passed; this work package does not
reassess M1, control that loop, or claim completion of M4's locally tested guide-derived method.

## Network bounds

- Maximum **2 attempts per invocation**, including failed DNS and each redirect hop;
  maximum **1 redirect hop**, with loop detection. Every destination must equal an
  allowlisted document and resolve exclusively to allowed public addresses.
- HTTPS only, no URL credentials, custom ports, query strings, fragments or arbitrary
  paths. Reject loopback, private, link-local, multicast, reserved/documentation IPv4
  and special/transition IPv6. A DNS answer mixing public and private IPs fails closed.
- The native HTTPS transport pins one validated IP in its socket lookup. It preserves
  the source hostname for Host, TLS SNI and certificate verification; single-family
  connection mode avoids a second DNS lookup or address fallback. No connection pool,
  cookie jar, authorization headers, proxy configuration or browser session is used.
- **8 seconds per attempt**, covering DNS, connection, headers and body. A timeout aborts
  the request; a late DNS response cannot initiate an HTTP request. Two attempts can
  take about 16 seconds plus bounded parsing/cache I/O, so queue work off the game loop.
- Headers capped at **16 KiB** by the HTTPS client; response body capped at **512 KiB**
  both by declared length and streamed bytes. Require HTTP 200 and `text/html`,
  `text/plain` or `text/markdown`; only UTF-8/ASCII declarations and valid UTF-8 bytes.
  Request identity encoding and reject compressed responses, executable MIME, truncated
  bodies, challenge pages and unidentified documents. Rejecting compressed-only pages
  is an intentional availability limitation. No decompression bomb or HTML execution.
- Redirect bodies are not parsed. Other bodies are read once; no page links, embedded
  resources, commands, dynamic code or instructions are acted on. The linear markup
  scan also bounds malformed script/comment processing. Network errors are reduced to
  fixed codes; raw responses, credential strings and exception messages are not logged.

## Cache and failure semantics

The cache contains an Astra ownership marker, schema/question version, profile ID, and
up to three source records with check time, successful fetch time, content hashes, fixed
rejections, failures and claims. Maximum file size is **64 KiB**. No full HTML is persisted.
Successful evidence expires after **7 days per source**; profile changes invalidate all
old claims. A failure has a **15-minute retry backoff**, which never refreshes the date
of an older successful claim. Failed or expired source claims are returned as `STALE`,
excluded from suggestions, and retain their original dates. A new source/profile failure
has no invented claim or successful retrieval timestamp.

`FETCHED_UNVERIFIED` means current retrieval produced leads; `PARTIAL_UNVERIFIED` also
reports unavailable sources. `CACHED_UNVERIFIED` explicitly identifies cached leads.
`STALE_EVIDENCE`, `NO_USABLE_EVIDENCE`, `CACHED_FAILURE` and `NO_REQUESTS` are not successful
research. Inspect claim statuses and `rejected` as well as the summary. A cached result
does not establish that the network worked on this invocation. The newest successful
source time must not be applied to another source's older claim.

The caller assigns an exclusive cache file, not an existing game/policy/config file.
Creation is exclusive; updates require the Astra ownership/schema marker. Symlinks,
hard links, foreign files and oversized files are refused. Invalid cached claims cannot
promote themselves: schema, source, profile, dates, fixed names/paraphrases, fingerprints
and `UNVERIFIED` status are checked. An update failure reports `CACHE_NOT_SAVED` while
returning any evidence actually retrieved. Corrupt/foreign cache files are left intact;
choose another owned file or repair them explicitly. No parent directory, backup or
sidecar is created. Writes are not transactional: a crash during a cache update can
leave unusable cache data. It then fails closed and cannot authorize gameplay. This is
disposable research memory, not a replacement for the existing durable action store.

## Verification

All automated retrieval tests use temporary files, injected DNS/transport and a fixed
fixture clock. They do not use the game, a live network, credentials or a paid API.
Exports `parseGuide`, `parseResearchCache`, `assertSourceUrl`, `isPublicAddress` and
`createResearchTraining` support pure parser/policy tests and trusted dependency injection.
The ordinary runner uses `researchTraining` with the native transport.

Actual production calls, before the integrator requested no further network checks:

- Lost City successfully retrieved at `2026-09-07T21:56:09.159Z`
  (`retrieved_at=1788818169159`). Response SHA-256:
  `ee00ab26975520d121f219c0ee6db2462be69c531895da0b9a0b7b3a32d55691`.
  Chicken and Cow were saved with source URL and `UNVERIFIED` status.
- The next invocation retrieved the queued OSRS Wiki page at
  `2026-09-07T21:56:55.135Z` (`retrieved_at=1788818215135`). It returned the same two
  research leads and rejected Brutus, Obor, Bryophyta, Ogress warrior and Giant frog.
- Clawscape's public README failed with `HTTP_STATUS` (web verification showed 404).
  It has no fabricated evidence or successful retrieval date. The combined result was
  `PARTIAL_UNVERIFIED`. An initial transport failure was diagnosed and corrected by
  fixing single-address DNS lookup; it was not counted as successful retrieval.

These are retrieval observations, not gameplay or catalog validation. Evidence was
written only to a dedicated OS temporary cache, outside the project. No further network
calls are needed before runner integration.

Local verification, completed 8 September 2026 (Europe/Amsterdam):

| Check | Result |
| --- | --- |
| `bun run check` | Passed. The HTTPS connection option uses `RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily">`, preserving the working pinned-address behavior with the installed typings. |
| `bun test tests/guide-research.test.ts tests/core.test.ts` | 68 passed, 0 failed, 415 assertions: 28 research tests plus the 40 existing core tests. |
| `bun test` | 159 passed, 10 failed across 169 tests. All failures were in the concurrently developed `tests/live-policy.test.ts` (food/supply, tool routing, fishing waits and detour expectations). Research tests passed. No out-of-scope policy or test files were changed to address these failures. This is not a green whole-project suite. |
| `bun run evaluate` in an unchanged temporary copy | Passed: 4 checkpoints, 20 fixture pairs per checkpoint; synthetic adaptation changed from method-b to method-a after changed-cost measurements. The existing evaluator writes a report, so a temporary copy of the required project files/dependency was used to avoid modifying the project's existing report. This is synthetic mechanism evidence only. |

Only `src/guide-research.ts`, `tests/guide-research.test.ts` and this document were added
by this work package. Runner integration and compatible-candidate live trials remain
with the main task; no shared-contract changes are requested.
