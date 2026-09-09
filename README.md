# iptv-epg

Builds one merged XMLTV guide whose channel ids match my IPTV provider's, so
TiviMate matches everything automatically instead of needing per-channel mapping.

## Why this exists

TiviMate matches a channel to guide data in three strict steps: `tvg-id` against
`<channel id>` (exact, case-sensitive), then `tvg-name`, then the channel name
against `<display-name>`. There is no normalisation and no fuzzy matching.

My provider uses ids like `BBC Four HD.uk`. epgshare01 uses `BBC.Four.HD.uk`.
Same channel, no match. This script collapses both sides to a common key, then
rewrites the guide's ids to the provider's so matching succeeds on step one.

## Matching rules

Applied in five passes so a loose match can never steal a channel that
something else matches precisely.

**Pass 1, exact:**

1. Normalised `epg_channel_id` — strip `.`, spaces, `_`, `-`, lowercase, keep the
   country suffix. `BBC.Four.HD.uk` and `BBC Four HD.uk` both become `bbcfourhd|uk`.
   epgshare splits large countries across numbered files and suffixes their ids
   to match, so the trailing ordinal in `.us2` is dropped — it names the file,
   not the country.
2. Normalised channel name — strip everything that isn't a letter or digit,
   lowercase. `IS: RUV FHD` becomes `isruvfhd`. Icelandic characters are kept.
   `+` survives as the word `plus`, because it is the only thing separating
   `TV3+` from `TV3`.
3. Same, against each `<display-name>` in the source.

**Pass 2, quality-suffix fallback:** drops a trailing `hd`, `fhd`, `uhd`, `sd` or
`4k`. This is what makes guide3's `IS: RUV 2 HD` feed both `IS: RUV 2` and
`IS: RUV 2 FHD`, which have no `HD` variant in my playlist.

**Pass 3, country-scoped name:** my provider's ids come from a different vendor
than epgshare's, so outside the UK the ids mostly do not overlap at all and the
name is the only thing the two sides share:

```
UK: Sky Sport Main Event UHD 4K -> SkySpMainEvHD.uk    epgshare: Sky.Sports.Main.Event.HD.uk
DK: DR 1 HD                     -> DR1 Denmark (DK,DA).dk
SE: SVT 1 FHD                   -> SVT1 HD (T).se
US: A&E HD                      -> AandE Network (East).us
```

So this pass strips the labelling each side adds — my provider's `US:` country
prefix, epgshare's `[MTVSWHD]` headend codes, and feed annotations like
`(DK,DA)`, `(T)` and `(East)` — and matches on what is left. The country is part
of the key, so a UK channel can never claim the US entry of the same name. It
also matches against the provider id's own body, which is often the better name
carrier: `AandE Network (East).us` names the channel that `US: A&E HD` is.

This pass is what makes everything outside the UK work. Without it, US, Denmark,
Norway and Sweden all matched zero channels.

**Pass 4, Nordic sources serve the Icelandic international channels:** the two
Icelandic sources cover the national channels and most internationals. Anything
left — an `Animal Planet.is` or `Arte.is` with no Icelandic entry — is on the
Nordic feed, so DK/NO/SE may serve it. Marked `borrowIcelandic` on those three
only, never UK or US: those carry a different regional schedule, and wrong
programmes are worse than none.

**Pass 5, names for the rows with no id:** a row with an empty
`epg_channel_id` can never match on step one, but TiviMate's third step
compares the channel name against `<display-name>`. So the guide carries my
provider's own channel names as extra display-names, which is what lets
`UK: TNT Sports 5 FHD` and the `US: NHL ...` feeds show a schedule at all.
These are country-scoped like pass 3 — without that, the Vietnamese Animal
Planet collects a Nordic schedule.

Every pass adds to what earlier ones found instead of skipping a resolved
channel, because my provider often has two ids for one channel — `TNT Sports
3.uk` alongside `TNTSports3 HD.uk` — where only one matches exactly.

One source channel can fan out to several provider channels. `5.USA.uk` feeds
both `5 USA.uk` and `5USA.uk`.

Conversely, my provider gives every quality variant of a channel the same
`epg_channel_id`, so `IS: RUV FHD` and `IS: RUV` both resolve to `RUV.is` and the
duplicate is dropped. One `<channel id="RUV.is">` serves all three rows.

