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

Applied in three passes so a loose match can never steal a channel that
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

| Source                        | Coverage                      | Notes                                       |
| ----------------------------- | ----------------------------- | ------------------------------------------- |
| is-epg.run.place `guide3.xml` | Iceland, 14 channels          | Ids already in `IS: RUV FHD` form           |
| epgshare01                    | UK, US, US sports, DK, NO, SE | Ready-made per-country files, updated daily |

Order matters: the first source to claim a channel wins, and Iceland is first
because that file is purpose-built for this playlist.

The Icelandic source is marked `passthrough`, so channels it carries that my
provider has no id for are emitted unchanged and TiviMate name-matches them as
it did before.

Note there is no Iceland file on epgshare01. `IE1` is Ireland. Do not substitute it.

Stöð 2 no longer exists — it was retired in June 2025 and replaced by Sýn, so
`IS: Sýn FHD` is that channel and guide3 already covers it.

Deliberately excluded: `epg_ripper_ALL_SOURCES1` (199 MB, chokes TiviMate) and
`epg_ripper_US_LOCALS1` (56 MB). iptv-org/epg was considered and rejected — it is
a scraper that hits hundreds of broadcaster sites per run, too slow and fragile
for a scheduled job.

### Expected match counts

Baseline from a verified run, for comparing against the log after a rebuild. A
source dropping sharply means its upstream changed its id or naming scheme.

| Source    | Channels | Note                                                   |
| --------- | -------- | ------------------------------------------------------ |
| Iceland   | 11       | 14 source channels, 3 are duplicate ids, 1 passthrough |
| UK        | 160      |                                                        |
| US        | 139      |                                                        |
| US sports | 0        | provider carries no MILB feeds with ids                |
| Denmark   | 54       |                                                        |
| Norway    | 2        | epgshare's `.no` ids embed the country as a word       |
| Sweden    | 84       |                                                        |

450 channels and ~47,000 programmes, 4.3 MB gzipped. `US sports` and `Norway`
earn almost nothing and could be dropped from `SOURCES`; they are kept because
they cost only download time and may improve upstream.

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

If TiviMate ever refuses the release URL, the fallback is to force-push the
guide to a single-commit orphan branch and point TiviMate at
`raw.githubusercontent.com/USER/REPO/epg/guide.xml.gz` instead. That keeps a
direct URL with no redirect, at the cost of a daily force-push.
