// The two Icelandic broadcasters, who publish their own schedules as JSON.
//
// First party beats any aggregator for the channels they own: syn.is is the
// only source anywhere for Sýn+, Sýn Sport 5 and the Sýn Sport Ísland channels,
// and ruv.is gives real end times instead of ones inferred from the next
// programme. Both emit XMLTV text and then go through exactly the same matching
// as a fetched file, so nothing here needs to know a single provider id.
//
// Neither API is a contract, so every field is treated as optional: one
// malformed row must cost its own programme, never the whole source.

import { HOUR_MS, xmltvChannel, xmltvProgramme } from "./epg-xml.mjs";
import { getJson } from "./http.mjs";


// What to assume when a publisher gives a start and no end.
const ASSUMED_HOURS = 3;
// How many days ahead to walk the day-at-a-time APIs.
const HORIZON_DAYS = 10;

// These two producers make twenty or thirty requests each, one per station or
// per day, so the defaults would let one unresponsive host spend the whole
// job's time — 20 requests at 60 seconds and three attempts is an hour against
// a twenty-minute job. Short per request, and a budget for the walk, the same
// shape events.mjs uses for Viaplay. syn.is is the host that has actually
// misbehaved here, by resetting the connection rather than answering.
const REQUEST = { timeoutMs: 30_000, attempts: 2 };
const BUDGET_MS = 240_000;

const SYN_API = "https://www.syn.is/api/epg";

// One station's events turned into a channel and its programmes, or null if the
// station should be skipped. Separated from the fetching so the arithmetic can
// be tested: syn.is gives a start and no end, so every stop here is worked out
// rather than read, and getting that wrong shifts a whole Icelandic channel
// without failing anything.
export const synStation = (station, events) => {
  const usable = events.filter((event) => event?.upphaf && (event.isltitill || event.titill));
  if (!usable.length) return null; // carried, but nothing scheduled right now

  // "beint" ("live") is not a channel: it is every channel's live events
  // pooled together, 99 of them across 11 different `midill` values. Treated
  // as one channel it takes another channel's name, claims that provider row,
  // and closes each event with the start of a fixture on a different channel.
  if (new Set(usable.map((event) => event.midill)).size > 1) return null;

  // Sorted so the next programme's start can close the previous one, and
  // deduplicated because the feed occasionally lists two at the same minute —
  // which would otherwise produce a zero-length entry and an overlap.
  const ordered = [...usable]
    .sort((one, two) => one.upphaf.localeCompare(two.upphaf))
    .filter((event, at, sorted) => at === 0 || event.upphaf !== sorted[at - 1].upphaf);

  // Match on "<station>.is" and on both names it goes by: the id reaches
  // "Synsport 5.is", and the station code reaches rows like "IS: SYN+ HD"
  // that carry no id and whose accent-free name only the code matches.
  const id = `${station}.is`;
  const programmes = [];

  for (const [at, event] of ordered.entries()) {
    const start = new Date(event.upphaf);
    if (Number.isNaN(start.getTime())) continue;
    // The next programme closes this one, but only if it starts within the
    // assumed length — a gap in the schedule must not stretch a programme
    // across it.
    const next = ordered[at + 1] ? new Date(ordered[at + 1].upphaf) : null;
    const capped = new Date(start.getTime() + ASSUMED_HOURS * HOUR_MS);
    programmes.push(
      xmltvProgramme({
        channel: id,
        start,
        stop: next && next > start && next < capped ? next : capped,
        title: event.isltitill || event.titill,
        desc: event.lysing,
        categories: String(event.flokkur ?? "").split(","),
        lang: "is",
      })
    );
  }

  return { channel: xmltvChannel(id, [ordered[0].midill_heiti, station]), programmes };
};

export const synGuide = async () => {
  const stations = await getJson(SYN_API, REQUEST);
  if (!Array.isArray(stations)) throw new Error("station list was not an array");

  const channels = [];
  const programmes = [];
  const deadline = Date.now() + BUDGET_MS;

  for (const station of stations) {
    // Running out of time is a failure of the whole producer, not a smaller
    // result. Returning what was read so far would be saved as this source's
    // output and overwrite a complete cached copy with a partial one — so the
    // source fails instead, and the cache serves the full copy it already has.
    if (Date.now() > deadline) throw new Error("ran out of time reading the station list");
    let events;
    try {
      events = await getJson(`${SYN_API}/${station}`, REQUEST);
      if (!Array.isArray(events)) continue;
    } catch {
      continue; // one station being down is not the whole source failing
    }
    const produced = synStation(station, events);
    if (!produced) continue;
    channels.push(produced.channel);
    programmes.push(...produced.programmes);
  }
  return `<tv>\n${channels.join("\n")}\n${programmes.join("\n")}\n</tv>\n`;
};