Channels with an empty `epg_channel_id` can never match anything. In my playlist
that is about 70% of the list: Simmin Event 1-40, Viaplay Event 35-50, V Sport
Live, the Livey Sports Event feeds and the 24/7 loop channels. None of them have
a published schedule, so this is correct rather than a gap.

## Sources

| Source                        | Coverage                      | Notes                                             |
| ----------------------------- | ----------------------------- | ------------------------------------------------- |
| iptv-epg.org `epg-is.xml.gz`  | Iceland, 70 channels          | Ids already in my provider's form, `AnimalPlanet.is` |
| is-epg.run.place `guide3.xml` | Iceland, 14 channels          | Ids already in `IS: RUV FHD` form                 |
| epgshare01                    | UK, US, US sports, DK, NO, SE | Ready-made per-country files, updated daily       |
| iptv-epg.org `epg-gb`, `epg-us` | UK and US gap-fillers       | Cover what epgshare has no entry for at all       |

The two Icelandic sources are complementary, not redundant. `epg-is` carries a
full week of RUV and RUV 2 where guide3 has a single day, so it goes first;
guide3 is the only source for Sýn, Sýn Sport 1-4, Sjónvarp Símans, Samstöðin
and KVF, and picks those up next.

Order matters: the first source to claim a channel wins. The Icelandic sources
come first because they are purpose-built for this playlist, and the two
gap-fillers come after the epgshare file for their country so they only pick up
what it has no entry for.

`guide3` is marked `passthrough`, so channels it carries that my provider has no
id for are emitted unchanged and TiviMate name-matches them as it did before.

Note there is no Iceland file on epgshare01. `IE1` is Ireland. Do not substitute it.

Stöð 2 no longer exists — it was retired in June 2025 and replaced by Sýn, so
`IS: Sýn FHD` is that channel and guide3 already covers it.

Deliberately excluded: `epg_ripper_ALL_SOURCES1` (199 MB, chokes TiviMate) and
`epg_ripper_US_LOCALS1` (536 MB uncompressed, and worthless here — see below).
iptv-org/epg was considered and rejected — it is a scraper that hits hundreds of
broadcaster sites per run, too slow and fragile for a scheduled job.

### Expected match counts

Baseline from a verified run, for comparing against the log after a rebuild. A
source dropping sharply means its upstream changed its id or naming scheme.

| Source        | Channels | Note                                             |
| ------------- | -------- | ------------------------------------------------ |
| Iceland extra | 21       | a full week of RUV, plus the internationals      |
| Iceland       | 10       | Sýn, Sýn Sport, Sjónvarp Símans, KVF             |
| UK            | 186      |                                                  |
| UK extra      | 69       | Sky Sports F1, Sky Cinema, Sky Atlantic, E4      |
| US            | 147      |                                                  |
| US sports     | 30       | NHL team feeds, all matched by name              |
| US extra      | 74       | A&E, CBS, HGTV, Food Network, beIN Sports 4-8    |
| Denmark       | 64       |                                                  |
| Norway        | 5        | epgshare's `.no` ids embed the country as a word |
| Sweden        | 81       |                                                  |

687 channels and ~78,000 programmes, 7.9 MB gzipped, 62 MB raw.

That reaches 4,086 playlist rows: 3,912 of the 8,806 that carry an
`epg_channel_id`, plus 174 with no id that the pass-5 display-names pick up. The
rest is not a matching problem: 68% of the playlist has no id at all and no
source anywhere publishes a schedule for it — the Simmin/Viaplay event feeds,
the `CHAMP | Birmingham City` per-match channels, and the 24/7 loops.

Keep the provider's own EPG enabled in TiviMate at a lower priority. It is the
only thing that can ever fill those rows.

## Setup

1. Create a **public** repo (public so TiviMate can read the guide without a
   token) and push these files:

   ```
   build-epg.mjs
   check-guide.mjs
   README.md
   .gitignore
   .github/workflows/build-epg.yml
   ```

2. Add repository secrets under Settings, Secrets and variables, Actions:

   | Secret        | Example                                       |
   | ------------- | --------------------------------------------- |
   | `XTREAM_HOST` | `http://example.com:8080` (no trailing slash) |
   | `XTREAM_USER` | username                                      |
   | `XTREAM_PASS` | password                                      |

   Secrets are never written to the output. The published guide contains only
   channel ids and programme data.

3. Run it once by hand: Actions, Build EPG, Run workflow. Check the per-source
   match counts in the log.

