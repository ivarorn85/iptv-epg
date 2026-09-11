// Builds one merged XMLTV guide whose channel ids match my provider's, so
// TiviMate fills the grid with no per-channel mapping. Fetched sources are
// matched to it in five passes of falling confidence, and two more producers
// derive what no source publishes — the README explains why each one exists.
//
// This file holds the source list, the matching, and the run itself. The
// producers that generate a guide rather than match one live in their own
// modules: iceland.mjs, events.mjs, timeshift.mjs.
//
// Local:  XTREAM_HOST=... XTREAM_USER=... XTREAM_PASS=... node build-epg.mjs
// CI:     driven by .github/workflows/build-epg.yml
//
// No dependencies. Needs Node 18 or newer; CI runs 22.

import { writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import * as cache from "./cache.mjs";
import { hours, mb, slotKey } from "./epg-xml.mjs";
import { eventGuide } from "./events.mjs";
import { getJson, request } from "./http.mjs";
import { ruvGuide, synGuide } from "./iceland.mjs";
import { buildIndex, checkAliasList, convert } from "./match.mjs";
import { siminnGuide } from "./siminn.mjs";
import { timeshiftGuide } from "./timeshift.mjs";

const EPGSHARE = "https://epgshare01.online/epgshare01/epg_ripper_";
const IPTVEPG = "https://iptv-epg.org/files/epg-";

// Order matters: the first source to claim a channel wins.
// `passthrough` keeps unmatched channels as-is, which the Icelandic guide
// needs because its ids are already my channel names.
// `borrow` lets a source also serve another country's entries.
const SOURCES = [
  // The broadcasters' own APIs come first: first-party beats any aggregator for
  // the channels they own, and between them they are the only source anywhere
  // for Sýn+, the Sýn Sport Ísland channels and Sýn Sport 5.
  { label: "RÚV", build: ruvGuide },
  { label: "Sýn", build: synGuide },
  // The Icelandic schedule for the international channels, which is the right
  // one for Icelandic rows: before this, four of them were served Sweden's
  // because no Icelandic source carried them, and Omega and ARTE ÞÝSK had
  // nothing at all. Ahead of the aggregators below on purpose — and it is the
  // only Icelandic source here that is not iptv-epg.org, which took 135
  // channels' guide down with it for a day and a half.
  { label: "Síminn", build: siminnGuide },
  // Ids already in my provider's vocabulary ("AnimalPlanet.is"), and it runs
  // first because it carries a full week of RUV and RUV 2 where guide3 has one
  // day. It has nothing for Sýn, Sýn Sport, Sjónvarp Símans or KVF, so guide3
  // still does the heavy lifting and picks those up next.
  { label: "Iceland extra", url: `${IPTVEPG}is.xml.gz` },
  { label: "Iceland", url: "https://is-epg.run.place/iptv/guide3.xml", passthrough: true },
  { label: "UK", url: `${EPGSHARE}UK1.xml.gz` },
  // Fills what UK1 has no entry for at all: Sky Sports F1, the Sky Cinema
  // channels, Sky Atlantic, E4, More 4, and a plain BBC One.
  { label: "UK extra", url: `${IPTVEPG}gb.xml.gz` },
  { label: "US", url: `${EPGSHARE}US2.xml.gz` },
  { label: "US sports", url: `${EPGSHARE}US_SPORTS1.xml.gz` },
  // 500 MB uncompressed, within 3% of the largest string Node can hold. It is
  // late because it only fills leftovers, and it will start being skipped once
  // it outgrows that ceiling — see the size check in fetchSource.
  { label: "US extra", url: `${IPTVEPG}us.xml.gz` },
  // My provider's remaining Icelandic entries are international channels on the
  // Nordic feed, which only these carry — hence `borrow: "is"`. Never UK or US:
  // those are a different regional schedule, and wrong programmes are worse
  // than none.
  { label: "Denmark", url: `${EPGSHARE}DK1.xml.gz`, borrow: "is" },
  { label: "Norway", url: `${EPGSHARE}NO1.xml.gz`, borrow: "is" },
  { label: "Sweden", url: `${EPGSHARE}SE1.xml.gz`, borrow: "is" },
  // { label: "Germany", url: `${EPGSHARE}DE1.xml.gz` },
  // { label: "Spain", url: `${EPGSHARE}ES1.xml.gz` },
  // { label: "Italy", url: `${EPGSHARE}IT1.xml.gz` },
];

const OUT = "guide.xml.gz";
// How the builder hands the gate what it cannot see in the guide itself: what
// each source matched, and which of them were served from a cached copy.
const COUNTS = "counts.json";

// The largest string V8 will hold. Some of these files are close enough to it
// that saying so beats an ERR_STRING_TOO_LONG stack trace in the log.
const MAX_STRING = 0x1fffffe8;

// One wall-clock budget for all the fetching, rather than per-request timeouts
// that multiply. Twelve sources at two attempts and a three-minute timeout is
// over an hour of worst case against a twenty-minute job, so two hung hosts
// would cost the whole run — the opposite of the rule that an unreachable
// upstream costs only its own source. A source that finds the budget spent
// fails fast and falls back to its cached copy, which is what that copy is
// for. The happy path is about four minutes.
const FETCH_BUDGET_MS = 11 * 60_000;
const SOURCE_TIMEOUT_MS = 180_000;
let fetchDeadline = Infinity;

const fetchSource = async ({ url, build }) => {
  // Checked before the build() branch, not after: those producers make twenty
  // or thirty requests of their own, and syn.is is the one host here known to
  // be hostile. Letting them skip the budget was exactly the hole the budget
  // exists to close.
  const left = fetchDeadline - Date.now();
  if (left <= 0) throw new Error("the run's fetch budget is spent");

  if (build) return build(); // assembled from a JSON API rather than fetched as XMLTV

  // Generous, because one of these is a 59 MB download — but never more than
  // the budget has left, so the last source cannot overrun the job on its own.
  const res = await request(url, { timeoutMs: Math.min(SOURCE_TIMEOUT_MS, left), attempts: 2 });
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = url.endsWith(".gz") ? gunzipSync(buf) : buf;
  if (raw.length > MAX_STRING) throw new Error(`${mb(raw.length, 0)} uncompressed, too big to parse`);
  return raw.toString("utf8");
};

const loadChannels = async () => {
  const { XTREAM_HOST, XTREAM_USER, XTREAM_PASS } = process.env;
  if (!XTREAM_HOST || !XTREAM_USER || !XTREAM_PASS)
    throw new Error("set XTREAM_HOST, XTREAM_USER and XTREAM_PASS");

  const url =
    `${XTREAM_HOST.replace(/\/$/, "")}/player_api.php` +
    `?username=${encodeURIComponent(XTREAM_USER)}` +
    `&password=${encodeURIComponent(XTREAM_PASS)}` +
    `&action=get_live_streams`;

  try {
    return await getJson(url);
  } catch (err) {
    throw new Error(`Xtream API: ${err.message}`);
  }
};

const channels = await loadChannels();
const index = buildIndex(channels);
checkAliasList(channels);
console.log(`provider: ${channels.length} channels, ${index.byId.size} distinct id keys\n`);

const allChannels = [];
const allProgrammes = [];
const programmesByChannel = new Map();
const counts = {};
// Every channel-and-slot already filled, so an upstream repeating itself cannot
// reach the guide. Global rather than per source: only one source ever emits a
// given channel, but this way a producer cannot repeat itself either.
const slots = new Set();
let repeats = 0;
const stale = {}; // label -> age in days of the cached copy standing in for it
const collapsed = {}; // label -> a run whose matching fell off a cliff
const seen = new Set();

// One merge for every producer, sources and events alike: first to claim an id
// wins, and a programme is only kept if its own channel actually got emitted.
const merge = (label, { channels: produced, programmes }) => {
  const emitted = new Set();
  for (const { id, element } of produced) {
    if (seen.has(id)) continue;
    seen.add(id);
    emitted.add(id);
    allChannels.push(element);
  }
  for (const { channel, element } of programmes) {
    if (!emitted.has(channel)) continue;
    // One programme per channel and slot. Upstreams do repeat themselves — UK1
    // publishes Sky Kids twice, every programme of it, and guide3 repeats a
    // handful of Icelandic rows — and a repeat is not harmless: the grid shows
    // one of two identical entries, chosen arbitrarily. Measured at 391 of
    // 79,497 programmes in the last run before this existed.
    const slot = slotKey(channel, element);
    if (slots.has(slot)) {
      repeats++;
      continue;
    }
    slots.add(slot);
    allProgrammes.push(element);
    // Kept per channel as well, so a "+1" channel can be built from its base.
    // These are the same strings allProgrammes holds, not copies, so the cost
    // is the array slots and not the text — which is why this does not
    // contradict the note above about never holding a source's programmes.
    if (!programmesByChannel.has(channel)) programmesByChannel.set(channel, []);
    programmesByChannel.get(channel).push(element);
  }
  counts[label] = emitted.size;
  console.log(`${label}: matched ${emitted.size} channels`);
};

// A source that fails is served from its last good output rather than dropped:
// a guide fetched yesterday still covers the days ahead, and one bad fetch
// should not empty a grid that was fine an hour ago. cache.mjs explains the
// bounds. The failure is still reported, and still recorded as such in
// counts.json, so the gate and the log show it instead of it passing silently.
fetchDeadline = Date.now() + FETCH_BUDGET_MS;

// Ids the playlist still carries, so a cached channel cannot be emitted under
// an id the provider has since pointed at a different channel.
const stillKnown = new Set(channels.map((ch) => ch.epg_channel_id).filter(Boolean));

for (const source of SOURCES) {
  const { label } = source;
  let produced = null;

  try {
    produced = convert(await fetchSource(source), index, source);
  } catch (err) {
    // load() is documented never to throw, and is wrapped anyway: a fallback
    // that fails must cost this source its channels, never the whole build.
    let fallback = null;
    try {
      fallback = cache.load(label, { stillKnown });
    } catch (cacheErr) {
      console.error(`${label}: the cached copy could not be read (${cacheErr.message})`);
    }

    if (!fallback) {
      counts[label] = 0;
      console.error(`${label}: failed (${err.message}), and no usable cached copy — no guide this run`);
      continue;
    }
    produced = fallback;
    stale[label] = fallback.ageDays;
    console.error(
      `${label}: failed (${err.message}), serving a cached copy ${hours(fallback.ageDays)} old`
    );
  }

  // Outside the try on purpose. A disk error here is not an upstream failure,
  // and letting it fall into the catch above would discard a good live fetch
  // and then blame the source for it.
  if (!(label in stale)) {
    try {
      const saved = cache.save(label, produced);
      // The cache declining to overwrite means this run matched far fewer
      // channels than the copy it holds — the silent half of a source
      // breaking, since the gate's per-source check only fires at zero.
      if (saved?.collapsed) collapsed[label] = saved.collapsed;
    } catch (err) {
      console.error(`${label}: fetched fine, but the cached copy could not be written (${err.message})`);
    }
  }

  merge(label, produced);
}

// Pass 5. Like the timeshift below it this skips convert() entirely: both
// producers emit channels found by name, so there is no provider id to rewrite
// and nothing to match. Guarded like the sources are, so a bad row here cannot
// cost the whole guide.
try {
  const events = await eventGuide(channels);
  merge("Events", events);
  console.log(`  of those, ${events.borrowed} carry a real end time from Viaplay`);
} catch (err) {
  console.error(`Events: skipped (${err.message})`);
}

// Last, because it copies from what every other producer emitted. Guarded like
// the rest: it walks provider-supplied strings, and by this point every
// download is already paid for, so a throw here must not cost the whole build.
try {
  const timeshift = timeshiftGuide(channels, programmesByChannel);
  merge("Timeshift", timeshift);
  if (timeshift.unshiftable)
    console.error(`  ${timeshift.unshiftable} programmes dropped: their stamps would not shift`);
} catch (err) {
  console.error(`Timeshift: skipped (${err.message})`);
}

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<tv generator-info-name="build-epg">\n' +
  `${allChannels.join("\n")}\n${allProgrammes.join("\n")}\n</tv>\n`;

const raw = Buffer.from(xml, "utf8");
writeFileSync(OUT, gzipSync(raw, { level: 9 }));
writeFileSync(COUNTS, `${JSON.stringify({ sources: counts, stale, collapsed }, null, 2)}\n`);

console.log(
  `\n${OUT}: ${seen.size} channels, ${allProgrammes.length} programmes, ${mb(raw.length)} raw`
);
if (repeats) console.log(`${repeats} repeated programmes dropped: an upstream listing itself twice`);
