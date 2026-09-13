import { z } from "zod";
import { CompatibilityProfile, ResearchClaim } from "./contracts.ts";

/** Evidence import only in v0.1: no network client, shell, or gameplay authority. */
export function validateClaim(raw: unknown, profile: z.infer<typeof CompatibilityProfile>, catalog: Set<string>) {
  const claim = ResearchClaim.parse(raw);
  const url = new URL(claim.source_url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("SOURCE_POLICY");
  // Imported evidence is NOT a network allowlist. A future fetcher must also validate DNS + each redirect.
  if (claim.profile_id !== profile.profile_id) return { ...claim, status: "STALE" as const };
  const missing = claim.requirements.filter(r => !catalog.has(r));
  if (missing.length) return { ...claim, status: "UNSUPPORTED" as const, validation_evidence: ["Missing: " + missing.join(",")] };
  // Source text and requirements alone cannot self-certify compatibility.
  return { ...claim, status: "UNVERIFIED" as const, validation_evidence: [] };
}
