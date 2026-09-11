// Working out which of my provider's channels each source channel is, in five
// passes of falling confidence, and rewriting the source's ids to the
// provider's so TiviMate matches on its first step.
//
// This is where a mistake puts one channel's schedule on another — the one
// thing this project treats as worse than an empty row — so it lives apart
// from the run that drives it, and is tested. build-epg.mjs holds the source
// list and the merge; everything about deciding what a channel *is* is here.

import { CHANNEL, DISPLAY_NAME, PROGRAMME, attr, escapeAttr, isPlaceholder, parseTime } from "./epg-xml.mjs";
import { EVENT_NAME } from "./events.mjs";
import {
  baseKey,
  bodyOf,
  ccOf,
  idKey,
  nameKey,
  providerCc,
  scopedBaseKey,
  scopedKey,
} from "./keys.mjs";
import { PLUS_ONE } from "./timeshift.mjs";

// The escape hatch, and deliberately a short one: provider ids mapped to extra
// channel names that should also find them.
//
// Everything else here is a rule. These are the rows no rule can reach: my
// provider numbers its 4K simulcasts ("BBC One 1 HDR 4K") and gives them no id,
// so the only thing linking them to BBC One is the number being a feed index
// rather than part of the name. A rule that dropped that digit would also turn
// Sweden's TV24 into TV 2, which is a different channel — so this is a list
// instead. Keep it short; if it grows, the rules are wrong.
//
// A Map rather than an object literal, because the keys are provider ids: an id
// of "constructor" would read a function off the prototype chain, and iterating
// that would cost the source its whole output.
export const ALSO_KNOWN_AS = new Map([["BBCOne.uk", ["UK: BBC One 1 HDR 4K", "UK: BBC One 2 HDR 4K"]]]);

// Whether the list above still describes the playlist. A hand-written table is
// the only thing here that can silently stop applying — a renamed row or a
// retired id makes an entry a no-op with no error anywhere — so every run says
// so. Warns rather than fails: an entry going stale costs two channels their
// guide, which is not worth refusing a whole publish over.
export const checkAliasList = (channels) => {
  const ids = new Set(channels.map((ch) => ch.epg_channel_id).filter(Boolean));
  const names = new Set(channels.map((ch) => ch.name).filter(Boolean));
  for (const [id, aliases] of ALSO_KNOWN_AS) {
    if (!ids.has(id)) console.error(`ALSO_KNOWN_AS: no channel carries the id "${id}" any more`);
    for (const name of aliases)
      if (!names.has(name)) console.error(`ALSO_KNOWN_AS: no channel is named "${name}" any more`);
  }
};

// Builds every lookup the passes below need, in one walk of the provider's
// channel list. Five of them match a source channel to a provider id; `aliases`
// holds the names of rows that have no id at all, and `targetCc` remembers
// which country each id belongs to.
export const buildIndex = (channels) => {
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map();
  const byScoped = new Map();
  const byScopedBase = new Map();
  const aliases = new Map();
  const targetCc = new Map();
  // A row with no id, next to a row with one that normalises to the same name,
  // is the same channel packaged differently — a backup feed, a P50 variant, an
  // app duplicate. My provider says so itself by naming them alike, so the
  // id-less one is advertised on the channel its sibling already reaches.
  //
  // One donor per name, first seen, where every other index here holds a set.
  // That is a choice, not an oversight: where several ids share a name, letting
  // the orphan inherit from all of them would advertise one name on several
  // channels, and a player then picks between them. One channel, even if a
  // better sibling existed, beats a name that means two things.
  const donors = new Map();
  const orphans = [];
  const inherited = new Map();
  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  // A "+1" row whose id normalises to the same key as a base row's, without
  // being the same string. My provider gives "UK: 5 Usa  1" the id "5USA.uk"
  // and "UK: 5 Usa" the id "5 USA.uk", and idKey collapses the space away, so
  // one source channel claimed both and the +1 row published the base
  // channel's schedule unshifted — an hour early, every programme, with
  // nothing to say so. Leaving the id unindexed means no source claims it and
  // timeshift.mjs fills the row properly instead.
  //
  // Scoped to that collision on purpose. The seven rows whose id IS a real
  // upstream +1 feed ("E4+1.uk", "ITV3+1.uk") key differently from their base
  // and keep matching, and where the provider hands a +1 row its base id
  // verbatim ("UK: Channel 5  1") nothing here can tell the two apart.
  const shadowed = new Set();
  const baseIds = new Map();
  for (const ch of channels)
    if (ch.epg_channel_id && ch.name && !PLUS_ONE.test(ch.name))
      add(baseIds, idKey(ch.epg_channel_id), ch.epg_channel_id);
  for (const ch of channels) {
    if (!ch.epg_channel_id || !ch.name || !PLUS_ONE.test(ch.name)) continue;
    const sharing = baseIds.get(idKey(ch.epg_channel_id));
    if (sharing && [...sharing].some((id) => id !== ch.epg_channel_id))
      shadowed.add(ch.epg_channel_id);
  }

  for (const ch of channels) {
    const target = ch.epg_channel_id;
    const cc = providerCc(ch);

    if (!target) {
      // No id means TiviMate can only ever match this row on the channel name,
      // so remember the name and emit it as an extra <display-name>. Keyed by
      // country, or the Vietnamese Animal Planet would collect a Nordic one.
      if (ch.name) {
        add(aliases, scopedKey(cc, ch.name), ch.name);
        add(aliases, scopedBaseKey(cc, ch.name), ch.name);
        // Per-event channels are the event pass's job, not a sibling's.
        if (!EVENT_NAME.test(ch.name)) orphans.push(ch);
      }
      continue;
    }

    // Deliberately unreachable by any source, so the timeshift pass fills it.
    if (shadowed.has(target)) continue;

    targetCc.set(target, cc);
    add(byId, idKey(target), target);
    if (!ch.name) continue;
    const sibling = scopedBaseKey(cc, ch.name);
    if (sibling && !donors.has(sibling)) donors.set(sibling, target);
    add(byName, nameKey(ch.name), target);
    add(byBase, baseKey(ch.name), target);

    // Index the id's own body too — it is often the better name carrier,
    // "AandE Network (East).us" naming the channel that "US: A&E HD" is.
    for (const label of [ch.name, bodyOf(target)]) {
      add(byScoped, scopedKey(cc, label), target);
      add(byScopedBase, scopedBaseKey(cc, label), target);
    }
  }
  for (const ch of orphans) {
    const donor = donors.get(scopedBaseKey(providerCc(ch), ch.name));
    if (donor) add(inherited, donor, ch.name);
  }

  return { byId, byName, byBase, byScoped, byScopedBase, aliases, targetCc, inherited };
};

