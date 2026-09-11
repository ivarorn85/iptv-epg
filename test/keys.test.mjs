// The matching keys, which is where a mistake does not throw — it quietly puts
// one channel's schedule on another. Every case here is one that actually went
// wrong at some point, or that a plausible "tidy up" would break.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { baseKey, bodyOf, ccOf, idKey, nameKey, providerCc, scopedBaseKey, scopedKey } from "../keys.mjs";

describe("idKey", () => {
  it("collapses the two ways the same id is written", () => {
    assert.equal(idKey("BBC.Four.HD.uk"), idKey("BBC Four HD.uk"));
    assert.equal(idKey("BBC.Four.HD.uk"), "bbcfourhd|uk");
  });

  it("treats the ordinal in a split-country file as part of the file name", () => {
    // ".us2" is epgshare's second US file, not a country called "us2".
    assert.equal(idKey("BET.Jams.us2"), "betjams|us");
    assert.equal(ccOf("BET.Jams.us2"), "us");
  });

  it("leaves an id with no country suffix without one", () => {
    assert.equal(idKey("IS: RUV FHD"), "is:ruvfhd|");
    assert.equal(ccOf("IS: RUV FHD"), "");
    assert.equal(bodyOf("IS: RUV FHD"), "IS: RUV FHD");
  });

  it("keeps the colon, because my provider's ids contain one", () => {
    // Only . space _ - are stripped; a colon distinguishes these ids.
    assert.equal(idKey("IS: RUV"), "is:ruv|");
  });
});

describe("nameKey", () => {
  it("keeps + as a word so a timeshift is not the base channel", () => {
    // Danish TV3's schedule landed on TV3+ until + stopped vanishing.
    assert.notEqual(nameKey("TV3+"), nameKey("TV3"));
    assert.equal(nameKey("TV3+"), "tv3plus");
  });

  it("keeps Icelandic characters", () => {
    assert.equal(nameKey("IS: Sýn Sport"), "issýnsport");
  });

  it("is unaffected by punctuation and case", () => {
    assert.equal(nameKey("A&E HD"), "aehd");
    assert.equal(nameKey("Sky Sports Main Event"), nameKey("skysportsmainevent"));
  });
});

describe("baseKey", () => {
  it("drops one quality suffix", () => {
    assert.equal(baseKey("RUV 2 HD"), baseKey("RUV 2 FHD"));
  });

  it("drops variants that stack, including a backup-feed letter", () => {
    assert.equal(baseKey("Sky Sport Main Event UHD 4K B"), "skysportmainevent");
    assert.equal(baseKey("TNT Sports 1 FHD P50"), "tntsport1");
    assert.equal(baseKey("BBC One HDR 4K"), "bbc1");
  });

  it("folds Sports to Sport, because the two sides disagree", () => {
    // My provider writes "Sky Sport", epgshare writes "Sky Sports".
    assert.equal(baseKey("Sky Sport Main Event UHD 4K B"), baseKey("Sky Sports Main Event HD"));
  });

  it("treats a spelled-out number as its digit", () => {
    assert.equal(baseKey("BBC One"), baseKey("BBC 1"));
    assert.equal(baseKey("Channel One"), "channel1");
  });

  it("only folds a number that stands alone", () => {
    // Otherwise Vodafone becomes "vodaf1" and stops matching itself.
    assert.equal(baseKey("Vodafone"), "vodafone");
    assert.equal(baseKey("Vodafone HD"), "vodafone");
  });

  it("does not merge channels that differ by number", () => {
    assert.notEqual(baseKey("ITV 2"), baseKey("ITV 3"));
    assert.notEqual(baseKey("Sýn Sport 4 HD"), baseKey("Sýn Sport 5 HD"));
  });

  it("never returns an empty key by stripping everything", () => {
    // A name that is nothing but a variant must not collapse to "".
    for (const name of ["HD", "4K", "UHD"]) assert.ok(baseKey(name).length > 0, name);
  });
});

describe("scopedKey and scopedBaseKey", () => {
  it("put the country in the key so a match cannot cross markets", () => {
    assert.equal(scopedKey("uk", "UK: Animal Planet"), "uk|animalplanet");
    assert.notEqual(scopedKey("uk", "UK: Animal Planet"), scopedKey("vn", "VN: Animal Planet"));
  });

  it("strip the labelling each side adds", () => {
    // My provider's country prefix and epgshare's headend code both come off.
    assert.equal(scopedKey("se", "SE: MTV HD"), scopedKey("se", "[MTVSWHD] MTV HD"));
    // As does a bracketed feed annotation, which is how Denmark matches at all.
    assert.equal(scopedBaseKey("dk", "DK: DR 1 HD"), scopedBaseKey("dk", "DR1 (DK,DA)"));
  });

  it("cannot strip a country spelled out in the name, which is why Norway barely matches", () => {
    // epgshare's Norwegian entries are "Animal Planet Norway (NO,NO)". The
    // bracket comes off; the word does not, so it never meets the provider's
    // "NO: Animal Planet". Recorded because it looks like a matching bug.
    assert.equal(scopedBaseKey("no", "Animal Planet Norway (NO,NO)"), "no|animalplanetnorway");
    assert.notEqual(
      scopedBaseKey("no", "Animal Planet Norway (NO,NO)"),
      scopedBaseKey("no", "NO: Animal Planet")
    );
  });

  it("return nothing when there is no country to scope by", () => {
    // A truthy "|key" would be stored under a key nothing can look up.
    assert.equal(scopedKey("", "Animal Planet"), "");
    assert.equal(scopedBaseKey("", "Animal Planet"), "");
  });

  it("return nothing when the name normalises away", () => {
    assert.equal(scopedKey("uk", "(GB,EN)"), "");
  });
});

describe("providerCc", () => {
  it("reads the country out of the channel name, which is where my provider puts it", () => {
    assert.equal(providerCc({ name: "UK: BBC One", epg_channel_id: "BBCOne.uk" }), "uk");
    assert.equal(providerCc({ name: "IS:  RUV FHD", epg_channel_id: "" }), "is");
  });

  it("only treats a two-letter prefix as a country", () => {
    // "CAR:" is a label for a group of channels, not a country. Widening this
    // to the two-to-four characters that bare() strips would invent a country
    // called "car" and scope real channels into it, where nothing can match.
    assert.notEqual(providerCc({ name: "CAR: Racing 1", epg_channel_id: "" }), "car");
    assert.notEqual(providerCc({ name: "PPV: Fight Night", epg_channel_id: "" }), "ppv");
  });

  it("falls back to the id for a row carrying no prefix", () => {
    assert.equal(providerCc({ name: "Animal Planet", epg_channel_id: "AnimalPlanet.is" }), "is");
  });

  it("returns nothing rather than throwing when the row has neither", () => {
    assert.equal(providerCc({}), "");
    assert.equal(providerCc({ name: null, epg_channel_id: null }), "");
  });
});
