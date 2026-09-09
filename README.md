# iptv-epg

Builds one merged XMLTV guide whose channel ids already match my IPTV
provider's, so TiviMate fills the grid on its own instead of needing hundreds of
channels mapped by hand. A GitHub Action rebuilds it every morning and publishes
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
   build-epg.mjs        the builder
   check-guide.mjs      the publish gate
   epg-xml.mjs          shared XMLTV helpers
   README.md
   .gitignore
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

### Two things that look like bugs and are not

My provider gives every quality variant of a channel the same
`epg_channel_id`, so `IS: RUV FHD` and `IS: RUV` both resolve to `RUV.is` and
the duplicate is dropped. One `<channel id="RUV.is">` serves all three rows.

One source channel can also fan out to several provider channels, because the
provider sometimes has two ids for one channel — `TNT Sports 3.uk` alongside
`TNTSports3 HD.uk`, where only one of them matches exactly.

## Sources

| Source                          | Coverage                      | Why it is in the list                                |
| ------------------------------- | ----------------------------- | ---------------------------------------------------- |
| **ruv.is** GraphQL | RÚV, RÚV 2 | First party. Real end times, not inferred ones |
| **syn.is** JSON API | 13 Sýn channels | First party. The only source anywhere for Sýn+, Sýn Sport 5 and Sýn Sport Ísland |
| iptv-epg.org `epg-is`           | Iceland, 70 channels          | Ids already in my provider's form, `AnimalPlanet.is` |
| is-epg.run.place `guide3.xml`   | Iceland, 14 channels          | Ids already in `IS: RUV FHD` form                    |
| epgshare01 per country          | UK, US, US sports, DK, NO, SE | Ready-made, updated daily                            |
| iptv-epg.org `epg-gb`, `epg-us` | UK and US gap-fillers         | Cover channels epgshare has no entry for at all      |

The first source to claim a channel wins, so the order is the design.

**The broadcasters' own APIs go first.** `syn.is/api/epg` lists its stations and
serves each one's schedule as JSON; `ruv.is/gql` answers a GraphQL query per
channel per day. Both are first party, so they beat any aggregator for the
channels they own — and between them they carry things no third party has at
all. Against what the aggregators were giving:

| Channel | Aggregators | Broadcaster API |
| --- | --- | --- |
| `RUV.is` | 220 / 7d | **291 / 11d** |
| `Synsport.is` | 143 / 8d | **212 / 12d** |
| `Synsportisland.is` | nothing | **324 / 12d** |
| `Sýn+`, `Sýn Sport 5` | nothing | 110, 4 |

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
- To add a country, add a line to `SOURCES`. Verified epgshare filenames include
  `DE1` `ES1` `IT1` `FR1` `NL1` `PL1` `PT1`.

## What a good run looks like

Baseline from a verified run. A source dropping sharply means its upstream
changed its ids or its naming.

| Source        | Channels | Note                                             |
| ------------- | -------- | ------------------------------------------------ |
| RÚV | 2 | RÚV and RÚV 2, from ruv.is |
| Sýn | 13 | the whole Sýn family, from syn.is |
| Iceland extra | 19 | the Icelandic international channels |
| Iceland | 4 | Sjónvarp Símans, Samstöðin, KVF |
| UK            | 171      |                                                  |
| UK extra      | 65       | Sky Sports F1, Sky Cinema, Sky Atlantic, E4      |
| US            | 142      |                                                  |
| US sports     | 30       | NHL team feeds, all matched by name              |
| US extra      | 64       | A&E, CBS, HGTV, Food Network, beIN Sports 4-8    |
| Denmark       | 59       |                                                  |
| Norway        | 4        | epgshare's `.no` ids embed the country as a word |
| Sweden        | 81       |                                                  |
| Events        | ~850     | read out of channel names, not fetched           |

About 1,500 channels and 78,000 programmes: 7.6 MB gzipped, 62 MB raw, which is
comfortably under the size that chokes TiviMate.

That reaches **3,898 of the 8,806** playlist rows that carry an
`epg_channel_id`, plus roughly a thousand more that carry none and are picked up
by name or by the event pass. The remaining two thirds of the playlist — about
20,000 rows — have no id _and_ no published schedule anywhere: the
Símminn/Viaplay event feeds, the `CHAMP | Birmingham City` per-match channels,
and the 24/7 loops. That is not a matching failure, and no source will fix it.

## How it publishes

The guide is uploaded as the asset of a fixed release tag, `epg`, and is not
committed. The tag never moves, so the download URL is permanent, and the
repository stays small instead of gaining 4 MB a day — committing it daily would
have passed a gigabyte inside a year.

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
each run also records its per-source counts, and the next run refuses to publish
if a source that was carrying 20 or more channels now carries none. That needs
no threshold to maintain: `status.json` is the baseline and it updates itself.

When a refusal happens the last good release stays up, so the grid keeps working
while you look into it.

If a single channel stays empty, check whether the upstream carries it at all
before assuming the matching is at fault. The id lists open in a browser:

```
https://epgshare01.online/epgshare01/epg_ripper_UK1.txt
```

Some gaps are genuinely the source's: UK1 carries no Eurosport and no Sky Sports
F1 at all, and only regional `BBC.One.Yorks.HD.uk`-style variants rather than a
plain BBC One. Others cannot exist — `Sky Sport 1 UHD 4K` and `BBC One HDR 4K`
are rotating 4K event feeds with no fixed schedule, and pointing them at the HD
channel would show programmes that are not on.

To try matching changes without waiting for CI:

```powershell
$env:XTREAM_HOST="http://example.com:8080"; $env:XTREAM_USER="u"; $env:XTREAM_PASS="p"
node build-epg.mjs
node check-guide.mjs
```

Node 22, no dependencies.

## Measured and rejected

Checked against the real playlist, so none of this needs re-testing.

| Source                                | Result                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `epg_ripper_US_LOCALS1`               | 53 MB download, **536 MB raw** — past Node's 512 MB string limit, so it cannot be parsed at all. Matches 0 uncovered US ids anyway: its ids are bare call signs like `KIVI-DT.us_locals1`. |
| `epg_ripper_ALL_SOURCES1`             | 199 MB. Chokes TiviMate.                                                                                                                                                                   |
| `PEACOCK1` `PLEX1` `DISTROTV1`        | 0 matches each.                                                                                                                                                                            |
| `BEIN1` `DIRECTVSPORTS1` `ALJAZEERA1` | 0 matches each.                                                                                                                                                                            |
| `RAKUTEN1`                            | 10 rows for a 9.2 MB download.                                                                                                                                                             |
| `IE1`                                 | 2 rows. Ireland, not Iceland.                                                                                                                                                              |
| iptv-org/epg                          | A scraper that hits hundreds of broadcaster sites per run. Too slow and too fragile for a scheduled job.                                                                                   |
| viaplay.is content API | Not usable as a source — start and end times but **no channel field at all**, so there is nothing to key XMLTV on. Its end times *are* borrowed for the event pass, below. |
| framundanibeinni.is | Names a channel per fixture, but 228 of its 369 entries are `viaplay` or `livey`, which identify the *service* rather than which V Sport Live or `[Livey]` channel carries it. The rest is `syn*`/`ruv*`/`eurosport*`, already covered better — syn.is gives `synsportisland` 324 entries where this gives 4. |

Adding the 20 other European country files would gain roughly 2,580 rows but
take the guide to **216 MB raw**, which is the size that chokes TiviMate. Add
individual countries only if you actually watch them.

`epg-us` is 500 MB uncompressed, within 3% of the largest string Node can hold.
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