// Source channels carrying at least one real programme. Anything else must not
// claim a target. This is a separate scan of the source rather than one pass
// that keeps every programme: holding a million programme strings costs more
// than re-reading a string that can be 500 MB.
const channelsWithData = (xml) => {
  const withData = new Set();
  for (const [element] of xml.matchAll(PROGRAMME)) {
    if (isPlaceholder(element)) continue;
    const channel = attr(element, "channel");
    if (channel) withData.add(channel);
  }
  return withData;
};

const firstHit = (labels, lookup) => {
  for (const label of labels) {
    const hit = lookup(label);
    if (hit) return hit;
  }
  return undefined;
};

// `cc` is the country a source declares for itself, for the files whose channel
// ids carry none — epg.pw numbers its channels "9121". Without it ccOf() finds
// nothing, so pass 3 is skipped for every channel in the file and the whole
// source matches nothing at all: 756 UK channels, none of them reachable.
export const convert = (xml, index, { passthrough, borrow, cc: declared, advertised } = {}) => {
  const { byId, byName, byBase, byScoped, byScopedBase, aliases, targetCc, inherited } = index;
  const withData = channelsWithData(xml);

  // Labels and ids are read once here, because everything below walks this
  // list five more times and re-parsing each element that often was pure waste.
  const elements = [];
  for (const [element] of xml.matchAll(CHANNEL)) {
    const sourceId = attr(element, "id");
    if (!sourceId || !withData.has(sourceId)) continue;
    const names = [...element.matchAll(DISPLAY_NAME)].map((m) => m[1].trim());
    elements.push({ element, sourceId, names, labels: [bodyOf(sourceId), ...names] });
  }

  const resolved = new Map(); // source id -> Set of target ids
  const claimed = new Set();

  // Every pass adds to what earlier passes found rather than skipping a
  // channel that is already resolved: my provider often has two ids for one
  // channel, "TNT Sports 3.uk" alongside "TNTSports3 HD.uk", and only one of
  // them matches exactly. Claimed targets are never revisited, so a loose
  // match still cannot steal what something else matched precisely.
  // Which targets are the provider's own ids, as opposed to a source id that
  // pass 4 or passthrough keeps as-is. Only the provider can re-point one of
  // its ids at a different channel, so only these need re-checking when a
  // cached copy is replayed days later. Marking them matters: checking all of
  // them cost the US sports fallback 30 of its 31 channels, those being
  // matched by name and so carrying the source's ids, not the provider's.
  const fromProvider = new Set();

  const take = (sourceId, found) => {
    const targets = new Set([...(found ?? [])].filter((t) => !claimed.has(t)));
    if (!targets.size) return;
    const already = resolved.get(sourceId);
    if (already) for (const t of targets) already.add(t);
    else resolved.set(sourceId, targets);
    for (const t of targets) {
      claimed.add(t);
      fromProvider.add(t);
    }
  };

  // Pass 1: exact ids and names. The ?? chain stops at the first lookup that
  // returns anything, even if take() then finds every target already claimed —
  // an exact id hit that lost the race is not a reason to go looking by name.
  for (const { sourceId, names } of elements) {
    take(
      sourceId,
      byId.get(idKey(sourceId)) ??
        byName.get(nameKey(sourceId)) ??
        firstHit(names, (name) => byName.get(nameKey(name)))
    );
  }

  // Pass 2: feed-variant fallback, so "RUV 2 HD" can feed "RUV 2 FHD".
  for (const { sourceId, names } of elements) {
    take(
      sourceId,
      byBase.get(baseKey(sourceId)) ?? firstHit(names, (name) => byBase.get(baseKey(name)))
    );
  }

  // Pass 3: my provider's ids come from a different vendor than epgshare's, so
  // for most countries the name is the only thing the two sides share. Country
  // is part of the key, so this cannot match across countries — except the one
  // a source explicitly declares it may `borrow`.
  for (const { sourceId, labels } of elements) {
    for (const cc of [ccOf(sourceId) || declared, borrow]) {
      if (!cc) continue;
      take(
        sourceId,
        firstHit(labels, (label) => byScoped.get(scopedKey(cc, label))) ??
          firstHit(labels, (label) => byScopedBase.get(scopedBaseKey(cc, label)))
      );
    }
  }

  // Pass 4: rows with an empty id can never match on TiviMate's first step, but
  // its third step compares the channel name against <display-name> — so the
  // guide carries my provider's own names for them. Country-scoped like pass 3,
  // or the Vietnamese Animal Planet would collect a Nordic schedule.
  // A name an earlier source already advertises is not offered again. One
  // provider name has to mean one channel: two channels carrying it leaves a
  // player choosing between them, and both are the same channel from different
  // upstreams with different schedules, so the choice is silent and arbitrary.
  // Adding epg.pw took this from 2 rows to 27 before the check existed, all of
  // them leftovers it claimed on a name an earlier source was already serving.
  const aliasNames = (labels, cc) => {
    const names = new Set();
    if (!cc) return names;
    for (const label of labels)
      for (const name of [
        ...(aliases.get(scopedKey(cc, label)) ?? []),
        ...(aliases.get(scopedBaseKey(cc, label)) ?? []),
      ])
        if (!advertised?.has(name)) names.add(name);
    return names;
  };

  // Whatever is still unclaimed, emitted under its own id — the id is
  // irrelevant here, since these are matched by name. Either a row with no id
  // wants this channel, or the source is passthrough and keeps everything.
  for (const { sourceId, labels } of elements) {
    if (resolved.has(sourceId)) continue;
    const wanted = [ccOf(sourceId) || declared, borrow].some((cc) => aliasNames(labels, cc).size);
    if (wanted || passthrough) resolved.set(sourceId, new Set([sourceId]));
  }

  // Scoped to the country of the id being emitted, not of the source channel,
  // so a schedule never reaches a same-named channel in another market.
  const withAliases = (element, labels, target) => {
    const names = aliasNames(labels, targetCc.get(target) ?? ccOf(target));
    for (const name of ALSO_KNOWN_AS.get(target) ?? []) names.add(name);
    for (const name of inherited.get(target) ?? []) names.add(name);
    if (!names.size) return element;
    const extra = [...names].map((n) => `\n    <display-name>${escapeAttr(n)}</display-name>`).join("");
    return element.endsWith("/>")
      ? `${element.replace(/\s*\/>$/, ">")}${extra}\n  </channel>`
      : element.replace(/<\/channel>$/, `${extra}\n  </channel>`);
  };

  const channels = [];
  for (const { element, sourceId, labels } of elements) {
    for (const target of resolved.get(sourceId) ?? [])
      channels.push({
        id: target,
        fromProvider: fromProvider.has(target),
        element: withAliases(element, labels, target).replace(
          /\bid="[^"]*"/,
          `id="${escapeAttr(target)}"`
        ),
      });
  }

  const programmes = [];
  for (const [element] of xml.matchAll(PROGRAMME)) {
    if (isPlaceholder(element)) continue;
    // Some upstream files carry a programme that ends before it starts, or at
    // the same instant, or with a stamp nothing can read. All three are dropped
    // here rather than left for the gate: the gate refuses the whole publish,
    // and one bad row from an upstream nobody here controls is not worth the
    // rest of the grid going unrefreshed.
    const from = parseTime(attr(element, "start") ?? "");
    const to = parseTime(attr(element, "stop") ?? "");
    if (!(to > from)) continue;
    for (const target of resolved.get(attr(element, "channel")) ?? [])
      programmes.push({
        channel: target,
        element: element.replace(/\bchannel="[^"]*"/, `channel="${escapeAttr(target)}"`),
      });
  }

  return { channels, programmes };
};
