// Exercise an actual signed, locked append with a deliberately short first write. The parent
// releases this worker only after its independent ledger reader has observed the partial line.
import fs from 'node:fs';
import path from 'node:path';
import {workerData, parentPort} from 'node:worker_threads';
import {openLedger, defineKinds} from '../../chain.mjs';

const {dir, anchor, seat, orderer, latch} = workerData;
const target = fs.statSync(path.join(dir, 'chain.jsonl'));
const write = fs.writeSync;
let split = false;
fs.writeSync = (fd, data, ...args) => {
  const file = fs.fstatSync(fd);
  if (split || file.dev !== target.dev || file.ino !== target.ino) return write(fd, data, ...args);
  split = true;
  const bytes = Buffer.from(data);
  const count = write(fd, bytes, 0, Math.floor(bytes.length / 2));
  parentPort.postMessage('partial');
  if (Atomics.wait(latch, 0, 0, 10_000) === 'timed-out') throw new Error('reader did not release the writer');
  return count;
};
const kinds = defineKinds({measure: {authors: () => true, validate: () => null, rederive: () => null}});
openLedger({dir, kinds, anchor}).append({
  kind: 'measure', payload: {value: 1}, author: {key_id: seat.key_id}, signer: seat, order: orderer,
});
