// My provider names its per-event channels after the event itself and gives
// them no id:
//
//   [Viaplay IS] (9/9) 13:55 Liverpool - Atlético Madrid
//   [Livey] (9/9) 16:35 Aalborg Handbold - Paris Saint-Germain
//
// No guide will ever carry those, but the name already IS the schedule, so it
// gets read back out. This is the only place the output contains programmes no
// source published — they are my provider's own strings, reshaped — and it is
// playlist-wide, not Icelandic: some 45 services name channels this way.
//
// Unlike the fetched sources this produces the merge shape directly rather than
// XMLTV text, because there is nothing to match: the channel is emitted under
// its own id and found by name.

import { HOUR_MS, xmltvChannel, xmltvProgramme } from "./epg-xml.mjs";
import { getJson } from "./http.mjs";
import { nameKey } from "./keys.mjs";

export const EVENT_NAME = /^\[(?:[^\]]+)\]\s*\((\d{1,2})\/(\d{1,2})\)\s*(\d{1,2}):(\d{2})\s+(\S.*)$/;

// The name gives no end time.
const ASSUMED_HOURS = 3;
// The playlist only ever carries near-term fixtures, and the furthest seen is
// about seven weeks out. Anything beyond this is the year guess below picking
// the wrong year for a row the playlist never cleared out, so it is dropped
// rather than published as a fixture months away.
const PLAUSIBLE_DAYS = 60;
// How far ahead to ask Viaplay for real end times.
const HORIZON_DAYS = 10;

// Real end times are a refinement, not the schedule, so the walk that fetches
// them gets a fixed share of the run and no more. Without this an unresponsive
// Viaplay costs the whole job: the walk is dozens of requests, each of which
// may retry, which together outlast the workflow's own timeout — and an
// upstream failing is supposed to cost that upstream's contribution, not the
// guide. Individual requests are kept short for the same reason.
const VIAPLAY_BUDGET_MS = 120_000;
const VIAPLAY_REQUEST = { timeoutMs: 15_000, attempts: 2 };

// A day and month with no year means the year that puts the date nearest today.
const eventStart = (day, month, hour, minute) => {
  const now = Date.now();
  const thisYear = new Date(now).getUTCFullYear();
  const nearest = [-1, 0, 1]
    .map((shift) => Date.UTC(thisYear + shift, month - 1, day, hour, minute))
    .reduce((best, at) => (Math.abs(at - now) < Math.abs(best - now) ? at : best));
  return new Date(nearest);
};

// Viaplay is pure streaming, so its API has no channel field and cannot be a
// source of its own. What it does have is the real end of every fixture, which
// is worth borrowing: a baseball game that actually runs 330 minutes should not
// be published as a flat three-hour block.
const VIAPLAY_SPORT = "https://content.viaplay.is/pcdash-is/sport";

const viaplayEnds = async (days) => {
  const ends = new Map();
  const collect = (blocks) => {
    for (const block of blocks ?? [])
      for (const product of block._embedded?.["viaplay:products"] ?? []) {
        const { start, end } = product.epg ?? {};
        const title = product.content?.title;
        if (!start || !end || !title) continue;
        const stop = new Date(end);
        if (Number.isNaN(stop.getTime())) continue;
        // Keyed on Viaplay's own start string; the lookup formats a Date the
        // same way. If they ever change that shape every lookup simply misses
        // and the fixed block stands, which the build logs as a count.
        ends.set(`${nameKey(title)}|${start.slice(0, 16)}`, stop);
      }
  };

  const deadline = Date.now() + VIAPLAY_BUDGET_MS;

  for (let day = 0; day < days && Date.now() < deadline; day++) {
    const date = new Date(Date.now() + day * 24 * HOUR_MS).toISOString().slice(0, 10);
    try {
      const page = await getJson(`${VIAPLAY_SPORT}?date=${date}`, VIAPLAY_REQUEST);
      const blocks = page._embedded?.["viaplay:blocks"] ?? [];
      collect(blocks);

      // Any block can be paginated, and which one is longest changes daily, so
      // follow every one that says it has more rather than guessing by title.
      for (const block of blocks) {
        const href = block._links?.self?.href;
        for (let number = 2; href && number <= (block.pageCount ?? 1); number++) {
          if (Date.now() > deadline) break;
          const url = href.replace(/pageNumber=\d+/, `pageNumber=${number}`);
          const more = await getJson(url, VIAPLAY_REQUEST);
          collect(more._embedded?.["viaplay:blocks"] ?? [more]);
        }
      }
    } catch {
      // Viaplay being unreachable just means the assumed block stands.
    }
  }
  return ends;
};

export const eventGuide = async (providerChannels) => {
  const realEnds = await viaplayEnds(HORIZON_DAYS);
  const channels = [];
  const programmes = [];
  let borrowed = 0;

  // The playlist repeats some fixtures verbatim, and nameKey drops punctuation
  // so two near-identical names can land on one id. Deduplicating on the id
  // rather than the name covers both: otherwise the second row emits no channel
  // but still emits a programme, and the first channel lists it twice.
  const taken = new Set();

  for (const ch of providerChannels) {
    if (ch.epg_channel_id) continue; // a real id means a real source can serve it
    const match = EVENT_NAME.exec(ch.name ?? "");
    if (!match) continue;

    const id = `event.${nameKey(ch.name)}`;
    if (taken.has(id)) continue;
    taken.add(id);

    const [, day, month, hour, minute, event] = match;
    const start = eventStart(+day, +month, +hour, +minute);
    const title = event.trim();

    const real = realEnds.get(`${nameKey(title)}|${start.toISOString().slice(0, 16)}`);
    const stop = real && real > start ? real : new Date(start.getTime() + ASSUMED_HOURS * HOUR_MS);
    if (real && real > start) borrowed++;

    if (stop.getTime() < Date.now()) continue; // a fixture the playlist never cleared out
    if (start.getTime() - Date.now() > PLAUSIBLE_DAYS * 24 * HOUR_MS) continue; // wrong year

    channels.push({ id, element: xmltvChannel(id, [ch.name]) });
    programmes.push({
      channel: id,
      element: xmltvProgramme({ channel: id, start, stop, title }),
    });
  }
  return { channels, programmes, borrowed };
};
