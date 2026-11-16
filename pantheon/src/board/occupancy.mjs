// Who occupied a chair, as a recorded transition rather than a constant.
//
// A seat identity carries `occupancy_gen`. It starts at 1 and advances exactly when the occupant of
// the same chair changes -- a different vendor or a different model -- so a reseat is visible on the
// entry it produced. Re-using the same occupant does not advance it. Both directions are checkable
// from the board: `occupancyTrail` re-derives every generation from the entries in order.

const same = (a, b) => a.vendor === b.vendor && (a.model ?? null) === (b.model ?? null);

/**
 * The seat for the next entry in a chair. `previous` is the seat that last published for this
 * chair (or null), `routed` is the occupant that actually answered ({vendor, model}).
 */
export function nextOccupancy(previous, routed, { seat_id, mode }) {
  if (!routed?.vendor || typeof routed.model !== "string" || !routed.model) {
    throw new Error("nextOccupancy: the routed occupant must name its vendor and model");
  }
  const occupant = { vendor: routed.vendor, model: routed.model };
  const published = previous && typeof previous.model === "string";
  const gen = !published ? (previous?.occupancy_gen ?? 1) : same(previous, occupant) ? previous.occupancy_gen : previous.occupancy_gen + 1;
  return { vendor: occupant.vendor, seat_id, mode, occupancy_gen: gen, model: occupant.model };
}

/**
 * Re-derive the generations of one chair from its entries' authors, oldest first. Returns the
 * reseats it saw, or throws naming the first author whose generation does not follow.
 */
export function occupancyTrail(authors) {
  let previous = null;
  const reseats = [];
  for (const [i, author] of authors.entries()) {
    const expected = !previous ? 1 : same(previous, author) ? previous.occupancy_gen : previous.occupancy_gen + 1;
    if (author.occupancy_gen !== expected) {
      throw new Error(`occupancy trail: entry ${i} by ${author.vendor}/${author.model ?? "?"} has gen ${author.occupancy_gen}, expected ${expected}`);
    }
    if (previous && !same(previous, author)) reseats.push({ at: i, from: `${previous.vendor}/${previous.model ?? "?"}`, to: `${author.vendor}/${author.model ?? "?"}`, gen: expected });
    previous = author;
  }
  return { ok: true, entries: authors.length, generation: previous?.occupancy_gen ?? 0, reseats };
}
