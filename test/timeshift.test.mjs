// The one producer that invents programmes from other programmes. A mistake
// here publishes a full day at the wrong time on a channel that looks filled,
// so the cases below are the arithmetic, which names count as a timeshift, and
// what happens to a stamp that will not shift.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attr } from "../epg-xml.mjs";
import { anHourLater, timeshiftGuide } from "../timeshift.mjs";

describe("anHourLater", () => {
  it("advances the hour", () => {
    assert.equal(anHourLater("20260909163500 +0000"), "20260909173500 +0000");
  });

  it("rolls over midnight, the month and the year", () => {
    assert.equal(anHourLater("20260930233000 +0000"), "20261001003000 +0000");
    assert.equal(anHourLater("20261231235959 +0000"), "20270101005959 +0000");
  });

  it("keeps the offset it was given rather than normalising it", () => {
    // The result is the same instant either way; leaving the offset alone
    // keeps the stamp looking like its neighbours in the file.
    assert.equal(anHourLater("20260909163500 -0500"), "20260909173500 -0500");
    assert.equal(anHourLater("20260909163500 +0200"), "20260909173500 +0200");
  });

  it("refuses a stamp it cannot read, rather than returning it unshifted", () => {
    // XMLTV allows truncated stamps and a dozen third-party files are read
    // here. Passing one through unchanged would publish the base channel's own
    // times on the +1 channel — silently, and a whole day of them.
    for (const stamp of ["202609091635 +0000", "", "tomorrow", "2026-09-09T16:35:00Z"])
      assert.equal(anHourLater(stamp), null, stamp);
  });
});

describe("timeshiftGuide", () => {
  const programme = (channel, start, stop) =>
    `<programme start="${start}" stop="${stop}" channel="${channel}"><title>T</title></programme>`;

  const base = { name: "UK: FILM 4 HD", epg_channel_id: "Film4 HD.uk" };
  const plusOne = { name: "UK: FILM 4  1", epg_channel_id: "" };

  const withSchedule = (id, ...programmes) => new Map([[id, programmes]]);

  it("shifts the base channel's schedule by exactly an hour, duration intact", () => {
    const { channels, programmes } = timeshiftGuide(
      [base, plusOne],
      withSchedule(
        "Film4 HD.uk",
        programme("Film4 HD.uk", "20260909200000 +0000", "20260909214500 +0000")
      )
    );

    assert.equal(channels.length, 1);
    assert.match(channels[0].element, /<display-name>UK: FILM 4  1<\/display-name>/);
    assert.equal(programmes.length, 1);
    assert.equal(attr(programmes[0].element, "start"), "20260909210000 +0000");
    assert.equal(attr(programmes[0].element, "stop"), "20260909224500 +0000");
    assert.equal(attr(programmes[0].element, "channel"), channels[0].id);
    assert.equal(programmes[0].channel, channels[0].id);
  });

  it("drops a programme whose stamps will not shift, and counts it", () => {
    // Half a shift would emit a programme ending before it starts, which is
    // the one thing the guide must never contain.
    const { programmes, unshiftable } = timeshiftGuide(
      [base, plusOne],
      withSchedule(
        "Film4 HD.uk",
        programme("Film4 HD.uk", "202609092000 +0000", "20260909214500 +0000"),
        programme("Film4 HD.uk", "20260909220000 +0000", "20260909234500 +0000")
      )
    );
    assert.equal(programmes.length, 1);
    assert.equal(unshiftable, 1);
  });

  it("knows a timeshift from a channel number", () => {
    // Two spaces then 1 is the timeshift. One space then a digit is a
    // different channel, and getting this wrong copies GOLD's schedule onto
    // Coral TV 2.
    const rows = [
      { name: "UK: Coral TV", epg_channel_id: "Coral.uk" },
      { name: "UK: Coral TV 2", epg_channel_id: "" },
      { name: "UK: Coral TV  1 HD", epg_channel_id: "" },
    ];
    const { channels } = timeshiftGuide(
      rows,
      withSchedule("Coral.uk", programme("Coral.uk", "20260909200000 +0000", "20260909210000 +0000"))
    );
    assert.deepEqual(channels, []);
  });

  it("leaves alone a +1 row that already has a schedule of its own", () => {
    const own = { name: "UK: FILM 4  1", epg_channel_id: "Film4plus1.uk" };
    const { channels } = timeshiftGuide(
      [base, own],
      new Map([
        ["Film4 HD.uk", [programme("Film4 HD.uk", "20260909200000 +0000", "20260909210000 +0000")]],
        ["Film4plus1.uk", [programme("Film4plus1.uk", "20260909210000 +0000", "20260909220000 +0000")]],
      ])
    );
    assert.deepEqual(channels, []);
  });

  it("emits nothing when the base channel has no schedule to copy", () => {
    assert.deepEqual(timeshiftGuide([base, plusOne], new Map()).channels, []);
  });

  it("emits one channel when two rows normalise to the same id", () => {
    // Otherwise the second row's programmes land on the first row's channel
    // and every programme is listed twice.
    const { channels, programmes } = timeshiftGuide(
      [base, plusOne, { name: "UK: FILM 4  1", epg_channel_id: "" }],
      withSchedule(
        "Film4 HD.uk",
        programme("Film4 HD.uk", "20260909200000 +0000", "20260909210000 +0000")
      )
    );
    assert.equal(channels.length, 1);
    assert.equal(programmes.length, 1);
  });

  it("does not cross countries to find a base channel", () => {
    // A US Film 4 must never feed a UK Film 4 +1.
    const { channels } = timeshiftGuide(
      [{ name: "US: FILM 4 HD", epg_channel_id: "Film4.us" }, plusOne],
      withSchedule("Film4.us", programme("Film4.us", "20260909200000 +0000", "20260909210000 +0000"))
    );
    assert.deepEqual(channels, []);
  });
});
