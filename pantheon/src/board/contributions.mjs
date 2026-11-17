// Q7 (measurement): what each chair of the 1 + 4 arrangement contributed, DERIVED from the board.
//
// Nothing here is stored. The projection is recomputed from the entries reachable from the board's
// refs, so a reader checks it by recomputing it (`verifyChairContributions`). It ranks no model and
// authorizes no seat change: it is the evidence a measured adjustment would need, and the input the
// investigation ranking reads. A seat change stays a signed, scoped decision elsewhere.
import { createHash } from "node:crypto";
import { canonicalCodeUnit } from "../../../packages/ledger/canonical.mjs";
import { occupancyTrail } from "./occupancy.mjs";

export const CONTRIBUTIONS_SCHEMA = "pantheon.chair-contributions/v1";
// Mode -> chair. The scout chair covers the intake fan-out and the board's explore/refute forks; the
// judge chair covers syntheses (board/run-swarm.mjs). All five chairs of the 1 + 4 arrangement report.
export const CHAIR_OF_MODE = Object.freeze({ plan: "lead@orch", work: "impl@build", critique: "check@review",
  explore: "scout@opt", refute: "scout@opt", synthesize: "arbiter@judge" });

// The projection digest is CODE_UNIT_V1 (packages/ledger/canonical.mjs), the order it was always computed in.
const stable = v => canonicalCodeUnit(v);
const sha = v => createHash("sha256").update(stable(v)).digest("hex");
const occupant = a => `${a.vendor}/${a.model ?? "unrecorded"}`;

/** Every entry reachable from every ref, once each, with its cid. */
function reachable(store, refs) {
  const seen = new Set(), entries = [], heads = refs.list().map(r => ({ name: r.name, cid: r.cid })).sort((a, b) => a.name.localeCompare(b.name));
  for (const { cid: head } of heads) {
    for (const queue = [head]; queue.length;) {
      const cid = queue.pop();
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const commit = store.get(cid);
      queue.push(...(commit.parents ?? []));
      for (const r of commit.records ?? []) {
        if (seen.has(r)) continue;
        seen.add(r);
        entries.push({ cid: r, ...store.get(r) });
      }
    }
  }
  return { heads, entries: entries.sort((a, b) => a.cid.localeCompare(b.cid)) };
}

export function chairContributions({ store, refs }) {
  const { heads, entries } = reachable(store, refs);
  const seat = entries.filter(e => e.author?.seat_id && CHAIR_OF_MODE[e.author.mode]);
  const artifacts = entries.filter(e => e.kind === "artifact");
  const repros = entries.filter(e => e.kind === "repro");
  const independentRuns = artifact => repros.filter(r => (r.links?.derived_from ?? []).includes(artifact.cid) &&
    (r.author?.vendor === "controller" || (r.author?.vendor && r.author.vendor !== artifact.author?.vendor)));

  const chairs = [...new Set(Object.values(CHAIR_OF_MODE))].map(chair => {
    const mine = seat.filter(e => CHAIR_OF_MODE[e.author.mode] === chair);
    const occupants = {};
    for (const e of mine) {
      const o = occupants[occupant(e.author)] ??= { vendor: e.author.vendor, model: e.author.model ?? null, entries: 0 };
      o.entries++;
    }
    // A chair instance is the chair on one slot (work, critique) or one fork (scout): reseats are per instance.
    const instanceOf = e => e.kind === "artifact" ? `slot:${e.payload.slot}` : e.kind === "critique" ? `slot:${e.payload?.target?.slot}`
      : ["explore", "refute", "synthesize"].includes(e.author.mode) ? `${e.author.mode}:${e.author.vendor}` : "ticket";
    const instances = {};
    for (const e of mine.filter(e => ["artifact", "critique", "plan", "search", "hypothesis"].includes(e.kind))) (instances[instanceOf(e)] ??= []).push(e);
    let reseats = 0;
    const inconsistent = [], unrecorded = [];
    for (const [instance, list] of Object.entries(instances).sort(([a], [b]) => a.localeCompare(b))) {
      const ordered = list.sort((a, b) => (a.payload?.rev ?? a.payload?.target?.rev ?? 0) - (b.payload?.rev ?? b.payload?.target?.rev ?? 0) || a.cid.localeCompare(b.cid));
      // Entries written before authors carried a model cannot show a reseat; say so rather than count zero.
      if (!ordered.every(e => e.author.model)) { unrecorded.push(instance); continue; }
      try { reseats += occupancyTrail(ordered.map(e => e.author)).reseats.length; }
      catch (e) { inconsistent.push({ instance, why: e.message }); }
    }
    const metrics = { entries: mine.length, reseats, occupancy: { inconsistent, unrecorded } };
    if (chair === "impl@build") {
      const slots = [...new Set(artifacts.map(a => a.payload.slot))].sort();
      metrics.slots = slots.map(slot => {
        const revs = artifacts.filter(a => a.payload.slot === slot).sort((a, b) => a.payload.rev - b.payload.rev);
        const green = revs.find(a => independentRuns(a).some(r => r.payload.exit === 0));
        return { slot, revisions: revs.length, firstGreenRevision: green?.payload.rev ?? null };
      });
      metrics.rework = metrics.slots.reduce((n, s) => n + Math.max(0, s.revisions - 1), 0);
    } else if (chair === "check@review") {
      const critiques = mine.filter(e => e.kind === "critique");
      const executed = c => artifacts.filter(a => a.links?.bytes === c.links?.target).flatMap(independentRuns);
      metrics.verdicts = { approve: critiques.filter(c => c.payload.verdict === "approve").length,
        request_changes: critiques.filter(c => c.payload.verdict === "request_changes").length };
      // An approval of bytes whose executed acceptance failed: the one verdict the board can contradict.
      metrics.rework = critiques.filter(c => c.payload.verdict === "approve" && executed(c).some(r => r.payload.exit !== 0)).length;
    } else if (chair === "lead@orch") {
      metrics.plans = mine.filter(e => e.kind === "plan").length;
      metrics.rework = Math.max(0, metrics.plans - 1);
    } else if (chair === "arbiter@judge") {
      metrics.syntheses = mine.filter(e => e.kind === "hypothesis").length;
    } else {
      metrics.forks = Object.keys(instances).filter(k => !k.startsWith("refute:")).length;
      metrics.refutations = mine.filter(e => e.author.mode === "refute").length;
    }
    return { chair, occupants: Object.values(occupants).sort((a, b) => occupant(a).localeCompare(occupant(b))), metrics };
  });
  const body = { schema: CONTRIBUTIONS_SCHEMA, boardSha: sha(heads), chairs,
    limits: { ranksModels: false, authorizesSeatChange: false, basis: "derived from board entries; recompute to check" } };
  return { ...body, projectionSha: sha(body) };
}

/** Recompute from the board and compare. A projection that is not the board's is refused. */
export function verifyChairContributions(projection, board) {
  const again = chairContributions(board);
  if (stable(again) !== stable(projection)) throw new Error("chair contributions differ from the board they claim to describe");
  return { ok: true, projectionSha: again.projectionSha };
}
