// Gate fixture (L-506): the file process is SIGKILLed mid-file (here by itself; an OOM kill looks the same).
import test from 'node:test';
test('fixture killed first', () => {});
test('fixture is killed', async () => { await new Promise(r => setTimeout(r, 20)); process.kill(process.pid, 'SIGKILL'); });
test('fixture killed never runs', () => {});
