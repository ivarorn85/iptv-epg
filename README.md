# iptv-epg

Builds one merged XMLTV guide whose channel ids already match my IPTV
provider's, so TiviMate fills the grid on its own instead of needing hundreds of
channels mapped by hand. A GitHub Action rebuilds it twice a day and publishes
it as a release asset; nothing needs touching in between.

The numbers throughout are from my playlist. Anyone reusing this will get
different ones — the matching rules are general, but which channels exist and
which upstream carries them is not.

## The problem

TiviMate matches a channel to guide data in three strict steps: `tvg-id` against
`<channel id>` (exact and case-sensitive), then `tvg-name`, then the channel name
against `<display-name>`. There is no normalisation and no fuzzy matching.

That strictness is the whole difficulty. My provider writes `BBC Four HD.uk`;
epgshare01 writes `BBC.Four.HD.uk`. Same channel, no match, empty grid. So this
script collapses both sides to a common key, works out which provider channel
each source channel is, and rewrites the guide's ids to the provider's — so
TiviMate succeeds on step one and never has to guess.

## Setup

1. Create a **public** repo — public so TiviMate can read the release without a
   token — and push:

   ```
   build-epg.mjs        source list, merge, and the run itself
   match.mjs            the five matching passes and the provider index
   iceland.mjs          the two Icelandic broadcasters' JSON APIs
   siminn.mjs           Sjónvarp Símans' seven-day guide, read off its page
   events.mjs           per-event channels read out of their own names
   timeshift.mjs        "+1" channels, derived from their base channel
   cache.mjs            each source's last good output, for when one fails
   keys.mjs             how a channel on one side is matched to the other
   epg-xml.mjs          shared XMLTV shapes, emitters and small helpers
   http.mjs             one place for the User-Agent, timeouts and retries
   check-guide.mjs      the publish gate
   test/                run with `node --test`; no test runner to install
   status.json          what the last run published — the gate's baseline
   README.md
   .gitignore
   .gitattributes       keeps the guide binary and the sources LF
   .github/workflows/build-epg.yml
   ```

2. Allow the workflow to write: **Settings → Actions → General → Workflow
   permissions → Read and write**. New repos default to read-only, and without
   this the publish step fails with a 403.

3. Add three repository secrets under **Settings → Secrets and variables →
   Actions**:

   | Secret        | Value                                        |
   | ------------- | -------------------------------------------- |
   | `XTREAM_HOST` | `http://example.com:8080`, no trailing slash |
   | `XTREAM_USER` | username                                     |
   | `XTREAM_PASS` | password                                     |

   `gh secret set XTREAM_PASS` prompts with hidden input, which beats pasting a
   password into a browser form. The credentials never reach the output: the
   published guide holds channel ids and programme data and nothing else.

4. Check that failure mail is on, at github.com/settings/notifications →
   Actions. It is the only thing standing between you and a silently stale
   guide.

5. Run it once by hand — **Actions → Build EPG → Run workflow** — and compare
   the per-source counts in the log against the baseline below.

6. Add the release URL in TiviMate under **Settings → EPG → add source**:

   ```
   https://github.com/USER/REPO/releases/download/epg/guide.xml.gz
   ```

   The tag is fixed, so that URL never changes. Give it higher priority than the
   provider's own EPG, then **Settings → EPG → Update EPG**.

7. Leave the provider's own EPG enabled underneath. Two thirds of my playlist is
   event feeds with no id and no published schedule anywhere, and the provider's
   own guide is the only thing that can ever fill those.

Once Icelandic channels look right, the old `is-epg.run.place` source can come
out of TiviMate — it is merged into this file.

## How the matching works

Five passes, in falling order of confidence. Each pass only adds to what earlier
passes found, and a target already claimed is never revisited — so a loose match
can never steal a channel that something else matched precisely.

**Pass 1 — exact ids and names.** Both sides are reduced to the same key:

- `epg_channel_id`: strip `.`, spaces, `_` and `-`, lowercase, keep the country
  suffix. `BBC.Four.HD.uk` and `BBC Four HD.uk` both become `bbcfourhd|uk`.
  epgshare splits big countries across numbered files and suffixes the ids to
  match, so the ordinal in `.us2` is dropped — it names the file, not the
  country.
- Channel name: strip everything that is not a letter or digit and lowercase, so
  `IS: RUV FHD` becomes `isruvfhd`. Icelandic characters survive. `+` becomes
  the word `plus`, because it is the only thing separating `TV3+` from `TV3` —
  without that, Danish TV3's schedule lands on TV3+ as well.
- Then the same against each `<display-name>` in the source.

