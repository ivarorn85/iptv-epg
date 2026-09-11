// The event pass itself, not just the name pattern it starts from. This is the
// largest producer in the guide — several hundred channels — and everything it
// emits is invented from a channel name, so there is no upstream to compare
// against and nothing to notice a mistake. Both things tested hardest here
// have gone wrong in practice: the date reading, and the same fixture being
// emitted twice.
//
// No network: eventGuide takes the Viaplay end times as an argument.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attr } from "../epg-xml.mjs";
import { eventGuide } from "../events.mjs";

const DAY_MS = 86_400_000;
const noEnds = new Map();

// Fixtures are named with a day and month but no year, so a test written with
// fixed dates would start failing on its own. These are built relative to now.
const named = (at, fixture = "Aalborg Handbold - Paris Saint-Germain") => {
  const when = new Date(at);
  const day = when.getUTCDate();
  const month = when.getUTCMonth() + 1;
  const hour = String(when.getUTCHours()).padStart(2, "0");
  const minute = String(when.getUTCMinutes()).padStart(2, "0");
  return { name: `[Livey] (${day}/${month}) ${hour}:${minute} ${fixture}`, epg_channel_id: "" };
};

const soon = () => Date.now() + 2 * DAY_MS;

describe("eventGuide", () => {
  it("emits one channel and one programme per fixture, found by name", async () => {
    const row = named(soon());
    const { channels, programmes } = await eventGuide([row], noEnds);

    assert.equal(channels.length, 1);
    assert.equal(programmes.length, 1);
    assert.match(channels[0].element, /<display-name>\[Livey\] /);
    assert.equal(programmes[0].channel, channels[0].id);
    assert.equal(attr(programmes[0].element, "channel"), channels[0].id);
  });

  it("puts the programme on the day the name says, reading it as day/month", async () => {
    // The whole pass hangs on this. Reading "(12/9)" as 9 December instead of
    // 12 September moves every fixture by months, and nothing downstream can
    // tell: the guide is well-formed either way.
    const at = new Date(soon());
    at.setUTCHours(16, 35, 0, 0);
    const { programmes } = await eventGuide([named(at.getTime())], noEnds);

    const start = attr(programmes[0].element, "start");
    const expected = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}${String(
      at.getUTCDate()
    ).padStart(2, "0")}1635`;
    assert.equal(start.slice(0, 12), expected, `start was ${start}`);
  });

  it("gives a fixture the assumed three hours when Viaplay has no end for it", async () => {
    const { programmes } = await eventGuide([named(soon())], noEnds);
    const element = programmes[0].element;
    const hours =
      (Date.parse(xmltv(attr(element, "stop"))) - Date.parse(xmltv(attr(element, "start")))) /
      3_600_000;
    assert.equal(hours, 3);
  });

  it("borrows a real end time when Viaplay has one, and counts it", async () => {
    const at = new Date(soon());
    at.setUTCSeconds(0, 0);
    const row = named(at.getTime(), "Liverpool - Atletico Madrid");
    // Keyed the way events.mjs keys it: normalised title, then the start
    // truncated to the minute.
    const key = `liverpoolatleticomadrid|${at.toISOString().slice(0, 16)}`;
    const realEnd = new Date(at.getTime() + 330 * 60_000);

    const { programmes, borrowed } = await eventGuide([row], new Map([[key, realEnd]]));
    assert.equal(borrowed, 1);
    assert.equal(attr(programmes[0].element, "stop").slice(0, 12), stamp(realEnd).slice(0, 12));
  });

  it("emits a repeated fixture once, not twice", async () => {
    // The playlist does repeat rows verbatim. When this deduplication was
    // removed during a refactor, 22 channels published the same programme
    // twice: the second row emitted no channel but still emitted a programme.
    const row = named(soon());
    const { channels, programmes } = await eventGuide([row, { ...row }], noEnds);
    assert.equal(channels.length, 1);
    assert.equal(programmes.length, 1);
  });

  it("ignores a row that already has an id, which a real source can serve", async () => {
    const row = { ...named(soon()), epg_channel_id: "SomeChannel.uk" };
    assert.deepEqual((await eventGuide([row], noEnds)).channels, []);
  });

  it("drops a fixture that has already finished", async () => {
    // The playlist does not clear these out, so without this the guide fills
    // with last week's matches.
    const row = named(Date.now() - 2 * DAY_MS);
    assert.deepEqual((await eventGuide([row], noEnds)).channels, []);
  });

  it("drops a fixture the year guess put implausibly far ahead", async () => {
    const row = named(Date.now() + 120 * DAY_MS);
    assert.deepEqual((await eventGuide([row], noEnds)).channels, []);
  });

  it("ignores an ordinary channel name", async () => {
    const rows = [
      { name: "UK: Sky Sport F1 UHD 4K B", epg_channel_id: "" },
      { name: "IS: Sýn Besta Deildin 1", epg_channel_id: "" },
    ];
    assert.deepEqual((await eventGuide(rows, noEnds)).channels, []);
  });
});

// "20260909163500 +0000" -> something Date.parse understands
const xmltv = (value) =>
  value.replace(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})$/,
    "$1-$2-$3T$4:$5:$6$7:$8"
  );

const stamp = (date) => date.toISOString().replace(/\D/g, "").slice(0, 14);