const RUV_GQL = "https://www.ruv.is/gql/";
const RUV_CHANNELS = { ruv: "RÚV", ruv2: "RÚV 2" };

// Written out rather than sent as a persisted-query hash: the hash belongs to
// whichever build of their site is current, and would break the day they deploy.
const RUV_QUERY = `query getSchedule($channel: Channels!, $date: String!) {
  Schedule(channel: $channel, date: $date) {
    events { title original_title description start_time end_time_friendly }
  }
}`;

// RÚV lists a strand and the items inside it as siblings — "KrakkaRÚV"
// 17:30-18:20 alongside the six cartoons that make it up. XMLTV has no notion
// of nesting, so a player shows one arbitrary programme across the whole span.
// The strand is the entry that completely contains the one after it.
// Only the immediately following entry is compared, so the list has to be in
// order — the caller sorts it rather than leaving that to how the API happened
// to answer. Exported for the tests: the arithmetic here decides whether an
// Icelandic channel shows 93 overlapping programmes or 2.
export const withoutStrands = (events) =>
  [...events]
    .sort((one, two) => one.start - two.start)
    .filter((event, at, sorted) => {
      const next = sorted[at + 1];
      return !next || !(next.start < event.stop && next.stop <= event.stop);
    });

// One RÚV event as a span, or null if it is not one. Separated from the
// fetching because every part of it is a way to get a date wrong: the API gives
// a full start stamp but only a wall-clock end, and that end belongs to the day
// the programme STARTS — a day's response also carries that night's
// post-midnight tail, so dating the end from the requested date puts those
// programmes a day out.
export const ruvSpan = (event) => {
  const title = event?.title || event?.original_title;
  if (!title || !event.start_time || !event.end_time_friendly) return null;

  // No offset on either, because Iceland keeps UTC all year.
  const start = new Date(`${event.start_time}Z`);
  const stop = new Date(`${event.start_time.slice(0, 10)}T${event.end_time_friendly}:00Z`);
  if (stop < start) stop.setUTCDate(stop.getUTCDate() + 1); // runs past midnight

  // Comparisons against an invalid date are all false, so it has to be tested
  // for directly or it reaches the formatter and throws.
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) return null;
  // "Dagskrárlok" — end of broadcasting — is a zero-length marker, not a
  // programme, and an empty span is invalid XMLTV.
  if (stop <= start) return null;

  return { start, stop, title, desc: event.description };
};

// A channel's spans as XMLTV, with the strands filtered out. A thin wrapper,
// but it is the wrapper that applies withoutStrands — and a test that only
// covers the filter cannot tell whether anything calls it.
export const ruvProgrammes = (channel, spans) =>
  withoutStrands(spans).map((span) => xmltvProgramme({ channel, ...span, lang: "is" }));

export const ruvGuide = async () => {
  const channels = [];
  const programmes = [];
  const deadline = Date.now() + BUDGET_MS;

  for (const [channel, name] of Object.entries(RUV_CHANNELS)) {
    const id = `${channel}.is`;
    channels.push(xmltvChannel(id, [name, channel]));
    const spans = [];
    const seenStart = new Set();

    for (let day = 0; day < HORIZON_DAYS; day++) {
      // As above: a short guide is worse than no guide, because it would
      // replace the cached one.
      if (Date.now() > deadline) throw new Error("ran out of time reading the schedule");
      const date = new Date(Date.now() + day * 24 * HOUR_MS).toISOString().slice(0, 10);
      let events;
      try {
        const answer = await getJson(RUV_GQL, {
          ...REQUEST,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: RUV_QUERY, variables: { channel, date } }),
        });
        events = answer?.data?.Schedule?.events;
      } catch {
        continue;
      }

      for (const event of events ?? []) {
        if (event?.start_time && seenStart.has(event.start_time)) continue; // across day requests
        const span = ruvSpan(event);
        if (!span) continue;
        seenStart.add(event.start_time);
        spans.push(span);
      }
    }

    programmes.push(...ruvProgrammes(id, spans));
  }
  return `<tv>\n${channels.join("\n")}\n${programmes.join("\n")}\n</tv>\n`;
};
