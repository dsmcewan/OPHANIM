console.log('VISIBLE_STDOUT');
console.error('VISIBLE_STDERR');
process._rawDebug('RAW_DEBUG');
import { test } from 'node:test';
test('inner visible', t => t.diagnostic('DIAGNOSTIC'));