**Pass 2 — feed-variant fallback.** Drops trailing variants, so `IS: RUV 2 HD`
can feed `IS: RUV 2` and `IS: RUV 2 FHD`, neither of which has an `HD` variant
in my playlist. Variants stack, so they come off in a loop — `hd` `fhd` `uhd`
`sd` `4k` `hdr` `p50` `2160p` `1080p`, plus a trailing `A`/`B` backup-feed
letter when a variant precedes it. That is what reaches
`Sky Sport Main Event UHD 4K B` and `TNT Sports 1 FHD P50`. My provider also
writes "Sky Sport" where epgshare writes "Sky Sports", so `sports` folds to
`sport` in this looser key only.

**Pass 3 — country-scoped names.** My provider's ids come from a different
vendor than epgshare's, so outside the UK they barely overlap and the name is
the only thing the two sides share:

```
UK: Sky Sport Main Event UHD 4K -> SkySpMainEvHD.uk    epgshare: Sky.Sports.Main.Event.HD.uk
DK: DR 1 HD                     -> DR1 Denmark (DK,DA).dk
SE: SVT 1 FHD                   -> SVT1 HD (T).se
US: A&E HD                      -> AandE Network (East).us
```

So this pass strips the labelling each side adds — my provider's `US:` country
prefix, epgshare's `[MTVSWHD]` headend codes, and annotations like `(DK,DA)`,
`(T)` and `(East)` — and matches on what is left. The country is part of the
key, so a UK channel can never claim the US entry of the same name. It also
matches against the provider id's own body, which is often the better name
carrier: `AandE Network (East).us` names the channel that `US: A&E HD` is.

This pass is what makes everything outside the UK work at all. Without it, US,
Denmark, Norway and Sweden matched zero channels between them.

One provider name is only ever offered on one channel. A later source may not
advertise a name an earlier one already answers to: both would be the same
channel from different upstreams with different schedules, so a player would
choose between them silently. Adding epg.pw took the count of rows exposed to
that from 2 to 27 before this existed; with it, the guide is 81 channels and
5,157 programmes smaller and serves **exactly the same 4,767 playlist rows**.

A source whose ids carry no country at all declares one with `cc`. epg.pw
numbers its channels — `9121` — so `ccOf` finds nothing, this pass is skipped
for every channel in the file, and the whole source matches nothing: 756 UK
channels, none of them reachable. `cc` applies only where the id is silent, so
it can never override a country an id does state.

A source may also declare `borrow: "<country>"` to serve one other country's
entries. Only the Nordic sources do, for Iceland: my provider's Icelandic
entries for international channels carry the Nordic feed, and only DK/NO/SE
publish them. Never UK or US — those are a different regional schedule, and
wrong programmes are worse than none.

**Pass 4 — names for the rows that have no id.** A row with an empty
`epg_channel_id` can never match on step one, but TiviMate's third step compares
the channel name against `<display-name>`. So the guide carries my provider's
own channel names as extra display-names, which is the only reason
`UK: TNT Sports 5 FHD` and the `US: NHL ...` feeds show anything at all. These
are country-scoped like pass 3 — without that, the Vietnamese Animal Planet
collects a Nordic schedule.

**Pass 5 — events read out of their own names.** My provider names its per-event
channels after the event, and gives them no id:

```
[Viaplay IS] (9/9) 13:55 Liverpool - Atlético Madrid
[Livey] (9/9) 16:35 Aalborg Handbold - Paris Saint-Germain
```

No guide will ever carry those, but the name already _is_ the schedule, so it
gets read back out into a channel and one programme. The date is day/month, the
time is Icelandic local which is UTC, and the year is whichever puts the date
nearest today. Fixtures that have already finished are skipped — the playlist
keeps stale ones for months.

The name gives no end time, so each event gets a fixed three-hour block —
except where Viaplay knows better. Viaplay's own API is no use as a source
(every fixture is its own stream, with no channel to key on), but it does
publish the real end of each one, and matching on title plus start time reaches
most of the `[Viaplay IS]` channels. That turns a flat three hours into the
truth: a 45-minute goal show stays 45 minutes, and a baseball game that runs 330
does not go blank two and a half hours in. Anything it does not know keeps the
fixed block.

This is the one place the guide contains programmes no source published. They
are the provider's own strings, reshaped. Around 850 channels come from it,
across `[Livey]`, `[Viaplay IS]`, `[DisneyIS]`, `[Svensk]`, `[HBO Max UK]` and
some 45 other services that name channels the same way. `IS: Sýn Besta Deildin 1`
and friends are **not** reachable this way — those names carry no fixture or
time.

### Rows with no id, filled by a sibling

A row with no `epg_channel_id`, sitting next to a row that has one and whose
name normalises the same way, is the same channel packaged differently. My
provider says so itself by naming them alike:

