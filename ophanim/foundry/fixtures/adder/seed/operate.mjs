// SYNTHETIC operation of the test request `adder`: use the product and report what it did, as one JSON line.
import {add} from '../add.mjs';
let sums = 0;
for (let i = 0; i < 100; i++) if (add(i, i) === 2 * i) sums++;
console.log(JSON.stringify({sums}));
