// Shared fixtures of the descriptor tests (register KG-11; pantheon/tests/jail-fds.test.mjs and fixtures/jail-fds-controller.mjs).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The descriptor probe (python: once started it holds nothing of its own, so its table is what it inherited). */
export const PROBE = join(HERE, "jail-fds-probe.py");
export const L150_STUB = join(HERE, "l150-sdk-stub");
/** A needle as the probe receives it: reversed, hex-encoded. */
export const hexRev = s => Buffer.from(String(s), "utf8").reverse().toString("hex");
/**
 * stdio handing a child `fd` at 9 and at 20 without close-on-exec (node's spawn dup2s each entry into place): a low one,
 * which node marks close-on-exec at its startup, and one above that range, which it does not.
 */
export const leaking = fd => ["ignore", "pipe", "pipe", ...Array(6).fill("ignore"), fd, ...Array(10).fill("ignore"), fd];

/**
 * The python SDK seat's stub interpreter, written to `dir`/python: the probe first, inside the seat's jail (its report in
 * the seat's --out dir, as jail-fds-seat.json), then the real agy-seat.py over the L-150 stub SDK, whose requests reach the
 * controller's metering relay. Returns its path.
 */
export function seatStub(dir, { needle_hex }) {
  const py = join(dir, "python");
  writeFileSync(py, `#!/bin/sh
# The python SDK seat's stub interpreter for the descriptor tests (KG-11): the probe first, inside the jail, then the real seat.
python3 ${JSON.stringify(PROBE)} @out ${needle_hex} seat "$@" || exit 97
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${JSON.stringify(L150_STUB)} exec python3 "$@"
`, { mode: 0o755 });
  return py;
}