```
UK: Sky Sport 1 UHD 4K B      <- UK: Sky Sport 1 UHD 4K        SkySp F1 HD.uk
UK: TNT Sports 1 FHD P50      <- UK: TNT Sports 1 FHD          TNT Sports 1.uk
UK: Sky Sport Golf (SkyGo)    <- UK: Sky Sport Golf FHD P50    SkySp Golf HD.uk
SE: V Series FHD              <- SE: V Series HD               V series HD (T).se
```

So the id-less row's name is advertised on the channel its sibling already
reaches — backup feeds, P50 variants and app duplicates all resolve without a
single hand-written mapping. That is 438 rows across 199 donor channels. Per-event channels are excluded,
being the event pass's job.

### "+1" channels, derived rather than fetched

A "+1" channel is its base channel an hour later, so where the base has a
schedule the +1 schedule does not need fetching. My provider writes it as a
trailing "1" after a _double_ space — `UK: FILM 4  1` — which is what separates
it from a channel number: `UK: Coral TV 2` has one space and is a different
channel. The base channel's programmes are copied with both timestamps moved an
hour, keeping their original offset. That reaches `Film 4 +1`, `GOLD +1`,
`TLC +1`, `More 4 +1`, `Alibi +1` and `5 Star +1`.

Copying a sibling's schedule _unshifted_ to every other empty row was tried and
rejected. It filled 328 channels but added 37,000 duplicate programmes and took
the guide from 62 MB to 99 MB, nearly all of it second rows for channels that
already had a schedule under another id.

`baseKey` also folds a standalone number word to its digit, so `BBC One` and
`BBC 1` are one channel. Only a whole word counts — otherwise Vodafone would
fold to `vodaf1`.

### The one manual list

`ALSO_KNOWN_AS` in `build-epg.mjs` maps a provider id to extra channel names
that should also find it. It exists for rows no rule can reach: my provider
numbers its 4K simulcasts — `UK: BBC One 1 HDR 4K`, `UK: BBC One 2 HDR 4K` —
and gives them no id, so the only thing tying them to BBC One is knowing that
the number is a feed index rather than part of the name.

I measured the rule that would automate it (drop a trailing digit when the name
carries a 4K/UHD/HDR marker). Across the whole playlist it matched exactly one
row, and matched it wrongly: Sweden's `TV24 UHD` became `TV 2`, a different
channel. So this is a list instead. Keep it short — if it grows, the rules are
wrong.

Being hand-written, it is also the one thing here that can stop applying with no
error anywhere: a renamed row or a retired id turns an entry into a silent
no-op. So every run checks each entry against the playlist and says so in the
log if an id or a name has gone. A warning, not a failure — a stale entry costs
two channels their guide, which is not worth refusing a publish over.

### Two things that look like bugs and are not

My provider gives every quality variant of a channel the same
`epg_channel_id`, so `IS: RUV FHD` and `IS: RUV` both resolve to `RUV.is` and
the duplicate is dropped. One `<channel id="RUV.is">` serves all three rows.

One source channel can also fan out to several provider channels, because the
provider sometimes has two ids for one channel — `TNT Sports 3.uk` alongside
`TNTSports3 HD.uk`, where only one of them matches exactly.

## Sources

| Source                          | Coverage                      | Why it is in the list                                                                     |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| **ruv.is** GraphQL              | RÚV, RÚV 2                    | First party. Real end times, not inferred ones                                            |
| **syn.is** JSON API             | 13 Sýn channels               | First party. The only source anywhere for Sýn+, Sýn Sport 5 and Sýn Sport Ísland          |
| **siminn.is** dagskrá page      | 52 channels, 7 days           | The Icelandic schedule for the foreign feeds, and the only source for Omega and ARTE ÞÝSK |
| iptv-epg.org `epg-is`           | Iceland, 70 channels          | Ids already in my provider's form, `AnimalPlanet.is`                                      |
| is-epg.run.place `guide3.xml`   | Iceland, 14 channels          | Ids already in `IS: RUV FHD` form                                                         |
| epgshare01 per country          | UK, US, US sports, DK, NO, SE | Ready-made, updated daily                                                                 |
| **epg.pw** `epg_GB`, `epg_US`   | 45 UK and 33 US gap channels  | The only source measured to recover any of what iptv-epg.org's outage cost                |
| iptv-epg.org `epg-gb`, `epg-us` | UK and US gap-fillers         | Cover channels epgshare has no entry for at all                                           |

The first source to claim a channel wins, so the order is the design. The table
above groups the six epgshare files into one row for brevity; in `SOURCES` they
are interleaved, each gap-filler sitting directly after the epgshare file for its
country. `SOURCES` is the authority on order.

