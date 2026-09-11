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
// first-to-claim order and cannot outrank a source that is working.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { attr, parseTime } from "./epg-xml.mjs";

// Kept out of git and restored from the Actions cache — see the workflow. A
// missing directory is a cold start, not an error: the build just runs without
// a safety net until the first success fills it.
const DIR = "cache";

// Past this, reuse stops. Every upstream here publishes at least a week ahead,
// so four days still leaves real schedule to serve; beyond that the copy is
// mostly history, and a source that has been failing for that long is a
// problem to fix rather than to paper over.
const MAX_AGE_DAYS = 4;

const DAY_MS = 86_400_000;

// Letters and digits of any script, so "RÚV" and "Sýn" keep their own names.
// Folding accents away would have left both as "r-v" and "s-n" — distinct
// today, but one label away from two sources sharing a file, and a source
// served from another source's copy is the worst thing this module could do.
const fileFor = (label) => `${DIR}/${label.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.json.gz`;

export const save = (label, { channels, programmes }) => {
  mkdirSync(DIR, { recursive: true });
  const body = JSON.stringify({ fetched: new Date().toISOString(), channels, programmes });
  writeFileSync(fileFor(label), gzipSync(Buffer.from(body, "utf8"), { level: 6 }));
};

// Null whenever there is nothing worth serving — no copy, an unreadable one, or
// one too old — so the caller reports the source as failed rather than quietly
// publishing something useless.
//
// Programmes that have already ended are dropped, and with them any channel
// left with nothing: a channel kept for its own sake would count as matched
// and hide the failure from the publish gate.
export const load = (label) => {
  const file = fileFor(label);
  if (!existsSync(file)) return null;

  let cached;
  try {
    cached = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  } catch {
    return null; // truncated, or written by an older shape of this file
  }
  if (!Array.isArray(cached.channels) || !Array.isArray(cached.programmes)) return null;

  const ageDays = (Date.now() - Date.parse(cached.fetched)) / DAY_MS;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_AGE_DAYS) return null;

  const now = Date.now();
  const programmes = cached.programmes.filter((programme) => {
    const stop = parseTime(attr(programme.element, "stop") ?? "");
    return Number.isFinite(stop) && stop > now;
  });
  if (!programmes.length) return null;

  const live = new Set(programmes.map((programme) => programme.channel));
  const channels = cached.channels.filter((channel) => live.has(channel.id));

  return { channels, programmes, ageDays };
};
