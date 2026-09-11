// The fallback that keeps a failed source's channels populated. What matters
// here is when it refuses: serving a copy that is too old, or one whose whole
// schedule has already been broadcast, would publish channels that look filled
// and are not — worse than reporting the source as failed.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { load, save } from "../cache.mjs";

// cache.mjs writes to "cache" relative to the working directory, so the tests
// run in a scratch one and leave the real cache alone.
const home = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "epg-cache-"));

before(() => process.chdir(scratch));
after(() => {
  process.chdir(home);
  rmSync(scratch, { recursive: true, force: true });
});

const DAY_MS = 86_400_000;

const stamp = (at) => `${new Date(at).toISOString().replace(/\D/g, "").slice(0, 14)} +0000`;

const channel = (id) => ({ id, element: `<channel id="${id}"></channel>` });

const programme = (channel, stop) => ({
  channel,
  element: `<programme start="${stamp(stop - 3_600_000)}" stop="${stamp(stop)}" channel="${channel}"><title>T</title></programme>`,
});

const tomorrow = () => Date.now() + DAY_MS;
const yesterday = () => Date.now() - DAY_MS;

// Writes a cache file directly, to age it past what save() can produce.
const writeAged = (label, ageDays, payload) => {
  mkdirSync("cache", { recursive: true });
  const body = { fetched: new Date(Date.now() - ageDays * DAY_MS).toISOString(), ...payload };
  writeFileSync(`cache/${label}.json.gz`, gzipSync(Buffer.from(JSON.stringify(body), "utf8")));
};

describe("save and load", () => {
  it("returns nothing at all on a cold start", () => {
    assert.equal(load("never seen"), null);
  });

  it("round-trips a source's output", () => {
    const produced = {
      channels: [channel("BBCOne.uk")],
      programmes: [programme("BBCOne.uk", tomorrow())],
    };
    save("UK extra", produced);

    const back = load("UK extra");
    assert.deepEqual(back.channels, produced.channels);
    assert.deepEqual(back.programmes, produced.programmes);
    assert.ok(back.ageDays < 1, "just written, so effectively no age");
  });

  it("keys on the label, however the label is punctuated", () => {
    // "Iceland extra" and "RÚV" have to land in different files, and the same
    // label has to find its own file again on the next run.
    save("RÚV", { channels: [channel("RUV.is")], programmes: [programme("RUV.is", tomorrow())] });
    save("Iceland extra", { channels: [channel("RUV.is")], programmes: [programme("RUV.is", tomorrow())] });
    assert.ok(load("RÚV"));
    assert.ok(load("Iceland extra"));
    assert.equal(load("ruv"), null);

    // And the reason the key keeps letters of any script: folding accents to
    // "-" would leave "RÚV" and "R V" as the same file, so one source would
    // be served another source's schedule.
    save("R V", { channels: [channel("OTHER.is")], programmes: [programme("OTHER.is", tomorrow())] });
    assert.equal(load("RÚV").programmes[0].channel, "RUV.is");
  });

  it("drops programmes that have already been broadcast", () => {
    save("US", {
      channels: [channel("A.us")],
      programmes: [programme("A.us", yesterday()), programme("A.us", tomorrow())],
    });
    assert.equal(load("US").programmes.length, 1);
  });

  it("drops a channel left with nothing, rather than counting it as matched", () => {
    save("US", {
      channels: [channel("gone.us"), channel("live.us")],
      programmes: [programme("gone.us", yesterday()), programme("live.us", tomorrow())],
    });
    assert.deepEqual(
      load("US").channels.map((channel) => channel.id),
      ["live.us"]
    );
  });

  it("refuses a copy with no future schedule left in it", () => {
    // The point of the fallback is the days ahead. Without them there is
    // nothing to serve, and the source must be reported as failed.
    save("US sports", { channels: [channel("A.us")], programmes: [programme("A.us", yesterday())] });
    assert.equal(load("US sports"), null);
  });

  it("refuses a copy that is too old to trust", () => {
    // Ages out so a permanently dead upstream eventually fails the build
    // instead of being papered over forever.
    writeAged("old", 30, { channels: [channel("A.us")], programmes: [programme("A.us", tomorrow())] });
    assert.equal(load("old"), null);

    writeAged("fresh", 1, { channels: [channel("A.us")], programmes: [programme("A.us", tomorrow())] });
    assert.ok(load("fresh"));
  });

  it("refuses a copy it cannot read, instead of throwing", () => {
    // A half-written file must cost the build nothing but this source.
    mkdirSync("cache", { recursive: true });
    writeFileSync("cache/torn.json.gz", Buffer.from("not gzip"));
    assert.equal(load("torn"), null);

    // With a real future programme in it, so the shape guard is the reason it
    // is refused and not the emptiness check standing in for it.
    writeAged("shapeless", 1, {
      channels: "not an array",
      programmes: [programme("A.us", tomorrow())],
    });
    assert.equal(load("shapeless"), null);
  });

  it("skips entries it cannot replay instead of throwing on them", () => {
    // load() is called from inside a catch, so a file written by an older
    // shape of this module has to become "no copy", never an exception that
    // costs the whole build.
    writeAged("ragged", 1, {
      channels: [null, channel("A.us")],
      programmes: [null, { channel: "A.us" }, programme("A.us", tomorrow())],
    });
    const back = load("ragged");
    assert.equal(back.channels.length, 1);
    assert.equal(back.programmes.length, 1);
  });

  it("refuses a copy dated in the future, which means a clock went wrong", () => {
    writeAged("skewed", -5, { channels: [channel("A.us")], programmes: [programme("A.us", tomorrow())] });
    assert.equal(load("skewed"), null);
  });

  it("drops a cached programme whose stop cannot be read", () => {
    // Nothing can tell whether it is still to come, and the gate refuses a
    // whole publish over one such programme.
    save("US", {
      channels: [channel("A.us")],
      programmes: [
        { channel: "A.us", element: '<programme start="x" stop="nonsense" channel="A.us"></programme>' },
        programme("A.us", tomorrow()),
      ],
    });
    assert.equal(load("US").programmes.length, 1);
  });
});

