/**
 * Detect near-duplicate orchestrator narratives (e.g. repeated 「收到。目标明确…」)
 * so stream UI does not show the same ack twice across reason steps + final answer.
 */

export function normalizeNarrativeForCompare(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/[「」『』【】]/g, "")
    .replace(/[与、,，]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractTickers(text: string): string[] {
  const found = text.toUpperCase().match(/\b\d{6}\.(?:SH|SZ|SS|HK)\b/g);
  return found ? [...new Set(found)].sort() : [];
}

/** True when two user-facing narratives are the same re-ack / re-plan opener. */
export function isNarrativeNearDuplicate(a: string, b: string): boolean {
  const na = normalizeNarrativeForCompare(a);
  const nb = normalizeNarrativeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const prefixLen = 48;
  if (na.slice(0, prefixLen) === nb.slice(0, prefixLen)) return true;

  const ackA = /^(收到|收到任务|收到子任务)[。.,:\s]/.test(na);
  const ackB = /^(收到|收到任务|收到子任务)[。.,:\s]/.test(nb);
  if (!(ackA && ackB)) return false;

  const coreA = na.replace(/^(收到任务|收到子任务|收到)[。.,:\s]*/, "");
  const coreB = nb.replace(/^(收到任务|收到子任务|收到)[。.,:\s]*/, "");
  if (coreA.slice(0, 28) === coreB.slice(0, 28)) return true;

  const tickersA = extractTickers(a);
  const tickersB = extractTickers(b);
  if (
    tickersA.length > 0 &&
    tickersA.length === tickersB.length &&
    tickersA.every((t, i) => t === tickersB[i]) &&
    /目标明确|趋势研判|操作建议/.test(coreA) &&
    /目标明确|趋势研判|操作建议/.test(coreB)
  ) {
    return true;
  }
  return false;
}
