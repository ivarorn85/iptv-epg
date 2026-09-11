// A source that fails one run should not blank its channels.
//
// Guides are published days ahead, so the copy fetched yesterday still holds
// tomorrow's schedule, and serving that beats leaving those channels empty or
// refusing the whole publish. Not a hypothetical: all three iptv-epg.org
// sources answered HTTP 526 for a day, which would have cost 149 channels
// their guide even though a good copy had been fetched hours earlier.
//
// What is stored is each source's finished output — the channels and programmes
// it contributed, with provider ids already in place — rather than the file it
// came from. That is a fraction of the size, needs no re-parsing, and replays
// through the same merge, so a cached source keeps its place in the
// first-to-claim order.
//
// How much grace this actually buys depends on the source, and it is less than
// it looks. Measured look-ahead per source: UK1 2.8 days, US2 3.1, Norway 2.6,
// Denmark 3.9, Sweden 4.2 — against RÚV 9.6, Sýn 13.7, US sports 29.8. For the
// epgshare files the copy is empty of future programmes after two or three
// days, so that, not the age bound below, is what ends the grace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { attr, parseTime } from "./epg-xml.mjs";

// Kept out of git and restored from the Actions cache — see the workflow. A
// missing directory is a cold start, not an error: the build just runs without
// a safety net until the first success fills it.
const DIR = "cache";

// The outer bound, which only binds on the sources that publish far ahead. For
// the rest the emptiness check does the work first. Beyond this a copy is
// mostly history and a source that has failed this long is a problem to fix.
const MAX_AGE_DAYS = 4;

// A successful run whose matching collapsed must not overwrite a good copy.
// The case is real and silent: an upstream changes its ids, the fetch succeeds,
// convert() matches almost nothing, and the fallback that could have carried
// those channels for another two days is gone — in the very run where the gate
// is about to need it. Keep the old copy unless the new one is within this much
// of it, and let the gate's per-source check be the one to complain.
const COLLAPSE = 0.5;

const DAY_MS = 86_400_000;

// Letters and digits of any script, so "RÚV" and "Sýn" keep their own names.
// Folding accents away would have left both as "r-v" and "s-n" — distinct
// today, but one label away from two sources sharing a file, and a source
// served from another source's copy is the worst thing this module could do.
const fileFor = (label) =>
  `${DIR}/${label.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.json.gz`;

// Only entries this module can replay: an id or channel to attach to, and an
// element to emit. Anything else is a file written by an older shape of this
// module, and load() is called from inside a catch — so a shape it cannot read
// has to become "no copy", never a throw that costs the whole build.
const usableChannels = (list) =>
  list.filter((entry) => entry && typeof entry.id === "string" && typeof entry.element === "string");
const usableProgrammes = (list) =>
  list.filter(
    (entry) => entry && typeof entry.channel === "string" && typeof entry.element === "string"
  );

const read = (file) => {
  try {
    const cached = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
    if (!Array.isArray(cached.channels) || !Array.isArray(cached.programmes)) return null;
    return {
      fetched: cached.fetched,
      channels: usableChannels(cached.channels),
      programmes: usableProgrammes(cached.programmes),
    };
  } catch {
    return null; // truncated, not gzip, or not the shape this module writes
  }
};

// Returns what it stored, or null if it declined to. Declining is not an error:
// the live output still goes into the guide, only the fallback is left alone.
export const save = (label, { channels, programmes }) => {
  const file = fileFor(label);

  // Nothing to fall back to later, and saving it would erase what there is.
  if (!channels.length || !programmes.length) return null;

  const existing = existsSync(file) ? read(file) : null;
  if (existing && channels.length < existing.channels.length * COLLAPSE) {
    console.error(
      `${label}: keeping the cached copy — this run matched ${channels.length} channels` +
        ` against the ${existing.channels.length} it holds`
    );
    // Reported, not just logged. This is the only detector of a source whose
    // fetch succeeds while its matching collapses, and the gate's per-source
    // check only fires at exactly zero — so 171 channels becoming 60 would
    // otherwise be held here and published green.
    return { collapsed: { now: channels.length, held: existing.channels.length } };
  }

  mkdirSync(DIR, { recursive: true });
  const body = JSON.stringify({ fetched: new Date().toISOString(), channels, programmes });
  writeFileSync(file, gzipSync(Buffer.from(body, "utf8"), { level: 6 }));
  return { stored: { channels: channels.length, programmes: programmes.length } };
};

// Null whenever there is nothing worth serving — no copy, an unreadable one, or
// one too old — so the caller reports the source as failed rather than quietly
// publishing something useless. Never throws: it is called from a catch.
//
// Programmes that have already ended are dropped, and with them any channel
// left with nothing: a channel kept for its own sake would count as matched
// and hide the failure from the publish gate.
export const load = (label, { stillKnown } = {}) => {
  const file = fileFor(label);
  if (!existsSync(file)) return null;

  const cached = read(file);
  if (!cached) return null;

  const ageDays = (Date.now() - Date.parse(cached.fetched)) / DAY_MS;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_AGE_DAYS) return null;

  const now = Date.now();
  let programmes = cached.programmes.filter((programme) => {
    const stop = parseTime(attr(programme.element, "stop") ?? "");
    return Number.isFinite(stop) && stop > now;
  });

  // A provider id can be retired or re-pointed between runs, and a cached
  // channel carries the id it was matched to days ago. Emitting one the
  // playlist no longer knows is harmless, but emitting one the provider has
  // since pointed at a different channel is not — it is the one thing this
  // project calls worse than an empty row.
  //
  // Only ids that came FROM the provider are checked. The rest are the source's
  // own, kept by pass 4 or passthrough and matched by display-name, so the
  // provider cannot have re-pointed them — and checking them anyway threw away
  // 30 of US sports' 31 channels and four of Sýn's, the ones no other source
  // carries at all.
  let channels = cached.channels;
  if (stillKnown) {
    channels = channels.filter((channel) => !channel.fromProvider || stillKnown.has(channel.id));
    const live = new Set(channels.map((channel) => channel.id));
    programmes = programmes.filter((programme) => live.has(programme.channel));
  }

  if (!programmes.length) return null;

  const served = new Set(programmes.map((programme) => programme.channel));
  return { channels: channels.filter((channel) => served.has(channel.id)), programmes, ageDays };
};
