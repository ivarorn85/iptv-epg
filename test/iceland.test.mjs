// The two Icelandic broadcasters' arithmetic. Neither API gives a usable end
// time — syn.is gives none at all and ruv.is gives a wall clock with no date —
// so every stop in an Icelandic schedule is worked out here rather than read.
// Get it wrong and the channel shows the right programmes at the wrong times,
// which nothing downstream can detect: the guide is well-formed either way.
//
// A review found four ways to break this that the suite did not notice, so
// these are the cases that pin them.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attr, titleOf } from "../epg-xml.mjs";
import { ruvProgrammes, ruvSpan, synStation, withoutStrands } from "../iceland.mjs";

describe("synStation", () => {
  const event = (upphaf, titill, extra = {}) => ({
    upphaf,
    isltitill: titill,
    midill: "synsport",
    midill_heiti: "Sýn Sport",
    ...extra,
  });

  const stops = (produced) => produced.programmes.map((element) => attr(element, "stop"));
  const starts = (produced) => produced.programmes.map((element) => attr(element, "start"));

  it("names the channel by its id and by both names it goes by", () => {
    // The station code reaches provider rows like "IS: SYN+ HD" that carry no
    // id and whose accent-free name only the code matches.
    const produced = synStation("synsport", [event("2026-09-11T20:00:00Z", "Leikur")]);
    assert.match(produced.channel, /^<channel id="synsport\.is">/);
    assert.match(produced.channel, /<display-name>Sýn Sport<\/display-name>/);
    assert.match(produced.channel, /<display-name>synsport<\/display-name>/);
  });

  it("closes a programme with the next one's start", () => {
    const produced = synStation("synsport", [
      event("2026-09-11T20:00:00Z", "First"),
      event("2026-09-11T21:30:00Z", "Second"),
    ]);
    assert.equal(stops(produced)[0], "20260911213000 +0000");
  });

  it("does not stretch a programme across a gap in the schedule", () => {
    // The next start is six hours away, so it cannot be this programme's end.
    // Without the cap the channel shows one programme all evening.
    const produced = synStation("synsport", [
      event("2026-09-11T14:00:00Z", "Afternoon"),
      event("2026-09-11T20:00:00Z", "Evening"),
    ]);
    assert.equal(stops(produced)[0], "20260911170000 +0000", "capped at the assumed three hours");
  });

  it("gives the last programme of the day the assumed length", () => {
    const produced = synStation("synsport", [event("2026-09-11T22:30:00Z", "Last")]);
    assert.equal(stops(produced)[0], "20260912013000 +0000");
  });

  it("skips a station whose events span more than one channel", () => {
    // "beint" ("live") is not a channel: it pools every channel's live events.
    // Treated as one it takes another channel's name, claims that provider row,
    // and closes each event with a fixture starting on a different channel.
    const pooled = [
      event("2026-09-11T20:00:00Z", "Sýn match", { midill: "synsport" }),
      event("2026-09-11T20:00:00Z", "RÚV match", { midill: "synsport2" }),
    ];
    assert.equal(synStation("beint", pooled), null);
  });

  it("keeps a station whose events are all one channel", () => {
    assert.ok(synStation("synsport", [event("2026-09-11T20:00:00Z", "Only one")]));
  });

  it("orders the day however the API answered", () => {
    // The stop of each programme is the start of the next, so an unsorted feed
    // would close programmes with times already past.
    const produced = synStation("synsport", [
      event("2026-09-11T21:30:00Z", "Second"),
      event("2026-09-11T20:00:00Z", "First"),
    ]);
    assert.deepEqual(starts(produced), ["20260911200000 +0000", "20260911213000 +0000"]);
    assert.equal(stops(produced)[0], "20260911213000 +0000");
  });

  it("emits one programme when the feed lists the same minute twice", () => {
    // Otherwise the pair produces a zero-length entry and an overlap.
    const produced = synStation("synsport", [
      event("2026-09-11T20:00:00Z", "Once"),
      event("2026-09-11T20:00:00Z", "Twice"),
      event("2026-09-11T21:00:00Z", "Later"),
    ]);
    assert.equal(produced.programmes.length, 2);
    assert.notEqual(stops(produced)[0], starts(produced)[0]);
  });

  it("takes the Icelandic title, falling back to the original", () => {
    const produced = synStation("synsport", [
      { ...event("2026-09-11T20:00:00Z", null), titill: "Original Only" },
    ]);
    assert.equal(titleOf(produced.programmes[0]), "Original Only");
  });

  it("ignores a row with no start or no title, and the station with nothing left", () => {
    assert.equal(synStation("synsport", [{ midill: "x", isltitill: "No start" }]), null);
    assert.equal(synStation("synsport", [{ upphaf: "2026-09-11T20:00:00Z", midill: "x" }]), null);
    assert.equal(synStation("synsport", []), null);
  });

  it("drops a start it cannot read rather than emitting an invalid programme", () => {
    const produced = synStation("synsport", [
      event("not a date", "Broken"),
      event("2026-09-11T20:00:00Z", "Fine"),
    ]);
    assert.equal(produced.programmes.length, 1);
    assert.equal(titleOf(produced.programmes[0]), "Fine");
  });
});