**Sjónvarp Símans is read after those two and before the aggregators**, because
for an Icelandic row the Icelandic schedule is the right one. It supplies 21
channels, including four that were being served Denmark's or Sweden's schedule
because no Icelandic source carried them, and `IS: Omega FHD` and
`IS: ARTE ÞÝSK FHD`, which had no guide at all. It is also the only Icelandic
source here that is not iptv-epg.org — which went down for a day and a half and
took 135 channels' guide with it.

It is the most fragile source in the build and deliberately so: there is no API,
the schedule is a Next.js payload embedded in the page, and the page answers
**HTTP 500** while serving it. `siminn.mjs` therefore parses the payload as real
JSON rather than scraping field by field — it either parses or it throws, and a
throw costs that source its channels and nothing else.

**The broadcasters' own APIs go first.** `syn.is/api/epg` lists its stations and
serves each one's schedule as JSON; `ruv.is/gql` answers a GraphQL query per
channel per day. Both are first party, so they beat any aggregator for the
channels they own — and between them they carry things no third party has at
all. Against what the aggregators were giving:

| Channel               | Aggregators | Broadcaster API |
| --------------------- | ----------- | --------------- |
| `RUV.is`              | 220 / 7d    | **291 / 11d**   |
| `Synsport.is`         | 143 / 8d    | **212 / 12d**   |
| `Synsportisland.is`   | nothing     | **324 / 12d**   |
| `Sýn+`, `Sýn Sport 5` | nothing     | 110, 4          |

The RÚV query is written out in full rather than sent as the persisted-query
hash their website uses, because that hash belongs to whichever build of the
site is current and would break the day they deploy.

The aggregators stay, demoted, because they still carry what the broadcasters do
not: `epg-is` has the Icelandic international channels (`CNN.is`, `Sky News.is`,
`Eurosport.is`), and guide3 is the only source for Sjónvarp Símans, Samstöðin
and KVF. The two gap-fillers come after the epgshare file for their country, so
they only pick up what it misses.

`guide3` is marked `passthrough`: channels it carries that my provider has no id
for are emitted unchanged, and TiviMate name-matches them as it did before.

Worth knowing before editing the list:

- There is no Iceland file on epgshare01. `IE1` is **Ireland** — it gains two
  channels here. Do not substitute it.
- Stöð 2 no longer exists. It was retired in June 2025 and replaced by Sýn, so
  `IS: Sýn FHD` is that channel and guide3 already covers it.
- There is no `US1` on epgshare01 — the US files are `US2`, `US_SPORTS1` and
  `US_LOCALS1`, which is why `SOURCES` looks like it skipped one.
- To add a country, add a line to `SOURCES`. Verified epgshare filenames include
  `DE1` `ES1` `IT1` `FR1` `NL1` `PL1` `PT1`. Germany, Spain and Italy are
  already there, commented out deliberately — see _Measured and rejected_, they
  are a trap rather than a to-do list.

## What a good run looks like

Baseline from a verified run. A source dropping sharply means its upstream
changed its ids or its naming.

| Source        | Channels | Note                                          |
| ------------- | -------- | --------------------------------------------- |
| RÚV           | 2        | RÚV and RÚV 2, from ruv.is                    |
| Sýn           | 13       | the whole Sýn family, from syn.is             |
| Síminn        | 21       | the Icelandic schedule for the foreign feeds  |
| Iceland extra | 19       | the Icelandic international channels          |
| Iceland       | 4        | Sjónvarp Símans, Samstöðin, KVF               |
| UK            | 171      |                                               |
| UK extra      | 66       | Sky Cinema, Sky Atlantic, E4, a plain BBC One |
| US            | 142      |                                               |
| US sports     | 30       | NHL team feeds, all matched by name           |
| US extra      | 64       | A&E, CBS, HGTV, Food Network, beIN Sports 4-8 |
| Denmark       | 58       |                                               |
| Norway        | 4        | see the note below                            |
| Sweden        | 81       |                                               |
| Events        | ~1,000   | read out of channel names, not fetched        |
| Timeshift     | 6        | "+1" rows, derived from their base channel    |

About 1,700 channels and 79,500 programmes: 7.9 MB gzipped, 62 MB raw, which is
comfortably under the size that chokes TiviMate. `Events` moves between runs by
design — it is read from the playlist's current fixtures, and finished ones are
dropped, so a swing of a hundred either way is normal and not a regression.

Norway stays low because epgshare's Norwegian entries carry the country in the
_name_ — `Animal Planet Norway (NO,NO)` — and while the annotation in brackets
is stripped, the trailing word is not, so it never meets my provider's
`NO: Animal Planet`. Denmark avoids this only because its provider names match
cleanly on their own.

