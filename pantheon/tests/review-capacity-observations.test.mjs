// The capacity rule counts unique, verified, live observations (review of 86ce18a, defect 4): twenty copies of one
// completed evidence bundle are one observation, not twenty; a bundle whose run.json is missing or differs is
// unverified and outside the rate; fixture (fake) runs are synthetic and reported apart from the live rule; and
// failed, unknown and inconclusive outcomes stay counted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { capacityReport } from "../src/practice/review-capacity.mjs";

const sha256 = text => "sha256:" + createHash("sha256").update(text).digest("hex");
// One board run as runBoardItem leaves it: run.json (with what answered) and the bundle naming it by digest.
function run(dir, name, { kind = "live", bundle = {}, review = { cycle: `sha256:${"c".repeat(64)}`, close: `sha256:${"d".repeat(64)}`, outcome: "verified" } } = {}) {
  mkdirSync(join(dir, name, "operating"), { recursive: true });
  const runJson = JSON.stringify({ key: name, providers: { kind } });
  writeFileSync(join(dir, name, "run.json"), runJson);
  const b = { item: "i", commit: createHash("sha1").update(name).digest("hex"), run: { shipped: true, run_json: join(dir, name, "run.json"), run_json_digest: sha256(runJson) },
    review: { ...review, cycle: `sha256:${createHash("sha256").update(name).digest("hex")}` }, ...bundle };
  writeFileSync(join(dir, name, "operating", "evidence.json"), JSON.stringify(b));
  return b;
}
const overwrite = (dir, name, b) => writeFileSync(join(dir, name, "operating", "evidence.json"), JSON.stringify(b));
const copy = (dir, name, b) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "evidence.json"), JSON.stringify(b)); };

test("twenty copies of one completed live bundle are one observation, not a verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-dup-"));
  try {
    const b = run(dir, "only-run");
    for (let i = 0; i < 19; i++) copy(dir, `copy-${i}`, b);
    const r = capacityReport({ bundles: dir });
    assert.equal(r.verdict.outcome, "insufficient_evidence", `20 copies of one bundle gave: ${r.verdict.why}`);
    assert.equal(r.needed, 1);
    assert.deepEqual([r.files, r.unique, r.duplicates], [20, 1, 19]);
    assert.equal(r.details.filter(d => d.duplicate_of).length, 19);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unverified bundles are counted apart; synthetic runs are reported apart from the live rule; failed, unknown and inconclusive stay counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-verify-"));
  try {
    for (let i = 0; i < 19; i++) run(dir, `live-${i}`);
    // A bundle whose run.json was changed after the fact, and one that names no run.json: unverified.
    const tampered = run(dir, "tampered");
    writeFileSync(tampered.run.run_json, JSON.stringify({ key: "tampered", providers: { kind: "live" }, edited: true }));
    copy(dir, "no-run-json", { item: "i", run: { shipped: true }, review: { close: `sha256:${"e".repeat(64)}`, outcome: "verified" } });
    // Fixture runs (fake providers, or none declared): synthetic.
    for (let i = 0; i < 25; i++) run(dir, `fake-${i}`, { kind: i % 2 ? "fake" : "undeclared" });
    let r = capacityReport({ bundles: dir });
    assert.equal(r.unverified.count, 2);
    assert.equal(r.needed, 19, "only the verified live observations are under the rule");
    assert.equal(r.verdict.outcome, "insufficient_evidence");
    assert.deepEqual([r.synthetic.needed, r.synthetic.completed], [25, 25]);
    // Kept categories: a failed run, a shipped run with no review, and an open cycle with nothing recorded against it.
    const failed = run(dir, "failed2");
    overwrite(dir, "failed2", { ...failed, run: { ...failed.run, shipped: false, error: { stage: "work", message: "429" } }, review: null });
    const unknown = run(dir, "unknown");
    overwrite(dir, "unknown", { ...unknown, review: null });
    run(dir, "inconclusive", { review: { close: null, failed: [], reviews: [{ lab: "xai", findings: [] }] } });
    r = capacityReport({ bundles: dir });
    assert.equal(r.counts.failed, 1);
    assert.equal(r.counts.unknown, 1);
    assert.equal(r.counts.inconclusive, 1);
    assert.equal(r.needed, 19 + 2, "unknown and inconclusive are non-completions under the rule; a failed run needed no review");
    assert.equal(r.verdict.outcome, "not_enough", r.verdict.why);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