4. Add the release URL in TiviMate under Settings, EPG, add source:

   ```
   https://github.com/USER/REPO/releases/download/epg/guide.xml.gz
   ```

   Give it higher priority than the provider's own EPG, then Settings, EPG,
   Update EPG.

5. Once Icelandic channels are confirmed working, remove the old
   `is-epg.run.place` source from TiviMate. It is merged into this file.

Rebuilds daily at 06:15 UTC.

## How it publishes

The guide is uploaded as the asset of a fixed release tag, `epg`, and is not
committed. The tag never moves, so the download URL above is permanent, and the
repository stays a few hundred kilobytes instead of gaining 4 MB a day — daily
commits would have passed a gigabyte inside a year.

`status.json` is the one thing committed each run. It is a few hundred bytes,
records what was published, and keeps the repository active: GitHub disables
scheduled workflows in a public repo after 60 days with no activity.

Nothing needs checking on a schedule. `check-guide.mjs` refuses to publish a
guide that would empty the grid, and a refusal fails the workflow, which mails
you. Confirm those mails are on once, under github.com/settings/notifications,
Actions.

## Local run

```powershell
$env:XTREAM_HOST="http://example.com:8080"; $env:XTREAM_USER="u"; $env:XTREAM_PASS="p"
node build-epg.mjs
```

Node 22, no dependencies.

## Maintenance

`check-guide.mjs` gates every publish, so an upstream outage leaves the last
good release in place rather than blanking the grid. It refuses a guide with
fewer than 300 channels or 20,000 programmes, or one whose schedule does not run
at least 24 hours ahead. That last check is the one a size floor misses: a
source can serve a large, well-formed, completely stale file.

Raise the floors if the real counts climb well above them, or the guard stops
being able to detect a source dropping out.

If a channel stays empty, check whether epgshare carries it at all. The id lists
are small and open in a browser:

```
https://epgshare01.online/epgshare01/epg_ripper_UK1.txt
```

To add a country, uncomment or add a line in `SOURCES`. Verified filenames
include DE1, ES1, IT1, FR1, NL1, PL1, PT1, IE1.

### Sources measured and rejected

Checked against the real playlist, so they do not need re-testing:

| Source                                | Result                                            |
| ------------------------------------- | ------------------------------------------------- |
| `US_LOCALS1`                          | 53 MB download, **536 MB raw** — past Node's      |
|                                       | 512 MB string limit, so it cannot even be parsed. |
|                                       | Matches 0 of the uncovered US ids anyway: its     |
|                                       | ids are bare call signs (`KIVI-DT.us_locals1`).   |
| `PEACOCK1` `PLEX1` `DISTROTV1`        | 0 matches each.                                   |
| `BEIN1` `DIRECTVSPORTS1` `ALJAZEERA1` | 0 matches each.                                   |
| `RAKUTEN1`                            | 10 rows for a 9.2 MB download.                    |
| `IE1`                                 | 2 rows. Ireland, not Iceland.                     |

iptv-epg.org's `epg-is`, `epg-gb` and `epg-us` were measured and kept — they are
the `extra` sources above. `epg-us` is 500 MB uncompressed, within 3% of the
largest string Node can hold, so `fetchSource` checks the size and reports it
plainly; the day it outgrows the ceiling it becomes a skipped source and the
build carries on without it.

### Are the Icelandic guides right?

Checked, because a silently shifted guide is the worst failure mode. Both
Icelandic sources publish every programme as `+0000`, which is correct — Iceland
is UTC+0 year round with no DST. RUV's `Fréttir` lands at 19:00 in both, its real
broadcast time. Where the two overlap they agree exactly: all 28 of guide3's RUV
programmes are identical in start time and title to `epg-is`.

siminn.is/dagskra is not usable as a reference — the grid needs a subscription
session and renders no programme cells without one.

Adding the 20 other European country files would gain ~2,580 rows but take the
guide to **216 MB raw**, which is the size that chokes TiviMate. Add individual
countries only if you actually watch them.

Some gaps are the source's, not the matching's: UK1 carries no Eurosport and no
Sky Sports F1 at all, and only regional `BBC.One.Yorks.HD.uk`-style variants
rather than a plain BBC One.

If TiviMate ever refuses the release URL, the fallback is to force-push the
guide to a single-commit orphan branch and point TiviMate at
`raw.githubusercontent.com/USER/REPO/epg/guide.xml.gz` instead. That keeps a
direct URL with no redirect, at the cost of a daily force-push.