That reaches **3,901 of the 8,806** playlist rows that carry an
`epg_channel_id`, plus roughly a thousand more that carry none and are picked up
by name or by the event pass. The remaining two thirds of the playlist — about
20,000 rows — have no id _and_ no published schedule anywhere: the
Símminn/Viaplay event feeds, the `CHAMP | Birmingham City` per-match channels,
and the 24/7 loops. That is not a matching failure, and no source will fix it.

## How it publishes

The guide is uploaded as the asset of a fixed release tag, `epg`, and is not
committed. The tag never moves, so the download URL is permanent, and the
repository stays small instead of gaining 8 MB a day — committing it daily would
have passed two gigabytes inside a year.

It runs at 06:17 and 14:43 UTC. The second slot is insurance rather than need:
GitHub's scheduler is best-effort and both delays and outright skipped
occurrences are normal, so one slot a day means a missed slot is a missed day.
The first cron here never fired at all — the repo was hours old at the time —
which is exactly the failure the backup covers. Republishing costs nothing: the
gate and the release upload are both idempotent, and odd minutes avoid the
top-of-hour queue.

`status.json` is the one thing committed each run: a few hundred bytes recording
what was published and how many channels each source contributed. It doubles as
the reason the schedule keeps running, since GitHub disables cron in a public
repo after 60 days with no activity.

Nothing needs checking on a schedule. `check-guide.mjs` gates every publish, and
a refusal fails the workflow, which mails you.

## Maintenance

`check-guide.mjs` refuses to publish a guide with fewer than 300 channels or
20,000 programmes, or one whose schedule does not run at least 24 hours ahead.
That last one is the check a size floor misses: an upstream can serve a large,
well-formed, completely stale file.

Those are totals, though, so they cannot see one source dying while the others
hold the numbers up — UK1 vanishing entirely still clears every one of them. So
each run also records its per-source counts, and compares them with the last
published run. That needs no threshold to maintain: `status.json` is the
baseline and it updates itself.

A source dying does **not** stop the publish, though, and that is deliberate.
The guide goes out, the baseline is recorded, and a final workflow step turns
the run red for what was recorded — so you get the failure mail while the
channels that still work get fresh data.

Refusing used to seem safer and was worse. The baseline is only written on a
run that publishes, so a refusal pinned it: the same refusal fired again the
next run, and the next, and the build stayed red until someone hand-edited
`status.json`. Meanwhile the release it was protecting went stale — and most of
these upstreams publish under four days ahead (measured: UK1 2.8 days, US2 3.1,
Norway 2.6, Denmark 3.9, Sweden 4.2), so "the last good release stays up" is
worth about three days before the grid is empty anyway.

Because the failure only fires on the run a source _changed_, the report also
lists every source still carrying nothing, on every run, and anything whose
matching collapsed without reaching zero. A source that breaks and stays broken
says so until it is fixed.

The zero rule applies at any size, deliberately. It used to take 20 channels before a source counted,
which left RÚV (2 channels), Iceland (4), Norway (4) and Timeshift (6) able to
break silently and permanently — RÚV being both first-party and irreplaceable.
The threshold was there to absorb transient fetch failures, and those no longer
reach the gate: a source that fails keeps its count from cache. `Events` is the
one exemption, because it is read from the playlist's current fixtures and
swings by hundreds between runs by design.

When a refusal happens the last good release stays up, so the grid keeps working
while you look into it.

### One bad fetch should not empty a channel

Upstreams fail briefly. All three iptv-epg.org files answered HTTP 526 — a
Cloudflare origin-certificate error, nothing to do with this build — for a whole
day, and with no cache that costs 149 channels their guide: `UK extra` went 66
to 0 and `US extra` 64 to 0, the gate refused the guide, and nothing was
refreshed at all.

It is a silly way to lose a schedule, because a guide is published days ahead:
the copy fetched that morning still covered the following week. So each source's
finished output is kept in `cache/`, and a source that fails is served from its
last good copy instead of contributing nothing. Requests retry first — a 5xx or
a 429 is asked again, a 4xx never is, since it would only say the same thing —
and the cache is what is left when retrying does not help.

What is stored is the source's output after matching, not the file it came from:
a fraction of the size, no re-parsing, and it replays through the same merge, so
a cached source keeps its place in the first-to-claim order and can never
outrank a source that is working. Programmes that have already been broadcast
are dropped on the way back in, along with any channel left with nothing —
a channel kept for its own sake would count as matched and hide the failure.

Two bounds keep this honest. A copy older than four days is refused, so an
upstream that is gone for good eventually fails the build rather than being
papered over forever — the fallback buys four days of grace, not silence. And a
cached source is still reported as a failure, in the build log and in
`status.json`, so the run says plainly that the guide is fine and the upstream
is not.

