// The five passes. Until match.mjs was split out of build-epg.mjs none of this
// could be tested at all — build-epg runs the whole build on import — so the
// code where "one channel's schedule on another" is decided was the only part
// of the project with no test behind it.
//
// Everything here is about precedence and scope: which pass wins, what a pass
// is allowed to reach, and what must never be claimed.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attr } from "../epg-xml.mjs";
import { buildIndex, convert } from "../match.mjs";

// A source guide, written the way the real ones are.
const guide = (...entries) => {
  const channels = entries
    .map(([id, names]) => `<channel id="${id}">${names.map((n) => `<display-name>${n}</display-name>`).join("")}</channel>`)
    .join("\n");
  const programmes = entries
    .map(([id, , title = "Something"], at) =>
      `<programme start="2026091${at}120000 +0000" stop="2026091${at}130000 +0000" channel="${id}"><title>${title}</title></programme>`
    )
    .join("\n");
  return `<tv>${channels}\n${programmes}</tv>`;
};

const ids = (produced) => produced.channels.map((channel) => channel.id).sort();

describe("pass 1 — exact ids and names", () => {
  it("matches on the id however each side punctuates it", () => {
    const index = buildIndex([{ name: "UK: BBC Four HD", epg_channel_id: "BBC Four HD.uk" }]);
    const out = convert(guide(["BBC.Four.HD.uk", ["BBC Four"]]), index);
    assert.deepEqual(ids(out), ["BBC Four HD.uk"]);
    assert.equal(attr(out.channels[0].element, "id"), "BBC Four HD.uk");
    assert.equal(attr(out.programmes[0].element, "channel"), "BBC Four HD.uk");
  });

  it("marks a provider id as such, and a kept source id as not", () => {
    // The cache replays this output days later and may only re-check ids the
    // provider actually owns — see cache.mjs.
    const index = buildIndex([{ name: "UK: BBC Four HD", epg_channel_id: "BBC Four HD.uk" }]);
    const matched = convert(guide(["BBC.Four.HD.uk", ["BBC Four"]]), index);
    assert.equal(matched.channels[0].fromProvider, true);

    const kept = convert(guide(["Some.Other.Channel.uk", ["Nothing Like It"]]), index, {
      passthrough: true,
    });
    assert.equal(kept.channels[0].fromProvider, false);
  });
});

describe("pass precedence", () => {
  // Two provider ids for one real channel, where only one matches exactly.
  const twoIds = () =>
    buildIndex([
      { name: "UK: TNT Sports 3 HD", epg_channel_id: "TNTSports3 HD.uk" },
      { name: "UK: TNT Sports 3", epg_channel_id: "TNT Sports 3.uk" },
    ]);

  it("stops at an exact id hit rather than also taking the loose sibling", () => {
    // The ?? chain ends at the first lookup that returns anything: an exact id
    // match is the most confident answer there is, and going on to the looser
    // keys afterwards would let one source channel sweep up rows it was never
    // precise about.
    const out = convert(guide(["TNTSports3.HD.uk", ["TNT Sports 3"]]), twoIds());
    assert.deepEqual(ids(out), ["TNTSports3 HD.uk"]);
    assert.equal(out.programmes.length, 1);
  });

  it("fans out to both ids when only the loose key matches", () => {
    // Nothing here matches exactly, so the base key does the work — and both
    // provider ids collapse to it, which is why one source channel can serve
    // two provider channels.
    const out = convert(guide(["TNTSport3.uk", ["TNT Sport 3"]]), twoIds());
    assert.deepEqual(ids(out), ["TNT Sports 3.uk", "TNTSports3 HD.uk"]);
    // Once per target and no more.
    assert.equal(out.programmes.length, 2);
  });

  it("never gives one provider channel to two source channels", () => {
    // Two source channels both resolve to "Dave.uk": one exactly, one only by
    // name. Whichever got there first keeps it — without that, the target is
    // emitted twice and the guide carries a duplicate channel id, which is a
    // player picking between them at random.
    const index = buildIndex([{ name: "UK: Dave HD", epg_channel_id: "Dave.uk" }]);
    const out = convert(guide(["Dave.uk", ["Dave"]], ["DaveHD.uk", ["Dave HD"]]), index);
    assert.deepEqual(ids(out), ["Dave.uk"]);
    assert.equal(out.channels.length, 1, "one channel element per id");
  });

  it("reaches a feed variant the exact pass cannot", () => {
    const index = buildIndex([{ name: "IS: RUV 2 FHD", epg_channel_id: "RUV2.is" }]);
    const out = convert(guide(["RUV 2 HD.is", ["RUV 2 HD"]]), index);
    assert.deepEqual(ids(out), ["RUV2.is"]);
  });
});

describe("pass 3 — country scoping", () => {
  const both = [
    { name: "UK: Animal Planet", epg_channel_id: "AnimalPlanet.uk" },
    { name: "US: Animal Planet", epg_channel_id: "AnimalPlanet.us" },
  ];

  it("never lets a name cross between countries", () => {
    const index = buildIndex(both);
    const out = convert(guide(["Animal Planet (East).us", ["Animal Planet"]]), index);
    assert.deepEqual(ids(out), ["AnimalPlanet.us"]);
  });

  it("widens only to the country a source declares, and no further", () => {
    const index = buildIndex([
      { name: "IS: Animal Planet", epg_channel_id: "AnimalPlanet.is" },
      { name: "UK: Animal Planet", epg_channel_id: "AnimalPlanet.uk" },
    ]);
    const source = guide(["Animal Planet Denmark (DK,DA).dk", ["Animal Planet"]]);

    // Iceland is declared, so the Nordic feed may serve the Icelandic row.
    assert.deepEqual(ids(convert(source, index, { borrow: "is" })), ["AnimalPlanet.is"]);
    // Without the declaration it reaches nothing, and it must never reach UK.
    assert.deepEqual(ids(convert(source, index)), []);
    assert.deepEqual(ids(convert(source, index, { borrow: "is" })).includes("AnimalPlanet.uk"), false);
  });
});

