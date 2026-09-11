// The XMLTV shapes. A mistake here produces a file a player reads wrongly
// rather than an error, so the cases that matter are escaping, element order,
// and which titles count as filler.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  attr,
  escapeAttr,
  isPlaceholder,
  parseTime,
  xmltvChannel,
  xmltvProgramme,
} from "../epg-xml.mjs";

describe("attr", () => {
  it("reads the attributes the build depends on", () => {
    const element = '<programme start="20260909163500 +0000" stop="20260909193500 +0000" channel="RUV.is">';
    assert.equal(attr(element, "channel"), "RUV.is");
    assert.equal(attr(element, "start"), "20260909163500 +0000");
    assert.equal(attr(element, "stop"), "20260909193500 +0000");
  });

  it("returns null rather than guessing when the attribute is absent", () => {
    assert.equal(attr("<channel><display-name>X</display-name></channel>", "id"), null);
  });

  it("does not confuse a longer attribute name for a shorter one", () => {
    // \b before the name: "channel=" must not satisfy a request for "el".
    assert.equal(attr('<programme channel="X">', "el"), null);
  });
});

describe("escapeAttr", () => {
  it("escapes what would otherwise break the document", () => {
    assert.equal(escapeAttr('A&E "quoted" <tag>'), "A&amp;E &quot;quoted&quot; &lt;tag>");
  });

  it("leaves alone what does not need escaping, including the closing bracket", () => {
    // ">" is deliberately not escaped: it is legal in XML text and in an
    // attribute value, and escaping it only made the output noisier.
    assert.equal(escapeAttr("Rock > Roll"), "Rock > Roll");
    assert.equal(escapeAttr("Bítið á Sýn"), "Bítið á Sýn");
  });
});

describe("isPlaceholder", () => {
  const titled = (title) => `<programme start="1" stop="2" channel="c"><title>${title}</title></programme>`;

  it("catches the filler that would otherwise claim a channel", () => {
    // iptv-epg.org fills channels it has no schedule for with these, which is
    // worse than an empty channel: the id is taken and nothing else can serve it.
    for (const title of ["No Data", "no data", "No EVENT Today", "Dagskrárlok", "TBA", "n/a", "-"])
      assert.ok(isPlaceholder(titled(title)), title);
  });

  it("leaves real programmes alone, including ones that read like filler", () => {
    // Every one of these contains a filler token as a substring, which is the
    // only thing that makes the anchors load-bearing. Measured on the last
    // complete published guide: with both anchors gone, 1,396 titles and 4,429
    // programmes are discarded as filler, and 418 channels lose their entire
    // schedule — the hyphen token alone eats every Icelandic sports fixture.
    // Titles taken from that guide rather than invented.
    for (const title of [
      "Bandaríkin - Ungverjaland",
      "Kína - Frakkland",
      "Stundin okkar-Tökum á loft III",
      "The Help",
      "Help! My House Is Haunted",
      "No Reservations",
      "Data Detectives",
      "No Data Left Behind",
      "TBA Chronicles",
    ])
      assert.ok(!isPlaceholder(titled(title)), title);
  });

  it("treats a programme with no title as filler, because XMLTV requires one", () => {
    // This used to assert the opposite, on the guess that a missing title was
    // better kept than dropped. Then a published run turned out to carry seven
    // of them — two AFN channels emit `<title lang="en"/>` — and in a grid an
    // untitled programme is worse than an absent one: it holds a slot and shows
    // nothing. XMLTV makes `title` a required child, so this is the spec's
    // reading too, not a heuristic.
    assert.ok(isPlaceholder('<programme start="1" stop="2" channel="c"></programme>'));
    assert.ok(isPlaceholder('<programme start="1" stop="2" channel="c"><title lang="en"/></programme>'));
    assert.ok(isPlaceholder('<programme start="1" stop="2" channel="c"><title>   </title></programme>'));
  });
});

describe("xmltvChannel", () => {
  it("emits every display-name given, skipping blanks", () => {
    const element = xmltvChannel("RUV.is", ["RÚV", "ruv", null, ""]);
    assert.match(element, /^<channel id="RUV\.is">/);
    assert.equal((element.match(/<display-name>/g) ?? []).length, 2);
    assert.match(element, /<\/channel>$/);
  });

  it("escapes the id and the names", () => {
    assert.match(xmltvChannel('a"b', ["A&E"]), /id="a&quot;b"/);
    assert.match(xmltvChannel("x", ["A&E"]), /<display-name>A&amp;E<\/display-name>/);
  });
});

describe("xmltvProgramme", () => {
  const start = new Date("2026-09-09T16:35:00Z");
  const stop = new Date("2026-09-09T19:15:00Z");

  it("writes the timestamps in XMLTV's format, in UTC", () => {
    const element = xmltvProgramme({ channel: "c", start, stop, title: "T" });
    assert.match(element, /start="20260909163500 \+0000"/);
    assert.match(element, /stop="20260909191500 \+0000"/);
  });

  it("orders the children the way the DTD wants: title, desc, category", () => {
    const element = xmltvProgramme({
      channel: "c",
      start,
      stop,
      title: "Match",
      desc: "A description",
      categories: ["Football", "Sport"],
    });
    assert.ok(element.indexOf("<title") < element.indexOf("<desc"), "title before desc");
    assert.ok(element.indexOf("<desc") < element.indexOf("<category"), "desc before category");
    assert.equal((element.match(/<category/g) ?? []).length, 2);
  });

  it("omits desc and categories when there are none", () => {
    const element = xmltvProgramme({ channel: "c", start, stop, title: "T", categories: ["", null] });
    assert.ok(!element.includes("<desc"));
    assert.ok(!element.includes("<category"));
  });

  it("applies the language only when asked", () => {
    assert.match(xmltvProgramme({ channel: "c", start, stop, title: "T", lang: "is" }), /<title lang="is">/);
    assert.match(xmltvProgramme({ channel: "c", start, stop, title: "T" }), /<title>/);
  });
});

describe("parseTime", () => {
  it("reads a stamp the way the gate and the cache both need", () => {
    assert.equal(parseTime("20260909095000 +0000"), Date.parse("2026-09-09T09:50:00Z"));
  });

  it("honours the offset instead of assuming everything is UTC", () => {
    // Not every upstream publishes in UTC. Ignoring the offset would misdate a
    // whole source by hours, which decides how far ahead the gate thinks the
    // schedule runs and which cached programmes count as already broadcast.
    assert.equal(parseTime("20260909120000 +0200"), parseTime("20260909100000 +0000"));
    assert.equal(parseTime("20260909050000 -0500"), parseTime("20260909100000 +0000"));
  });

  it("defaults to UTC when no offset is given, as XMLTV allows", () => {
    assert.equal(parseTime("20260909100000"), parseTime("20260909100000 +0000"));
  });

  it("returns NaN for anything it cannot read, rather than a wrong instant", () => {
    for (const stamp of ["", "tomorrow", "202609091000", "2026-09-09T10:00:00Z"])
      assert.ok(Number.isNaN(parseTime(stamp)), stamp);
  });
});
