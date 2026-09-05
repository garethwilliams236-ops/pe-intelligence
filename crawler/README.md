# crawler

Fetches sponsor websites, stores what it finds as evidence, and turns portfolio
and team pages into **candidate claims**. It never writes to `deals`,
`investments` or `people` — promotion from claim to fact is a separate,
deliberate step (WP4).

## What it will not do

Only publicly reachable pages, only over `robots.txt`, one request at a time per
domain with a two-second floor, and a User-Agent that says who it is and how to
complain. It does not log in, submit forms, defeat bot checks, or touch anything
behind a paywall. If a site says no, it is skipped and the domain is marked.

## Commands

```bash
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<pw>@aws-0-eu-west-2.pooler.supabase.com:5432/postgres'

python -m crawler.run probe --url https://www.inflexion.com   # writes nothing
python -m crawler.run probe --limit 5 --any                   # first 5 targets
python -m crawler.run crawl --limit 20                        # fetch, store, extract
python -m crawler.run extract --llm --limit 50                # optional second pass
python -m crawler.run status
```

`probe` is the one to run first on any new site. It prints the index pages the
discoverer chose and exactly what the extractor pulled out of them, and touches
nothing. Sponsor sites vary enormously, and this is the only honest way to find
out whether the heuristics hold before committing rows.

## How it works

1. **Discover** (`discover.py`) — scores every same-site link against patterns
   for portfolio / team / news indexes, using both the URL path and the anchor
   text, and keeps the best two of each kind. No per-site configuration.
2. **Fetch** (`fetch.py`) — robots, politeness, content hashing. A page whose
   hash is unchanged is recorded and skipped, so re-runs are cheap.
3. **Extract** (`extract.py`) — the heuristic reads the index page's own link
   structure: children of the index path are the detail entries, and the card is
   the largest ancestor block containing exactly one such link. Names come from
   anchor text, then a heading, then the URL slug — except for people, who never
   get the slug fallback, because a "Read more" link to `/team/join-us/` would
   otherwise be filed as a person called Join Us.
4. **Claims** — every item lands in `claims` as a candidate at confidence 0.55
   (heuristic) or 0.65 (LLM), with a `claim_evidence` row pointing at the
   document and the surrounding text as the quote.

## The LLM pass is optional

`extract --llm` needs `ANTHROPIC_API_KEY` and costs money per page. Use it only
for sites where the heuristic came back empty — check with:

```sql
select d.canonical_url
from public.documents d
left join public.claims c on c.id in (
  select claim_id from public.claim_evidence where document_id = d.id)
where c.id is null and d.canonical_url ilike '%portfolio%';
```

## Running on GitHub Actions

`.github/workflows/crawl.yml` — manual dispatch with a `probe`/`crawl` choice,
plus a weekly schedule. Needs one repository secret:

- `SUPABASE_DB_URL` — the session pooler string
- `ANTHROPIC_API_KEY` — only if you want the LLM pass

GitHub Actions rather than Vercel because crawling politely takes hours and
Vercel functions cap out in minutes.

## Known limits

- JavaScript-rendered portfolio lists return nothing. No headless browser yet;
  the LLM pass will not rescue these either, because the text is not in the HTML.
  `probe` makes them obvious — the index page is found but yields zero items.
- Pagination and "load more" are not followed, so a long portfolio may be
  truncated at the first page.
- `entry_year` / `exit_year` come from any four-digit years in the card, in
  order. On a card that mentions an unrelated year first, this will be wrong —
  which is exactly why these are candidate claims rather than facts.