describe("pass 4 — rows with no id", () => {
  it("advertises the provider's own name so the player can match on it", () => {
    // The row has no id, so a player can only ever find it by name.
    const index = buildIndex([
      { name: "UK: TNT Sports 5 FHD", epg_channel_id: "" },
      { name: "UK: TNT Sports 5 HD", epg_channel_id: "TNTSports5.uk" },
    ]);
    const out = convert(guide(["TNT.Sports.5.uk", ["TNT Sports 5"]]), index);
    assert.match(out.channels[0].element, /<display-name>UK: TNT Sports 5 FHD<\/display-name>/);
  });

  it("keeps an id-less row's name inside its own country", () => {
    const index = buildIndex([
      { name: "VN: Animal Planet", epg_channel_id: "" },
      { name: "IS: Animal Planet", epg_channel_id: "AnimalPlanet.is" },
    ]);
    const out = convert(guide(["AnimalPlanet.is", ["Animal Planet"]]), index);
    assert.ok(!out.channels[0].element.includes("VN: Animal Planet"), "must not cross to Vietnam");
  });
});

describe("what must never be claimed", () => {
  it("ignores a channel whose only programmes are filler", () => {
    // iptv-epg.org fills channels it has no schedule for. Left alone the
    // filler claims the id and no other source can serve it.
    const index = buildIndex([{ name: "UK: Alibi HD", epg_channel_id: "Alibi.uk" }]);
    const source =
      '<tv><channel id="Alibi.uk"><display-name>Alibi</display-name></channel>' +
      '<programme start="20260911120000 +0000" stop="20260911130000 +0000" channel="Alibi.uk">' +
      "<title>No Data</title></programme></tv>";
    assert.deepEqual(ids(convert(source, index)), []);
  });

  it("drops a programme that ends before it starts, or carries an unreadable stamp", () => {
    const index = buildIndex([{ name: "UK: Dave HD", epg_channel_id: "Dave.uk" }]);
    const source =
      '<tv><channel id="Dave.uk"><display-name>Dave</display-name></channel>' +
      '<programme start="20260911130000 +0000" stop="20260911120000 +0000" channel="Dave.uk"><title>Backwards</title></programme>' +
      '<programme start="20260911140000 +0000" stop="nonsense" channel="Dave.uk"><title>Unreadable</title></programme>' +
      '<programme start="20260911150000 +0000" stop="20260911160000 +0000" channel="Dave.uk"><title>Fine</title></programme></tv>';
    const out = convert(source, index);
    assert.equal(out.programmes.length, 1);
    assert.match(out.programmes[0].element, /Fine/);
  });

  it("emits nothing for a source channel nothing matches", () => {
    const index = buildIndex([{ name: "UK: Dave HD", epg_channel_id: "Dave.uk" }]);
    assert.deepEqual(ids(convert(guide(["Totally.Unknown.pl", ["Totally Unknown"]]), index)), []);
  });

  it("keeps everything when the source is passthrough", () => {
    // The Icelandic guide's ids are already my provider's channel names, so
    // its unmatched channels are kept under their own id and found by name.
    const index = buildIndex([{ name: "UK: Dave HD", epg_channel_id: "Dave.uk" }]);
    const out = convert(guide(["IS: Samstodin FHD", ["Samstodin"]]), index, { passthrough: true });
    assert.deepEqual(ids(out), ["IS: Samstodin FHD"]);
  });
});

describe("the +1 collision", () => {
  it("leaves a +1 row's id unmatched when it collides with its base row's", () => {
    // My provider gives "UK: 5 Usa  1" the id 5USA.uk and "UK: 5 Usa" the id
    // "5 USA.uk", which normalise alike — so one source channel claimed both
    // and the +1 row published the base schedule an hour early. Left
    // unmatched, the timeshift pass fills it properly instead.
    const index = buildIndex([
      { name: "UK: 5 Usa", epg_channel_id: "5 USA.uk" },
      { name: "UK: 5 Usa  1", epg_channel_id: "5USA.uk" },
    ]);
    assert.deepEqual(ids(convert(guide(["5USA.uk", ["5 USA"]]), index)), ["5 USA.uk"]);
  });

  it("still matches a +1 row whose id is a real upstream +1 feed", () => {
    // "E4+1.uk" does not normalise to "E4 HD.uk", so it is not a collision
    // and must keep matching — seven rows in my playlist are like this.
    const index = buildIndex([
      { name: "UK: E4 HD", epg_channel_id: "E4 HD.uk" },
      { name: "UK: E4  1", epg_channel_id: "E4+1.uk" },
    ]);
    assert.deepEqual(ids(convert(guide(["E4+1.uk", ["E4 +1"]]), index)), ["E4+1.uk"]);
  });
});
