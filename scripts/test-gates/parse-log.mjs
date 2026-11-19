// Reads a node:test log -- spec or TAP, or a mix -- as the gate needs it: per suite segment, the summary counts
// including `cancelled`, every cancelled or interrupted test with the file it came from, and every skipped test with
// its reason. A log holding several npm scripts is split at each `> name@version script` header (as npm prints them).
//
// Neither text format names the file of a skipped test, and TAP names a file only in a failure's YAML (`location:`),
// spec only in its closing "failing tests" list (`test at FILE:L:C`). So: cancellations are attributed to files from
// those; skips carry only name and reason here, and check.mjs attributes them by source search or, exactly, by
// re-running with events-reporter.mjs.
//
// Inputs:  log text.
// Outputs: [{header: {pkg, script}|null, format, counts|null, cancelled: [...], skipped: [...], interrupted: [...]}].
// Must never: read a summary line from one segment into another, or report a segment without a summary as clean.
const HEADER = /^> (\S+)@\S+ (\S+)/;
const COUNT = /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/;
// node:test's messages for a cancelled test: cancelledByParent (incl. a file whose event loop emptied with a test
// still pending) and testTimeoutFailure. node:test counts both under `cancelled`, not `fail`.
export const CANCEL_MESSAGES = [
  /Promise resolution is still pending but the event loop has already resolved/,
  /test did not finish before its parent and was cancelled/,
  /test timed out after \d+ms/,
  /cancelledByParent|testTimeoutFailure/,
];
const isCancelMessage = s => CANCEL_MESSAGES.some(r => r.test(s));
const unquote = s => s.trim().replace(/^'(.*)'$/, '$1');

function newSegment(header) {
  return {header, format: null, counts: null, cancelled: [], skipped: [], interrupted: [], failingList: []};
}

/** Parse one log into segments. */
export function parseLog(text) {
  const segments = [];
  let seg = newSegment(null);
  segments.push(seg);
  const lines = text.split(/\r?\n/);
  let tapBlock = null; // {name, yaml: {}} for the `not ok` whose YAML is being read
  let inFailing = false, pendingAt = null;
  const closeTap = () => {
    if (!tapBlock) return;
    const y = tapBlock.yaml;
    if (/^(cancelledByParent|testTimeoutFailure)$/.test(y.failureType ?? '') || isCancelMessage(y.error ?? '')) {
      seg.cancelled.push({name: tapBlock.name, file: y.location ? y.location.replace(/:\d+:\d+$/, '') : null,
        location: y.location ?? null, why: y.failureType ?? y.error ?? null});
    }
    tapBlock = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    const h = HEADER.exec(line);
    if (h) { closeTap(); seg = newSegment({pkg: h[1], script: h[2]}); segments.push(seg); inFailing = false; continue; }
    // TAP
    if (/^TAP version \d+/.test(t)) { seg.format = seg.format && seg.format !== 'tap' ? 'mixed' : 'tap'; continue; }
    let m;
    if ((m = /^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b ?(.*))?$/.exec(t))) {
      closeTap();
      if (!seg.format) seg.format = 'tap';
      if (m[3] === 'SKIP') seg.skipped.push({name: m[2], reason: m[4] ?? ''});
      else if (m[1] === 'not ok') tapBlock = {name: m[2], yaml: {}};
      continue;
    }
    if (tapBlock && (m = /^(location|failureType|error):\s*(.*)$/.exec(t))) { tapBlock.yaml[m[1]] = unquote(m[2]); continue; }
    if (tapBlock && /^\.\.\.$/.test(t)) { closeTap(); continue; }
    if ((m = /^# Interrupted while running: (.*?)(?: at (\S+))?$/.exec(t))) {
      seg.interrupted.push({name: m[1], file: m[2] ? m[2].replace(/:\d+:\d+$/, '') : null});
      continue;
    }
    // spec
    if ((m = /^﹣ (.*?)(?: \([\d.]+m?s\))? # (.*)$/.exec(t))) {
      if (!seg.format) seg.format = 'spec'; else if (seg.format === 'tap') seg.format = 'mixed';
      seg.skipped.push({name: m[1], reason: m[2]});
      continue;
    }
    if (/^Interrupted while running:$/.test(t)) { seg.interruptedHeading = true; continue; }
    if (seg.interruptedHeading && (m = /^⚠ (.*?)(?: \((\S+?):\d+:\d+\))?$/.exec(t))) {
      seg.interrupted.push({name: m[1], file: m[2] ?? null});
      continue;
    }
    if (/^✖ failing tests:$/.test(t)) { inFailing = true; continue; }
    if (inFailing) {
      if ((m = /^test at (\S+?):(\d+):(\d+)$/.exec(t))) { pendingAt = {file: m[1], location: `${m[1]}:${m[2]}:${m[3]}`, name: null, why: null}; seg.failingList.push(pendingAt); continue; }
      if (pendingAt && !pendingAt.name && (m = /^✖ (.*?)(?: \([\d.]+m?s\))?$/.exec(t))) { pendingAt.name = m[1]; continue; }
      if (pendingAt && pendingAt.name && !pendingAt.why && t) { pendingAt.why = unquote(t); continue; }
    }
    if ((m = COUNT.exec(t))) {
      closeTap();
      const kind = line.trimStart().startsWith('ℹ') ? 'spec' : 'tap';
      if (!seg.format) seg.format = kind; else if (seg.format !== kind) seg.format = 'mixed';
      // Several runs in one segment (no npm header between them) are summed; `runs` says how many there were.
      if (m[1] === 'tests') seg.runs = (seg.runs ?? 0) + 1;
      seg.counts ??= {};
      seg.counts[m[1]] = (seg.counts[m[1]] ?? 0) + Number(m[2]);
      continue;
    }
  }
  closeTap();
  for (const s of segments) {
    for (const f of s.failingList) if (f.why && isCancelMessage(f.why)) s.cancelled.push(f);
    delete s.failingList; delete s.interruptedHeading;
  }
  // Drop an empty leading segment (text before the first header with nothing in it).
  return segments.filter(s => s.counts || s.cancelled.length || s.skipped.length || s.interrupted.length || s.header);
}
