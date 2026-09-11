// The XMLTV shapes. A mistake here produces a file a player reads wrongly
// rather than an error, so the cases that matter are escaping, element order,
// and which titles count as filler.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attr, escapeAttr, isPlaceholder, xmltvChannel, xmltvProgramme } from "../epg-xml.mjs";

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

  it("is safe to apply to element text as well as attributes", () => {
    assert.equal(escapeAttr("Rock & Roll"), "Rock &amp; Roll");
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
    // These are real titles that a substring match would have eaten.
    for (const title of ["The Help", "Help! My House Is Haunted", "No Reservations", "Data Detectives"])
      assert.ok(!isPlaceholder(titled(title)), title);
  });

  it("treats a programme with no title as real, not filler", () => {
    assert.ok(!isPlaceholder('<programme start="1" stop="2" channel="c"></programme>'));
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
