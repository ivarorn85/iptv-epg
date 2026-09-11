// Sjónvarp Símans publishes a seven-day guide for its whole channel line-up —
// 55 channels, the Icelandic international feeds among them — and it is the
// only Icelandic source for a handful of rows nothing else carries.
//
// Why it is here at all, since most of these channels already have a schedule:
// the Icelandic one is the right one. Before this, four Icelandic rows were
// served Sweden's schedule because no Icelandic source carried them, and
// `IS: Omega FHD` and `IS: ARTE ÞÝSK FHD` had nothing. It also breaks a single
// point of failure — every other Icelandic aggregator in the list is
// iptv-epg.org, which went down for a day and a half and took 135 channels'
// guide with it.
//
// Two things about the page are worth knowing before touching this.
//
// It answers HTTP 500 and serves the complete schedule anyway: ten megabytes
// of working page under a broken status. Hence `anyStatus` — see http.mjs.
//
// The schedule is not an API. It is a Next.js server-rendered payload embedded
// in the HTML, so this reads the JSON out of the page. That makes it the most
// fragile source in the build, which is why it is parsed as real JSON rather
// than scraped field by field: it either parses or it throws, and a throw costs
// this source its channels and nothing else.

import { HOUR_MS, xmltvChannel, xmltvProgramme } from "./epg-xml.mjs";
import { request } from "./http.mjs";
import { nameKey } from "./keys.mjs";

const DAGSKRA = "https://www.siminn.is/dagskra";

// Ten megabytes of HTML, and nothing else depends on it.
const REQUEST = { timeoutMs: 60_000, attempts: 2, anyStatus: true };

// Iceland keeps UTC all year, and the payload's stamps carry no offset
// ("2026-09-10T23:30"), so they are already UTC and need no conversion.
const at = (stamp) => new Date(`${stamp}Z`);

// Walks a balanced JSON array or object from an opening bracket, so a value can
// be lifted out of the payload without knowing what surrounds it.
const balanced = (text, from) => {
  const close = text[from] === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = from; cursor < text.length; cursor++) {
    const ch = text[cursor];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') inString = !inString;
    else if (inString) continue;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return text.slice(from, cursor + 1);
    }
  }
  return null;
};

// Every array in the payload under the given key, parsed. Anything that will
// not parse is skipped: the point is to get the schedule, not to explain the
// page.
const arrays = (payload, key) => {
  const found = [];
  for (const match of payload.matchAll(new RegExp(`"${key}":\\[`, "g"))) {
    const text = balanced(payload, match.index + key.length + 3);
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value)) found.push(value);
    } catch {
      /* a fragment the unescaping mangled; the others still stand */
    }
  }
  return found;
};

export const siminnGuide = async () => {
  const res = await request(DAGSKRA, REQUEST);
  const html = await res.text();

  // The payload is JS-escaped JSON inside the page. A regex that walks escaped
  // strings overflows the stack at this size, so unescape in two plain passes.
  const payload = html.split('\\"').join('"').split("\\\\").join("\\");

  const stations = arrays(payload, "channels")
    .flat()
    .filter((station) => station?.channelApiId && station?.channelName);
  const events = arrays(payload, "epg").flat();
  if (!stations.length || !events.length)
    throw new Error(`read ${stations.length} channels and ${events.length} programmes`);

  // Ids in my provider's own vocabulary, so an exact match is possible: the
  // provider calls Omega "Omega.is", and nameKey("Omega") + ".is" is the same
  // key. Where it is not a provider id, pass 3 still matches on the name, and
  // the ".is" suffix is what scopes it to Iceland.
  const idFor = new Map();
  const channels = [];
  for (const station of stations) {
    const id = `${nameKey(station.channelName)}.is`;
    if (idFor.has(station.channelApiId)) continue;
    idFor.set(station.channelApiId, id);
    channels.push(xmltvChannel(id, [station.channelName]));
  }

  const programmes = [];
  const seen = new Set();
  for (const event of events) {
    const id = idFor.get(event?.channelUuid);
    if (!id || !event.title || !event.since || !event.till) continue;

    const start = at(event.since);
    let stop = at(event.till);
    if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) continue;
    // A programme running past midnight is given the next day's date by the
    // page itself, so this only guards against a stamp pair that disagrees.
    if (stop <= start) stop = new Date(start.getTime() + HOUR_MS);

    const slot = `${id}|${event.since}`;
    if (seen.has(slot)) continue;
    seen.add(slot);

    // Episode numbers are carried as the string "$undefined" when absent,
    // which is React's marker for a value it did not serialise.
    const real = (value) => (typeof value === "string" && value !== "$undefined" ? value : null);
    const desc = real(event.description);
    const episode = real(event.episode);

    programmes.push(
      xmltvProgramme({
        channel: id,
        start,
        stop,
        title: event.title,
        desc: episode && desc ? `${episode}. ${desc}` : (desc ?? episode),
        lang: "is",
      })
    );
  }

  if (!programmes.length) throw new Error("no programmes survived parsing");
  return `<tv>\n${channels.join("\n")}\n${programmes.join("\n")}\n</tv>`;
};
