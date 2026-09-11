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
      events = events.filter((event) => event?.upphaf && (event.isltitill || event.titill));
    } catch {
      continue; // one station being down is not the whole source failing
    }
    if (!events.length) continue; // carried, but nothing scheduled right now

    // "beint" ("live") is not a channel: it is every channel's live events
    // pooled together, 99 of them across 11 different `midill` values. Treated
    // as one channel it takes another channel's name, claims that provider row,
    // and closes each event with the start of a fixture on a different channel.
    if (new Set(events.map((event) => event.midill)).size > 1) continue;

    // Sorted so the next programme's start can close the previous one, and
    // deduplicated because the feed occasionally lists two at the same minute —
    // which would otherwise produce a zero-length entry and an overlap.
    events.sort((a, b) => a.upphaf.localeCompare(b.upphaf));
    events = events.filter((event, at) => at === 0 || event.upphaf !== events[at - 1].upphaf);

    // Match on "<station>.is" and on both names it goes by: the id reaches
    // "Synsport 5.is", and the station code reaches rows like "IS: SYN+ HD"
    // that carry no id and whose accent-free name only the code matches.
    const id = `${station}.is`;
    channels.push(xmltvChannel(id, [events[0].midill_heiti, station]));

    for (const [at, event] of events.entries()) {
      const start = new Date(event.upphaf);
      if (Number.isNaN(start.getTime())) continue;
      const next = events[at + 1] ? new Date(events[at + 1].upphaf) : null;
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
        const title = event?.title || event?.original_title;
        if (!title || !event.start_time || !event.end_time_friendly) continue;
        if (seenStart.has(event.start_time)) continue; // belt and braces across day requests
        seenStart.add(event.start_time);

        // start_time carries no offset because Iceland has none. end_time is
        // wall clock only, and belongs to the day the programme *starts* — a
        // day's response also carries that night's post-midnight tail, so the
        // requested date is the wrong one to date it from.
        const start = new Date(`${event.start_time}Z`);
        const stop = new Date(`${event.start_time.slice(0, 10)}T${event.end_time_friendly}:00Z`);
        if (stop < start) stop.setUTCDate(stop.getUTCDate() + 1); // runs past midnight
        // Comparisons against an invalid date are all false, so it has to be
        // tested for directly or it reaches the formatter and throws.
        if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) continue;
        // "Dagskrárlok" — end of broadcasting — is a zero-length marker, not a
        // programme, and an empty span is invalid XMLTV.
        if (stop <= start) continue;

        spans.push({ start, stop, title, desc: event.description });
      }
    }

    for (const span of withoutStrands(spans))
      programmes.push(xmltvProgramme({ channel: id, ...span, lang: "is" }));
  }
  return `<tv>\n${channels.join("\n")}\n${programmes.join("\n")}\n</tv>\n`;
};