describe("save declining to overwrite", () => {
  const good = (count) => ({
    channels: Array.from({ length: count }, (unused, index) => ({
      id: `C${index}.uk`,
      element: `<channel id="C${index}.uk"></channel>`,
    })),
    programmes: Array.from({ length: count }, (unused, index) =>
      programme(`C${index}.uk`, tomorrow())
    ),
  });

  it("keeps the old copy when a run's matching collapses", () => {
    // The silent case this exists for: an upstream changes its ids, the fetch
    // succeeds, matching collapses, and the fallback that could have carried
    // those channels is erased in the very run the gate is about to need it.
    save("collapse", good(100));
    assert.equal(save("collapse", good(3)), null, "should have declined");
    assert.equal(load("collapse").channels.length, 100);
  });

  it("still accepts ordinary churn", () => {
    save("churn", good(100));
    assert.ok(save("churn", good(97)), "a few channels fewer is not a collapse");
    assert.equal(load("churn").channels.length, 97);
  });

  it("drops a cached channel whose id the playlist no longer carries", () => {
    // A cached channel carries the provider id it was matched to days ago. If
    // the provider has since pointed that id at a different channel, replaying
    // it puts one channel's schedule on another — the one thing this project
    // treats as worse than an empty row.
    save("US", {
      channels: [channel("kept.us"), channel("retired.us")],
      programmes: [programme("kept.us", tomorrow()), programme("retired.us", tomorrow())],
    });

    const back = load("US", { stillKnown: new Set(["kept.us"]) });
    assert.deepEqual(
      back.channels.map((entry) => entry.id),
      ["kept.us"]
    );
    assert.deepEqual(
      back.programmes.map((entry) => entry.channel),
      ["kept.us"]
    );

    // Without the playlist to check against, nothing is dropped.
    assert.equal(load("US").channels.length, 2);
  });

  it("never stores an empty result over a good one", () => {
    save("emptied", good(50));
    assert.equal(save("emptied", { channels: [], programmes: [] }), null);
    assert.equal(load("emptied").channels.length, 50);
  });
});
