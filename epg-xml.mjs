// XMLTV shapes and the small helpers shared by the builder and its validator,
// so the thing that checks the guide cannot drift from the thing that writes it.

export const CHANNEL = /<channel\b[^>]*?>[\s\S]*?<\/channel>|<channel\b[^>]*?\/>/g;
export const PROGRAMME = /<programme\b[^>]*?>[\s\S]*?<\/programme>|<programme\b[^>]*?\/>/g;
export const DISPLAY_NAME = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/;

// Built once per attribute name and reused: attr() runs on every programme of
// every source, and compiling the pattern per call was the hottest waste here.
const patterns = {};

export const attr = (element, name) => {
  patterns[name] ??= new RegExp(`\\b${name}="([^"]*)"`);
  const m = patterns[name].exec(element);
  return m ? m[1] : null;
};

// Safe for element text as well as attribute values.
export const escapeAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Shared so the four places that shift or measure an hour agree on one number.
export const HOUR_MS = 3_600_000;

export const mb = (bytes, digits = 1) => `${(bytes / 1048576).toFixed(digits)} MB`;

// Cache ages, in hours: a copy standing in for a failed source is usually less
// than a day old, and "0.4 days" tells a reader less than "10h" does.
export const hours = (days) => `${Math.round(days * 24)}h`;

// Iceland is UTC+0 all year, and every source here publishes in it, so the
// offset is a constant rather than something to carry around.
const xmltvTime = (date) => `${date.toISOString().replace(/\D/g, "").slice(0, 14)} +0000`;

// The other direction: an XMLTV stamp back to a millisecond count, NaN if it is
// not one. Shared so the builder and the gate agree on what a stamp means.
// "20260909095000 +0000", where the offset is optional and defaults to UTC.
export const parseTime = (stamp) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(stamp.trim());
  if (!m) return NaN;
  const [, year, month, day, hour, minute, second, zone = "+0000"] = m;
  return Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}${zone.slice(0, 3)}:${zone.slice(3)}`
  );
};

// Emitters for the sources that publish JSON rather than XMLTV. Element order
// follows the DTD — title, desc, then category — because some readers care.
export const xmltvChannel = (id, names) =>
  `<channel id="${escapeAttr(id)}">\n` +
  names
    .filter(Boolean)
    .map((name) => `    <display-name>${escapeAttr(name)}</display-name>\n`)
    .join("") +
  `  </channel>`;

export const xmltvProgramme = ({ channel, start, stop, title, desc, categories = [], lang }) => {
  const tag = (name, text) =>
    `    <${name}${lang ? ` lang="${lang}"` : ""}>${escapeAttr(text)}</${name}>\n`;
  return (
    `<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="${escapeAttr(channel)}">\n` +
    tag("title", title) +
    (desc ? tag("desc", desc) : "") +
    categories.filter(Boolean).map((category) => tag("category", category)).join("") +
    `  </programme>`
  );
};


// iptv-epg.org fills channels it has no schedule for with hourly filler, and
// its sports feeds with "No EVENT Today". Left alone that is worse than an
// empty channel: the filler claims the id, so no other source can serve it and
// my provider's own EPG never shows through either.
const PLACEHOLDER =
  /^(no data|no event today|no information|no programme|tba|to be announced|n\/a|-|dagskrárlok)$/i;

// The programme's title, or "" — used both to spot filler and, in the merge,
// to tell one programme from another in the same slot.
export const titleOf = (element) => (TITLE.exec(element) ?? [])[1]?.trim() ?? "";

export const isPlaceholder = (element) =>
  PLACEHOLDER.test(titleOf(element));
