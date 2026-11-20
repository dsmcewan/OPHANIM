// SYNTHETIC acceptance check of the test request `adder`: the product must add.
import {add} from '../add.mjs';
if (add(2, 3) !== 5 || add(-1, 1) !== 0) { console.error('add is wrong'); process.exit(1); }
console.log('ok');
