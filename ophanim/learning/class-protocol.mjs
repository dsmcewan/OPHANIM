export const EDUCATIONAL_STATUSES = new Set([
  "not_attempted",
  "attempted",
  "needs_revision",
  "ready_for_independent_check",
  "demonstrated_with_limits",
  "insufficient_evidence",
]);

export function validatePhaseStatus(progressMarkdown, phase) {
  if (typeof progressMarkdown !== "string" || !Number.isSafeInteger(phase) || phase < 1) {
    return { ok: false, reason: "invalid progress input" };
  }
  const prefix = `${phase}.`;
  const row = progressMarkdown.split(/\r?\n/).find(line => {
    const cells = line.split("|").map(cell => cell.trim());
    return cells[1]?.startsWith(prefix);
  });
  if (!row) return { ok: false, reason: `phase ${phase} row not found` };
  const status = row.split("|").map(cell => cell.trim())[2];
  if (!EDUCATIONAL_STATUSES.has(status)) {
    return { ok: false, reason: `unsupported educational status: ${status}` };
  }
  return { ok: true, status };
}
