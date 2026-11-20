// FEEDING DETECT. After a run, the gate (check.mjs) and the stress tool (stress.mjs) hand their record to the self-repair
// lane's feedRecord (ophanim/operate/self-repair.mjs). The lane writes it, with the commit it ran on, into its records
// directory -- only while the lane is ON (the owner-signed switch) and only when the working tree IS that commit -- so a
// regression or a measured flake reaches Detect without a hand-made `self-repair record`.
//
// The lane is the inner wheel; these tools are outer ones. So the lane is loaded lazily, and any failure to load or write
// is a reported skip: a broken lane module can never stop a gate or change its verdict or exit code.
//
//   --self-repair-records DIR   feed DIR whatever the switch (still only for a clean tree)
//   --no-self-repair-records    do not feed Detect
import path from 'node:path';
import {ROOT} from './suites.mjs';

export const FEED_FLAGS = Object.freeze({dir: '--self-repair-records', off: '--no-self-repair-records'});
const loadLane = () => import('../../ophanim/operate/self-repair.mjs');

/** If argv[i] is a feed flag, record it on opt.feed (false, or a directory) and return the last index it used; else -1. */
export function feedFlag(argv, i, opt) {
  if (argv[i] === FEED_FLAGS.off) { opt.feed = false; return i; }
  if (argv[i] === FEED_FLAGS.dir) {
    const d = argv[i + 1];
    if (!d || d.startsWith('--')) throw new Error(`${FEED_FLAGS.dir} takes a directory`);
    opt.feed = path.resolve(d);
    return i + 1;
  }
  return -1;
}

/** Hand `record` to the lane: {written, commit} or {skipped: why}. Never throws. `feed` is opt.feed (undefined = by switch). */
export async function feedDetect({kind, record, feed = undefined, repo = ROOT, load = loadLane, env = process.env}) {
  if (feed === false) return {skipped: `${FEED_FLAGS.off} was given`};
  try {
    const {feedRecord} = await load();
    return feedRecord({repo, kind, record, env, dir: typeof feed === 'string' ? feed : null});
  } catch (e) {
    return {skipped: `the self-repair lane could not be loaded or written (${String(e?.message ?? e).slice(0, 160)}); this run's verdict is unaffected`};
  }
}

/** The one line a tool prints about it. */
export const feedLine = r => (r.written
  ? `self-repair: record for Detect written to ${path.relative(process.cwd(), r.written) || r.written} (commit ${r.commit.slice(0, 12)})`
  : `self-repair: no record for Detect (${r.skipped})`);

/** A gate run feeds Detect only when it is WHOLE: Detect reads the latest gate record as the whole picture, so a partial
 *  run (--only, --suite) that passed would hide a whole run's failures on the same commit. */
export const gatePartial = (mode, opt) => mode === 'run' && Boolean(opt.only || opt.suites?.length);

/** A stress record keeps only this repository's test files (repo-relative); a run of files outside it is not fed. */
const inRepo = f => typeof f === 'string' && f !== '' && !path.isAbsolute(f) && f !== '..' && !f.startsWith('../');
export function stressFeedable(rec) {
  const files = (rec?.files ?? []).filter(inRepo);
  if (!files.length) return null;
  return {...rec, files, byTest: (rec.byTest ?? []).filter(t => inRepo(t?.file))};
}
