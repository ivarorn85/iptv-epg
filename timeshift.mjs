// A "+1" channel is its base channel an hour later, so where the base has a
// schedule the +1 schedule is derivable rather than fetchable. It runs last,
// after every other producer, because it copies from what they emitted.
//
// Copying a sibling's schedule wholesale to every other empty row was tried and
// rejected: it filled 328 channels but added 37,000 duplicate programmes and
// took the guide from 62 MB to 99 MB, nearly all of it rows for channels that
// already had a schedule under a different id.

import { HOUR_MS, escapeAttr, xmltvChannel } from "./epg-xml.mjs";
import { nameKey, providerCc, scopedBaseKey } from "./keys.mjs";

// My provider writes the timeshift as a trailing "1" after a double space —
// "UK: FILM 4  1" — which is how it differs from a channel number: "UK: Coral
// TV 2" has one space and is a different channel, not a timeshift. Anchored at
// the end, so "UK: GOLD  1 HD" is not recognised; that is a miss rather than
// wrong data, and no row in the playlist is written that way today.
const PLUS_ONE = /\s{2,}1$/;

// Advances the wall clock an hour and keeps the original offset, which is the
// same instant either way and leaves the stamp looking like its neighbours.
//
// Null rather than the input when the stamp is not the full 14 digits XMLTV
// allows but nobody here writes. Returning it unshifted would publish a whole
// day an hour wrong, or move a start without its stop and emit a programme
// ending before it begins — both of them silent, on a channel that looks
// filled. Failing is the cheaper mistake.
export const anHourLater = (stamp) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(.*)$/.exec(stamp);
  if (!m) return null;
  const [, year, month, day, hour, minute, second, zone] = m;
  const at = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) + HOUR_MS);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}${zone}`
  );
};

// Shifts both stamps of one programme element, or nothing if either will not
// shift — a half-shifted programme is worse than an absent one.
const shifted = (element, id) => {
  const from = anHourLater(/\bstart="([^"]*)"/.exec(element)?.[1] ?? "");
  const to = anHourLater(/\bstop="([^"]*)"/.exec(element)?.[1] ?? "");
  if (!from || !to) return null;
  return element
    .replace(/\bstart="[^"]*"/, `start="${from}"`)
    .replace(/\bstop="[^"]*"/, `stop="${to}"`)
    .replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(id)}"`);
};

// Takes the provider's channel list and the programmes every other producer
// emitted, keyed by channel, and returns the merge shape: the +1 rows that can
// be filled, plus a count of programmes that would not shift.
export const timeshiftGuide = (providerChannels, programmesByChannel) => {
  const bases = new Map();
  for (const ch of providerChannels) {
    if (!ch.name || !programmesByChannel.has(ch.epg_channel_id)) continue;
    const key = scopedBaseKey(providerCc(ch), ch.name);
    if (key && !bases.has(key)) bases.set(key, ch.epg_channel_id);
  }

  const channels = [];
  const programmes = [];
  const taken = new Set();
  let unshiftable = 0;

  for (const ch of providerChannels) {
    if (!ch.name || !PLUS_ONE.test(ch.name)) continue;
    if (programmesByChannel.has(ch.epg_channel_id)) continue; // has a schedule of its own
    const base = bases.get(scopedBaseKey(providerCc(ch), ch.name.replace(PLUS_ONE, "")));
    if (!base) continue;

    // Matched by name, so the id only has to be unique. Namespaced separately
    // from every other synthetic id, or a same-named row elsewhere takes it and
    // this one is silently dropped.
    const id = `plus1.${nameKey(ch.name)}`;
    if (taken.has(id)) continue;
    taken.add(id);

    channels.push({ id, element: xmltvChannel(id, [ch.name]) });
    for (const element of programmesByChannel.get(base)) {
      const moved = shifted(element, id);
      if (moved) programmes.push({ channel: id, element: moved });
      else unshiftable++;
    }
  }
  return { channels, programmes, unshiftable };
};
