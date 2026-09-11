// The only source here that reads a web page rather than an API, and therefore
// the one most likely to break when the far end is redeployed. These tests say
// what shape it expects to find, so the day it changes the failure names the
// reason instead of the source silently going quiet.
//
// The fixture is the real payload's shape, trimmed: JS-escaped JSON embedded in
// HTML, channels keyed by a numeric channelApiId that programmes refer to as
// channelUuid, and times as Icelandic wall clock with no offset.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { attr, titleOf } from "../epg-xml.mjs";
import { balanced, scheduleFrom } from "../siminn.mjs";

// Builds a page the way Síminn serves one: the JSON is escaped, because it
// arrives inside a JavaScript string literal.
const page = ({ channels, epg }) => {
  const json = JSON.stringify({ channels, additionalData: { block: { epg } } });
  return `<!doctype html><body><script>self.__next_f.push([1,${JSON.stringify(json)}])</script></body>`;
};

const station = (channelApiId, channelName) => ({ _type: "channel", channelApiId, channelName });
const event = (channelUuid, since, till, title, extra = {}) => ({
  channelUuid,
  since,
  till,
  title,
  ...extra,
});

describe("balanced", () => {
  it("returns the whole array, brackets included", () => {
    assert.equal(balanced('x:[1,[2,3],4]y', 2), "[1,[2,3],4]");
  });

  it("ignores brackets inside a string", () => {
    // Titles contain brackets. Counting them would end the scan early and the
    // JSON.parse that follows would fail on a truncated fragment.
    assert.equal(balanced('[{"title":"Match ] [ Day"}]', 0), '[{"title":"Match ] [ Day"}]');
  });

  it("ignores a quote that is escaped", () => {
    assert.equal(balanced('[{"title":"a \\" ] b"}]', 0), '[{"title":"a \\" ] b"}]');
  });

  it("returns nothing when the value never closes", () => {
    assert.equal(balanced('[1,2,3', 0), null);
  });
});

describe("scheduleFrom", () => {
  const html = page({
    channels: [station(1001, "Omega"), station(1002, "Arte ÞÝSK")],
    epg: [
      event(1001, "2026-09-11T20:00", "2026-09-11T21:30", "Kvöldvaka", {
        description: "Um trú og mannlíf",
        episode: "3",
      }),
      event(1002, "2026-09-11T21:00", "2026-09-11T22:00", "Themenabend"),
    ],
  });

  it("reads the channels and names them in my provider's vocabulary", () => {
    // "Omega.is" is the provider's own id for that row, so an exact match is
    // possible; the ".is" suffix is also what scopes the name to Iceland.
    const xml = scheduleFrom(html);
    assert.match(xml, /<channel id="omega\.is">/);
    assert.match(xml, /<channel id="arteþýsk\.is">/);
    assert.match(xml, /<display-name>Omega<\/display-name>/);
  });

  it("reads the times as Icelandic wall clock, which is UTC", () => {
    const programme = scheduleFrom(html).match(/<programme[^>]*channel="omega\.is"[^>]*>/)[0];
    assert.equal(attr(programme, "start"), "20260911200000 +0000");
    assert.equal(attr(programme, "stop"), "20260911213000 +0000");
  });

  it("puts each programme on the channel its channelUuid names", () => {
    const xml = scheduleFrom(html);
    const forChannel = (id) =>
      [...xml.matchAll(/<programme\b[^>]*?>[\s\S]*?<\/programme>/g)]
        .filter((match) => attr(match[0], "channel") === id)
        .map((match) => titleOf(match[0]));
    assert.deepEqual(forChannel("omega.is"), ["Kvöldvaka"]);
    assert.deepEqual(forChannel("arteþýsk.is"), ["Themenabend"]);
  });

  it("carries the episode number and description through", () => {
    assert.match(scheduleFrom(html), /<desc lang="is">3\. Um trú og mannlíf<\/desc>/);
  });

  it("treats React's $undefined as absent rather than printing it", () => {
    // The payload carries the literal string "$undefined" where a value was
    // not serialised. Printed, it would appear as a programme description.
    const xml = scheduleFrom(
      page({
        channels: [station(1001, "Omega")],
        epg: [
          event(1001, "2026-09-11T20:00", "2026-09-11T21:00", "Something", {
            description: "$undefined",
            episode: "$undefined",
          }),
        ],
      })
    );
    assert.ok(!xml.includes("$undefined"), "must not reach the guide");
    assert.ok(!xml.includes("<desc"), "no description at all rather than an empty one");
  });

  it("emits one programme when the page lists a slot twice", () => {
    const xml = scheduleFrom(
      page({
        channels: [station(1001, "Omega")],
        epg: [
          event(1001, "2026-09-11T20:00", "2026-09-11T21:00", "Once"),
          event(1001, "2026-09-11T20:00", "2026-09-11T21:00", "Again"),
        ],
      })
    );
    assert.equal([...xml.matchAll(/<programme /g)].length, 1);
  });

  it("ignores a programme whose channel is not in the channel list", () => {
    const xml = scheduleFrom(
      page({
        channels: [station(1001, "Omega")],
        epg: [
          event(9999, "2026-09-11T20:00", "2026-09-11T21:00", "Orphan"),
          event(1001, "2026-09-11T20:00", "2026-09-11T21:00", "Kept"),
        ],
      })
    );
    assert.ok(!xml.includes("Orphan"));
    assert.ok(xml.includes("Kept"));
  });

  it("gives an hour to a pair of stamps that disagree", () => {
    const xml = scheduleFrom(
      page({
        channels: [station(1001, "Omega")],
        epg: [event(1001, "2026-09-11T20:00", "2026-09-11T19:00", "Backwards")],
      })
    );
    const programme = xml.match(/<programme[^>]*>/)[0];
    assert.equal(attr(programme, "start"), "20260911200000 +0000");
    assert.equal(attr(programme, "stop"), "20260911210000 +0000");
  });

  it("reads the times as UTC whatever timezone the build runs in", () => {
    // The stamps carry no offset, so "2026-09-11T20:00" read as local time
    // would be right on a UTC machine and hours wrong anywhere else. CI runs
    // in UTC and Iceland keeps UTC, which is exactly why this cannot be
    // asserted in-process: it has to be checked under a timezone that differs.
    const script =
      'import { scheduleFrom } from "./siminn.mjs";' +
      `const xml = scheduleFrom(${JSON.stringify(html)});` +
      'process.stdout.write(/start="([^"]*)"/.exec(xml)[1]);';
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "20260911200000 +0000");
  });

  it("throws rather than returning an empty guide when the page changes shape", () => {
    // The failure has to be loud: this source going quiet would otherwise look
    // exactly like Síminn dropping every channel, and the cache would be asked
    // to cover a problem that is ours.
    assert.throws(() => scheduleFrom("<html>a page with no payload at all</html>"), /read 0 channels/);
    assert.throws(
      () => scheduleFrom(page({ channels: [station(1001, "Omega")], epg: [] })),
      /read 1 channels and 0 programmes/
    );
    assert.throws(
      () =>
        scheduleFrom(
          page({
            channels: [station(1001, "Omega")],
            epg: [event(1001, "not a time", "nor this", "Unreadable")],
          })
        ),
      /no programmes survived/
    );
  });
});
