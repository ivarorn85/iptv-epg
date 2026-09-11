// RÚV publishes a strand and the programmes inside it as siblings — "Morgunið"
// from 06:00 to 10:00, then each item within it — so taken literally the
// channel shows four overlapping things at once. Filtering the strands out took
// one channel from 93 overlapping programmes to 2.
//
// This is pure arithmetic on data the API returns, and getting it wrong shifts
// an Icelandic schedule silently, which the README calls the worst failure mode
// in the project. It had no test until a review pointed out that removing the
// filter entirely left the suite green.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { withoutStrands } from "../iceland.mjs";

// Minutes past an arbitrary hour, which is all the comparisons care about.
const span = (from, to, title) => ({ start: from * 60_000, stop: to * 60_000, title });
const titles = (list) => withoutStrands(list).map((entry) => entry.title);

describe("withoutStrands", () => {
  it("drops a strand that contains the entry after it", () => {
    assert.deepEqual(
      titles([span(0, 240, "Morgunið"), span(0, 30, "Frettir"), span(30, 240, "Bitið")]),
      ["Frettir", "Bitið"]
    );
  });

  it("keeps programmes that merely run back to back", () => {
    // The ordinary case, and by far the common one: nothing here contains
    // anything, so nothing may be dropped.
    assert.deepEqual(
      titles([span(0, 30, "A"), span(30, 60, "B"), span(60, 90, "C")]),
      ["A", "B", "C"]
    );
  });

  it("keeps the last entry, which contains nothing after it", () => {
    assert.deepEqual(titles([span(0, 30, "A"), span(30, 60, "Last")]), ["A", "Last"]);
  });

  it("keeps an overlap that runs past the entry it overlaps", () => {
    // Only a containing span is a strand. Two programmes that merely overlap
    // are an upstream mistake, not a wrapper, and dropping one would lose a
    // real programme.
    assert.deepEqual(titles([span(0, 60, "A"), span(30, 90, "B")]), ["A", "B"]);
  });

  it("does not depend on the order the API happened to answer in", () => {
    // It compares each entry with the one after it, so an unsorted list would
    // silently keep the strand and drop nothing — or drop the wrong thing.
    const scrambled = [span(30, 240, "Bitið"), span(0, 240, "Morgunið"), span(0, 30, "Frettir")];
    assert.deepEqual(titles(scrambled), ["Frettir", "Bitið"]);
  });

  it("leaves the caller's array alone", () => {
    const given = [span(30, 60, "B"), span(0, 30, "A")];
    withoutStrands(given);
    assert.deepEqual(
      given.map((entry) => entry.title),
      ["B", "A"]
    );
  });

  it("handles an empty schedule", () => {
    assert.deepEqual(withoutStrands([]), []);
  });
});