describe("ruvSpan", () => {
  const event = (start, end, extra = {}) => ({
    title: "Fréttir",
    start_time: start,
    end_time_friendly: end,
    ...extra,
  });

  const iso = (date) => date.toISOString();

  it("dates the end from the day the programme starts", () => {
    const span = ruvSpan(event("2026-09-11 19:00:00", "19:40"));
    assert.equal(iso(span.start), "2026-09-11T19:00:00.000Z");
    assert.equal(iso(span.stop), "2026-09-11T19:40:00.000Z");
  });

  it("rolls a programme that runs past midnight into the next day", () => {
    // The end is a wall clock with no date. Read literally, 23:50 -> 00:35 ends
    // before it starts, and the programme is dropped as invalid — so a late
    // film silently disappears from the guide every night.
    const span = ruvSpan(event("2026-09-11 23:50:00", "00:35"));
    assert.equal(iso(span.start), "2026-09-11T23:50:00.000Z");
    assert.equal(iso(span.stop), "2026-09-12T00:35:00.000Z");
  });

  it("dates the end from the start, not from the day that was requested", () => {
    // A day's response carries that night's post-midnight tail, so an event
    // that starts after midnight belongs to the following date. Dating it from
    // the requested day would put it 24 hours out.
    const span = ruvSpan(event("2026-09-12 00:20:00", "01:05"));
    assert.equal(iso(span.start), "2026-09-12T00:20:00.000Z");
    assert.equal(iso(span.stop), "2026-09-12T01:05:00.000Z");
  });

  it("dates the end from the start for a day far from today", () => {
    // The walk goes ten days ahead, so most events are not today's. Dating the
    // end from the current date instead of the event's own would leave the stop
    // before the start on every one of them, and the guard below would then
    // throw the whole programme away — silently, nine days out of ten. The
    // midnight roll hides this for anything dated today, which is why the case
    // has to be a week out.
    const span = ruvSpan(event("2026-09-18 19:00:00", "19:40"));
    assert.ok(span, "an event a week ahead must still produce a span");
    assert.equal(iso(span.start), "2026-09-18T19:00:00.000Z");
    assert.equal(iso(span.stop), "2026-09-18T19:40:00.000Z");
  });

  it("drops a zero-length marker rather than emitting an empty span", () => {
    // "Dagskrárlok" — end of broadcasting — is published as a programme that
    // ends when it starts, which is invalid XMLTV.
    assert.equal(ruvSpan(event("2026-09-11 23:30:00", "23:30", { title: "Dagskrárlok" })), null);
  });

  it("falls back to the original title, and refuses a row with neither", () => {
    assert.equal(ruvSpan(event("2026-09-11 19:00:00", "19:40", { title: null, original_title: "Fawlty Towers" })).title, "Fawlty Towers");
    assert.equal(ruvSpan(event("2026-09-11 19:00:00", "19:40", { title: null, original_title: null })), null);
  });

  it("refuses a row missing either time", () => {
    assert.equal(ruvSpan(event(null, "19:40")), null);
    assert.equal(ruvSpan(event("2026-09-11 19:00:00", null)), null);
    assert.equal(ruvSpan(undefined), null);
  });

  it("refuses a time it cannot read instead of letting it reach the formatter", () => {
    // Every comparison against an invalid date is false, so it has to be
    // tested for directly or it throws on the way out.
    assert.equal(ruvSpan(event("whenever", "19:40")), null);
    assert.equal(ruvSpan(event("2026-09-11 19:00:00", "nonsense")), null);
  });

  it("carries the description through when there is one", () => {
    assert.equal(ruvSpan(event("2026-09-11 19:00:00", "19:40", { description: "Kvöldfréttir" })).desc, "Kvöldfréttir");
  });
});