In CI the directory is carried between runs by the Actions cache, not committed.
It is worth about 5 MB. Losing it costs nothing but the safety net: the next
successful run fills it again.

One failure mode worth knowing, because it looks like something else: syn.is
refuses Node's default User-Agent — the literal string `node` — by resetting
the connection, which is indistinguishable from the site being down. Every
request therefore goes through `http.mjs`, which sends an honest name and a
timeout. If a source starts failing with a connection error rather than an
HTTP status, suspect this before suspecting the source.

If a single channel stays empty, check whether the upstream carries it at all
before assuming the matching is at fault. The id lists open in a browser:

```
https://epgshare01.online/epgshare01/epg_ripper_UK1.txt
```

Some gaps are genuinely the source's, and some channels are simply gone:

- **UK Eurosport 1 and 2** are in the playlist with ids, but no UK source
  publishes them — UK1 has no Eurosport at all and epg-gb has only 3-9. Both do
  publish TNT Sports, which is where Eurosport UK's content went. The rows look
  stale. The Danish and Swedish Eurosport feeds do have data, but that is
  another market's schedule, so they are deliberately not borrowed.
- **`UK: Sky Sport 2 UHD 4K`** has no id and no sibling with one, so nothing
  says what it is. There has been no linear "Sky Sports 2" for years.
- **`UK: 4Music`** is a dead channel: iptv-org's database records it closed on
  2024-07-01, which is why nothing publishes a schedule. Several other
  unfillable ids — `Eurosport1.uk`, `amc.uk`, `bbc1.uk`, `motorstv.uk` — are
  not in that database at all, being my provider's own invented ids.
- **`Sky Sport 1 UHD 4K`** works only because my provider mapped it to
  `SkySp F1 HD.uk` itself.
