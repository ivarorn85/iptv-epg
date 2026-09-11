// Reading a fixture out of a channel name. Getting the date order wrong here
// would publish every event on the wrong day without failing anything.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { EVENT_NAME } from "../events.mjs";

describe("EVENT_NAME", () => {
  it("reads day, month, time and fixture out of the name", () => {
    const match = EVENT_NAME.exec("[Livey] (9/9) 16:35 Aalborg Handbold - Paris Saint-Germain");
    assert.ok(match);
    const [, day, month, hour, minute, event] = match;
    assert.deepEqual([day, month, hour, minute], ["9", "9", "16", "35"]);
    assert.equal(event, "Aalborg Handbold - Paris Saint-Germain");
  });

  it("reads the date as day/month, not month/day", () => {
    // "(12/9)" is 12 September. Reversing this shifts every fixture by months.
    const [, day, month] = EVENT_NAME.exec("[Viaplay IS] (12/9) 13:55 Liverpool - Atlético Madrid");
    assert.equal(day, "12");
    assert.equal(month, "9");
  });

  it("keeps a fixture name containing digits and punctuation intact", () => {
    const [, , , , , event] = EVENT_NAME.exec("[Svensk] (1/10) 09:05 IFK Göteborg - AIK 2");
    assert.equal(event, "IFK Göteborg - AIK 2");
  });

  it("accepts any service in the brackets", () => {
    for (const name of [
      "[Livey] (9/9) 16:35 A - B",
      "[Viaplay IS] (9/9) 16:35 A - B",
      "[HBO Max UK] (9/9) 16:35 A - B",
      "[daznJP] (9/9) 16:35 A - B",
    ])
      assert.ok(EVENT_NAME.test(name), name);
  });

  it("ignores ordinary channels, which the other passes own", () => {
    for (const name of [
      "IS: Sýn Besta Deildin 1", // no fixture and no time: not reachable this way
      "UK: Sky Sport F1 UHD 4K B",
      "UK: Coral TV 2",
      "[Livey] Handball", // bracket but no date or time
      "[Livey] (9/9) Aalborg - PSG", // date but no time
      "(9/9) 16:35 A - B", // time but no service
    ])
      assert.ok(!EVENT_NAME.test(name), name);
  });

  it("requires something after the time", () => {
    assert.ok(!EVENT_NAME.test("[Livey] (9/9) 16:35 "));
  });

  it("is not sticky, so repeated tests on one instance agree", () => {
    // A /g flag here would make every other call fail as lastIndex advanced.
    const name = "[Livey] (9/9) 16:35 A - B";
    assert.equal(EVENT_NAME.test(name), EVENT_NAME.test(name));
    assert.ok(EVENT_NAME.exec(name));
    assert.ok(EVENT_NAME.exec(name));
  });
});