describe("withoutStrands", () => {
  // RÚV lists a strand and the items inside it as siblings — "KrakkaRÚV"
  // 17:30-18:20 alongside the six cartoons that make it up. XMLTV has no
  // nesting, so a player shows one arbitrary programme across the whole span.
  // Filtering the wrappers took one channel from 93 overlapping programmes to 2.
  const span = (from, to, title) => ({ start: from * 60_000, stop: to * 60_000, title });
  const titles = (list) => withoutStrands(list).map((entry) => entry.title);

  it("drops a strand that contains the entry after it", () => {
    assert.deepEqual(
      titles([span(0, 240, "Morgunið"), span(0, 30, "Frettir"), span(30, 240, "Bitið")]),
      ["Frettir", "Bitið"]
    );
  });

  it("keeps programmes that merely run back to back", () => {
    assert.deepEqual(titles([span(0, 30, "A"), span(30, 60, "B"), span(60, 90, "C")]), ["A", "B", "C"]);
  });

  it("keeps the last entry, which contains nothing after it", () => {
    assert.deepEqual(titles([span(0, 30, "A"), span(30, 60, "Last")]), ["A", "Last"]);
  });

  it("keeps an overlap that runs past the entry it overlaps", () => {
    // Only a containing span is a strand. Two programmes that merely overlap
    // are an upstream mistake, not a wrapper, and dropping one loses a real
    // programme.
    assert.deepEqual(titles([span(0, 60, "A"), span(30, 90, "B")]), ["A", "B"]);
  });

  it("does not depend on the order the API happened to answer in", () => {
    const scrambled = [span(30, 240, "Bitið"), span(0, 240, "Morgunið"), span(0, 30, "Frettir")];
    assert.deepEqual(titles(scrambled), ["Frettir", "Bitið"]);
  });

  it("leaves the caller's array alone", () => {
    const given = [span(30, 60, "B"), span(0, 30, "A")];
    withoutStrands(given);
    assert.deepEqual(given.map((entry) => entry.title), ["B", "A"]);
  });

  it("handles an empty schedule", () => {
    assert.deepEqual(withoutStrands([]), []);
  });

  it("is actually applied when a channel's programmes are built", () => {
    // Testing the filter alone cannot tell whether anything calls it — and
    // removing the call is exactly the mutation that survived the first time.
    // Real dates here, because this one reaches the XMLTV formatter.
    const dated = (from, to, title) => ({
      start: new Date(Date.UTC(2026, 8, 11, 17, from)),
      stop: new Date(Date.UTC(2026, 8, 11, 17, to)),
      title,
    });
    const programmes = ruvProgrammes("ruv.is", [
      dated(0, 50, "KrakkaRÚV"),
      dated(0, 10, "Skoppa"),
      dated(10, 50, "Hrúturinn Hreinn"),
    ]);
    assert.deepEqual(programmes.map(titleOf), ["Skoppa", "Hrúturinn Hreinn"]);
    assert.equal(attr(programmes[0], "channel"), "ruv.is");
  });
});