- **`UHD 4K` rows are rotating event feeds** with no fixed schedule at all;
  pointing them at the HD channel would show programmes that are not on. The two
  `HDR 4K` rows are the opposite case and are filled — see
  [the one manual list](#the-one-manual-list).
- **`IS: BBC Brit HD` shows BBC Nordic's schedule, and that is correct.** My
  provider gives that row the id `BBC Nordic.is`, because BBC Brit was
  rebranded BBC Nordic in the Nordics — so Síminn's BBC Nordic matches it
  exactly and rightly. `IS: BBC Nordic FHD` is a second row for the same
  channel carrying the Swedish id, so it takes Sweden's BBC Nordic instead.
  Both rows end up with the right channel from a different market; it only
  looks wrong because the two rows are named a rebrand apart.
- **`IE:  RTE 2 FHD`** is the one row measured to be advertised on two channels
  that are not the same channel, and the cause is upstream of this build: my
  provider maps its own `IE: RTE 2 HD` to `RTÉ 2FM.uk`, which is a radio
  station, while `IE: RTE 2` maps to `RTE Two UK`. Both are Irish, so the
  country scoping is working; the id-less `FHD` row normalises to the same name
  as both and is offered to each. A player picks one, so it shows the radio
  schedule some of the time.

  Deliberately not "fixed" by picking the first: first is the radio station, so
  a deterministic choice would be deterministically wrong. Of the 67
  display-names that name more than one channel id, this is the only pair that
  is two different channels — the rest are two provider ids for one real
  channel, which is the documented fan-out and is harmless. The gate counts
  them and records the number in `status.json`, so the day that stops being
  true shows up as a diff.

- **Skjár 1** publishes no schedule. Its dagskrá page is a policy statement —
  films with Icelandic subtitles at 5, 7, 9 and 11 daily — with no titles
  anywhere. Synthesising "Kvikmynd" blocks would be the same filler this build
  strips out of iptv-epg.org.
- **UK1 carries only regional `BBC.One.Yorks.HD.uk` variants**, never a plain
  BBC One, which is why `UK extra` is in the list. (An earlier version of this
  note also claimed UK1 has no Sky Sports F1; it does — `SkySp F1 HD.uk`, with
  a real schedule.)

To try matching changes without waiting for CI:

```powershell
$env:XTREAM_HOST="http://example.com:8080"; $env:XTREAM_USER="u"; $env:XTREAM_PASS="p"
node --test
node build-epg.mjs
node check-guide.mjs
```

The build writes `guide.xml.gz` and `counts.json`, both gitignored; `counts.json`
is how the builder hands its per-source numbers to the gate. The gate only
rewrites the committed `status.json` when asked with `--record`, which is what CI
does — so running it by hand cannot clobber the baseline the per-source check
compares against.

No dependencies. Needs Node 18 or newer; CI runs 22.

## Tests

`node --test`, run by CI before the build so a break stops the run rather than
publishing quietly. No dependencies — `node:test` is built in.

They cover the logic that can be run without the network: the keys, the XMLTV
emitters, the event-name parsing, the retry rules, the cache fallback, and the
timeshift arithmetic. That is deliberate. Those are the places where a mistake
produces a _wrong schedule on a real channel_ instead of an error, and every
case in there is one that actually went wrong at some point or that a plausible
tidy-up would break:

- `+` surviving as a word, so Danish TV3's schedule stays off TV3+
- the `.us2` ordinal counting as the file's name and not the country's
- stacked variants (`UHD 4K B`, `FHD P50`) coming off together
- `Sports` folding to `Sport`, because the two sides disagree
- a spelled-out number folding to its digit — but only standing alone, or
  Vodafone becomes `vodaf1`
- a scoped key returning nothing without a country, so unlookupable entries
  never enter the maps
- `(12/9)` reading as 12 September, not 9 December
- "The Help" and "Help! My House Is Haunted" not counting as filler, which a
  substring match would have eaten
- a timeshift stamp that will not parse being dropped rather than copied
  unshifted, which would publish a whole day an hour wrong
- `UK: FILM 4  1` reading as a timeshift where `UK: Coral TV 2` does not
- a cached copy with no future schedule left in it being refused, so a failed
  source cannot be papered over with channels that only look filled
- a 4xx never being retried, because asking again gets the same answer

One test asserts a _limitation_ rather than a feature: epgshare's Norwegian
names carry the country as a word, which no normalisation strips, so they never
meet my provider's. It is recorded because it looks like a matching bug.

`iceland.mjs` is covered the same way, and it needed it most: neither
broadcaster gives a usable end time — syn.is gives none at all, ruv.is gives a
wall clock with no date — so every stop in an Icelandic schedule is worked out
rather than read, and a mistake there shows the right programmes at the wrong
time while the file stays perfectly well-formed. The cases are the ones a
review found unguarded: the `beint` guard, the three-hour cap that stops a
programme stretching across a gap in the schedule, the roll that carries a late
film past midnight instead of dropping it, dating an end from the programme's
own day rather than the one that was requested, and the strand filter —
including that something still calls it, which is the mutation that survived
while only the filter itself was covered.

The matching passes are tested too, which they were not until `match.mjs` was
split out of `build-epg.mjs` — that file runs the whole build on import, so the
code where "one channel's schedule on another" is decided had been the only
part of the project with nothing behind it. The cases are precedence and scope:
an exact id hit not also sweeping up its loose sibling, one source channel
fanning out to two provider ids when only the loose key matches, a claimed
target never being taken twice, `borrow` widening to the one declared country
and never to UK or US, a filler-only channel claiming nothing, and the "+1"
id collision staying unmatched so the timeshift pass fills it.

What no unit test can see is the finished file, where every producer's output
meets every other's, so the gate checks the three hard requirements there
instead: no channel id declared twice, no programme ending before it starts, no
programme naming a channel the guide never declares, and no programme listed
twice in the same slot. Any of them becoming non-zero refuses the publish.

The last of the four was added after being measured at **391** in a published
run — UK1 publishes Sky Kids twice, every programme of it, and guide3 repeats a
handful of Icelandic rows. The builder drops them now, so the gate reads zero;
it had been shipping in every release before that.

The fetching itself is verified by the run — the per-source counts in the log,
compared against the last published run.

## Measured and rejected

Checked against the real playlist, so none of this needs re-testing.

| Source                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `epg_ripper_US_LOCALS1`                    | 53 MB download, **536 MB raw** — past Node's 512 MB string limit, so it cannot be parsed at all. Matches 0 uncovered US ids anyway: its ids are bare call signs like `KIVI-DT.us_locals1`.                                                                                                                                                                                                                                                                                                                                             |
| `epg_ripper_ALL_SOURCES1`                  | 199 MB. Chokes TiviMate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PEACOCK1` `PLEX1` `DISTROTV1`             | 0 matches each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BEIN1` `DIRECTVSPORTS1` `ALJAZEERA1`      | 0 matches each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RAKUTEN1`                                 | 10 rows for a 9.2 MB download.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `IE1`                                      | 2 rows. Ireland, not Iceland.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| iptv-org/epg                               | 251 site scrapers, and they emit _iptv-org_ ids rather than my provider's, which is the whole job here. Its `ruv.is` grabber uses the same GraphQL endpoint as this build and its `syn.is` grabber the same API; its `sjonvarp.is` page is client-rendered and its channel map still lists Stöð 2, retired in 2025.                                                                                                                                                                                                                    |
| iptv-org/api (channel database)            | Measured: resolves **0** of the rows we miss. Its `alt_names` are good, but the bottleneck is source coverage rather than naming, and its canonical ids (`SVT1.se`) are a third vocabulary — adopting them would break matching against my provider's `tvg-id`. The `closed` field is useful for diagnosing dead channels, which is a one-off question, not a daily download.                                                                                                                                                          |
| epg.lat `uk`, `us`                         | Looks right and adds nothing. Its ids share epgshare's convention, so its channels resolve to targets `UK1` has already claimed: measured at **0** channels in a real build, against 11 when scored on its own against only the missing rows. A source has to be measured where it sits in the order, not in isolation. Its `.xml.gz` also arrives already decompressed, which `fetchSource` now copes with either way. |
| XMLTV.cc, m3u4u.com                        | Not measured. The first is paid; the second is a playlist editor for matching channels by hand, which is the job this build does by rule — a hand-maintained mapping of 8,806 rows is precisely what the design exists to avoid. |
| globetvapp/epg                             | 454 country files, and abandoned: the last commit is 2025-12-31. Measured — every file's newest programme ended **252 days ago**, with zero still in the future, so the gate would refuse it and every source count would be zero. Its `Iceland/iceland2.xml` carries exactly 55 channels, which is a scrape of Síminn, so the repo is useful only as a pointer to the source below it.                                                                                                                                                |
| epgshare's other files                     | Measured against the 135 channels iptv-epg.org's outage cost us: `IE1` fills 2, and `BEIN1`, `US_LOCALS1`, `RALLY_TV1` and `FANDUEL1` fill **none** despite looking like exact matches by name. `IE1` was tried and removed — it serves mostly Irish rows, and one UK channel is not worth 163 channels of another country. `ALL_SOURCES1` cannot be parsed at all: it exceeds the largest string Node can hold.                                                                                                                       |
| is-epg.run.place `guide.xml`, `guide2.xml` | The same Icelandic guide as `guide3.xml` under two other playlist vendors' conventions — `VIP IS: RUV` and `IC\| RUV HD` against our `IS: RUV FHD`. Channel for channel the programme counts are identical, except that both **pool Sýn's channels onto one**: 593 programmes a week, 74 a day, **423 of them overlapping the next**, where `guide3` has 220 with none. `guide.xml` also lacks KVF and Samstöðin, `guide2` lacks Samstöðin, and neither's ids can be scoped — `bare()` strips a country prefix ending in a colon, not `IC\|`. `guide3` is the freshest of the three as well.
| viaplay.is content API                     | Not usable as a source — start and end times but **no channel field at all**, so there is nothing to key XMLTV on. Its end times _are_ borrowed for the event pass, below.                                                                                                                                                                                                                                                                                                                                                             |
| framundanibeinni.is                        | Names a channel per fixture, but 228 of its 369 entries are `viaplay` or `livey`, which identify the _service_ rather than which V Sport Live or `[Livey]` channel carries it. The rest is `syn*`/`ruv*`/`eurosport*`, already covered better — syn.is gives `synsportisland` 324 entries where this gives 4.                                                                                                                                                                                                                          |

Adding the 20 other European country files would gain roughly 2,580 rows but
take the guide to **216 MB raw**, which is the size that chokes TiviMate. Add
individual countries only if you actually watch them.

`epg-us` earns its keep despite the size: building without it loses **76
channels and 10,157 programmes** — CBS, A&E, HGTV, MTV, VH1, Food Network,
Discovery Family, Nat Geo Wild, Disney Jr, OWN, FYI, Univision. It is 500 MB
uncompressed, within 3% of the largest string Node can hold.
`fetchSource` checks the size and says so plainly, so the day it outgrows the
ceiling it becomes a skipped source and the build carries on without it.

### Placeholder programmes

iptv-epg.org fills channels it has no schedule for with hourly `No Data`
programmes, and its sports feeds with `No EVENT Today`. That is worse than an
empty channel: the filler claims the id, so no other source can serve it and the
provider's own EPG never shows through either. `UK: Sky Cinema Animation HD`
showed "No Data" in TiviMate while a real schedule existed upstream.

So a source channel whose every programme is filler claims nothing, and filler
programmes are dropped on the way out — 1,248 junk entries, and 40 channels
handed back to the provider's EPG.

### Are the Icelandic guides right?

Checked, because a silently shifted guide is the worst failure mode here. Both
Icelandic sources publish every programme as `+0000`, which is correct — Iceland
is UTC+0 all year with no DST. RÚV's `Fréttir` lands at 19:00 in both, its real
broadcast time. Where the two overlap they agree exactly: all 28 of guide3's RÚV
programmes are identical in start time and title to `epg-is`.

siminn.is/dagskra is not usable as a cross-check — the grid needs a subscription
session and renders no programme cells without one.
