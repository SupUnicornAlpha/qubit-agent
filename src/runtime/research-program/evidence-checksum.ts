import { createHash } from "node:crypto";
export function evidenceDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object")
      return `{${Object.entries(item)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    return JSON.stringify(item);
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

/** A checksum verifies content consistency, never issuer authenticity or scientific validity. */
export function verifyEvidenceChecksum(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Record<string, unknown>;
  return (
    (bundle.format === "qubit-research-evidence-v1" ||
      bundle.format === "qubit-research-strategy-artifact-v1") &&
    !!bundle.evidence &&
    bundle.checksum === evidenceDigest(bundle.evidence)
  );
}
