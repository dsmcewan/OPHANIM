// THE RUNTIME'S OBLIGATIONS as a graph source (Slice B2, KD2-1, KD2-6; docs/knowledge-graph/slice-b2.md).
//
// Purpose   The run-time dependencies OPHANIM's runtime records: each obligation of the runtime state on the board ref
//           `refs/board/ophanim` (ophanim/runtime.mjs writes it, ophanim/board.mjs reads it) and the obligations its spec
//           `dependsOn`. Read THROUGH THE BOARD'S OWN READER, READ ONLY: verifyRuntimeChain checks the ref's history is a
//           lawful sequence of single transitions, then readRuntimeSnapshot materializes the state at the pinned
//           controller commit. A DECLARED basis: the obligation specs state their dependencies.
// Inputs    A state directory holding a board (<stateDir>/pantheon). The version is the controller commit's id.
// Facts     work/obligation/<id>   kind, scope, output key, status, attempts, the NAMES of its inputs (never their
//                                  values), the revision of the state it was read at
//           depends-on             an obligation -> each obligation its spec names in dependsOn
//           A dependency the state does not hold is an unresolved obligation, never invented.
// Must never  Write the board (no lock is taken, no ref moved, nothing created where no board is); read an input's
//           value or a candidate; name the state directory's absolute path in a fact.
import fs from 'node:fs';
import {entityId} from '../../../packages/graph/index.mjs';
import {readRuntimeSnapshot, verifyRuntimeChain, boardPath} from '../../board.mjs';

export const BOARD_SOURCE = 'ophanim.board';
export const BOARD_EXTRACTOR = 'ophanim.board.extractor';
export const BOARD_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [BOARD_SOURCE]});
export const BOARD_REF = 'refs/board/ophanim';
export const obligationId = id => entityId({domain: 'work', type: 'obligation', key: id});
const HEX = /^[0-9a-f]{64}$/;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The obligations of the runtime state at controller commit `version` (64 hex), as the extractor's drafts. */
export function boardFacts(stateDir, version) {
  if (!HEX.test(version ?? '')) throw new Error(`${version} is not a controller commit id`);
  const chain = verifyRuntimeChain(stateDir, {head: `commit:${version}`});
  const {state} = readRuntimeSnapshot(stateDir, `commit:${version}`);
  const rows = Object.values(state?.obligations ?? {}).sort((a, b) => byString(a.spec.id, b.spec.id)), ids = new Set(rows.map(r => r.spec.id)), drafts = [], ghosts = new Map();
  for (const r of rows) {
    const s = r.spec;
    drafts.push({entity: obligationId(s.id), ref: `${BOARD_REF}#${s.id}`, attributes: {id: s.id, kind: s.kind, scope: s.scope, output_key: s.outputKey, status: r.status,
      attempt: r.attempt ?? null, release_attempts: r.releaseAttempts ?? null, max_attempts: s.maxAttempts ?? null, input_names: Object.keys(s.inputs ?? {}).sort(),
      depends_on: [...s.dependsOn].sort(), revision: state.revision, chain: {commits: chain.commits, deltas: chain.deltas}}});
    for (const d of [...s.dependsOn].sort()) {
      if (!ids.has(d)) (ghosts.get(d) ?? ghosts.set(d, []).get(d)).push(s.id);
      drafts.push({type: 'depends-on', from: obligationId(s.id), to: obligationId(d), ref: `${BOARD_REF}#${s.id}`, attributes: {basis: 'the obligation\'s spec names it (dependsOn)'}});
    }
  }
  for (const [d, by] of [...ghosts].sort()) drafts.push({entity: obligationId(d), ref: `${BOARD_REF}#${d}`, status: 'unresolved', attributes: {id: d, named_by: by.sort()},
    missing_evidence: ['named in a dependsOn, but not an obligation of the state at this commit']});
  return drafts;
}

/** The adapter: the board under `stateDir`, read only; current() is the controller ref's head after the chain verifies. */
export function boardSource({stateDir, extractor = BOARD_EXTRACTOR} = {}) {
  return {id: BOARD_SOURCE, extractor, ref: BOARD_REF,
    authority: 'the runtime state on the board ref refs/board/ophanim, read through ophanim/board.mjs (verifyRuntimeChain, readRuntimeSnapshot), read only',
    current: () => {
      if (!stateDir || !fs.existsSync(boardPath(stateDir))) throw new Error('no board where one was named: nothing is created');
      const head = verifyRuntimeChain(stateDir).head;
      if (!head) throw new Error(`the board holds no ${BOARD_REF}`);
      return {version: head.split(':')[1]};
    },
    readAt: version => boardFacts(stateDir, version)};
}
