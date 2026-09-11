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
      channels: [{ id: "BBCOne.uk", element: '<channel id="BBCOne.uk"></channel>' }],
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
    save("RÚV", { channels: [], programmes: [programme("RUV.is", tomorrow())] });
    save("Iceland extra", { channels: [], programmes: [programme("RUV.is", tomorrow())] });
    assert.ok(load("RÚV"));
    assert.ok(load("Iceland extra"));
    assert.equal(load("ruv"), null);
  });

  it("drops programmes that have already been broadcast", () => {
    save("US", {
      channels: [{ id: "A.us", element: '<channel id="A.us"></channel>' }],
      programmes: [programme("A.us", yesterday()), programme("A.us", tomorrow())],
    });
    assert.equal(load("US").programmes.length, 1);
  });

  it("drops a channel left with nothing, rather than counting it as matched", () => {
    save("US", {
      channels: [
        { id: "gone.us", element: '<channel id="gone.us"></channel>' },
        { id: "live.us", element: '<channel id="live.us"></channel>' },
      ],
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
    save("US sports", { channels: [], programmes: [programme("A.us", yesterday())] });
    assert.equal(load("US sports"), null);
  });

  it("refuses a copy that is too old to trust", () => {
    // Ages out so a permanently dead upstream eventually fails the build
    // instead of being papered over forever.
    writeAged("old", 30, { channels: [], programmes: [programme("A.us", tomorrow())] });
    assert.equal(load("old"), null);

    writeAged("fresh", 1, { channels: [], programmes: [programme("A.us", tomorrow())] });
    assert.ok(load("fresh"));
  });

  it("refuses a copy it cannot read, instead of throwing", () => {
    // A half-written file must cost the build nothing but this source.
    mkdirSync("cache", { recursive: true });
    writeFileSync("cache/torn.json.gz", Buffer.from("not gzip"));
    assert.equal(load("torn"), null);

    writeAged("shapeless", 1, { channels: "not an array", programmes: [] });
    assert.equal(load("shapeless"), null);
  });
});
