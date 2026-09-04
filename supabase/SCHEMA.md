# pe-intelligence — data model (Work Package 1)

Target platform: Supabase Postgres 16 + pgvector. Coverage: UK + Western Europe.
Deployed via `supabase db push`; the crawler and the ranking engine run as
`service_role` and therefore bypass RLS.

## Migration order

| File | Contents |
|---|---|
| `…090000_extensions_and_enums.sql` | extensions, `normalise_name()`, `set_updated_at()`, all enums |
| `…090100_core_entities.sql` | `profiles`, `countries`, `sectors`, `companies`, identifiers, aliases, `people`, `person_roles` |
| `…090200_investors_and_funds.sql` | `investors` (mandate box), stated focus, `funds` |
| `…090300_deals_and_investments.sql` | `deals`, participants, advisers, deal people, valuations, `investments` |
| `…090400_financials_and_fx.sql` | `fx_rates`, `fx_to_gbp()`, `company_financials` |
| `…090500_sources_and_evidence.sql` | `sources`, `documents`, `claims`, `claim_evidence`, licence gate |
| `…090600_crawler.sql` | crawl domains/targets/runs/items, extraction runs, licensed feed imports |
| `…090700_mandates_and_matching.sql` | `clients`, `mandates`, `match_runs`, `investor_matches`, reasons, outcomes, `reports` |
| `…090800_derived_views.sql` | revealed sector/size focus, track record, search, active fund |
| `…090900_rls_policies.sql` | RLS on all 43 tables, helper predicates, grants |

## The four spines

**1. Identity.** `companies` is one row per legal entity whatever role it plays —
sponsor, target, adviser, lender. Sponsors get a 1:1 extension row in `investors`
rather than a separate table, so a house that also appears as a vendor is still
one entity. Resolution runs off `company_identifiers` (Companies House, KVK,
SIREN, Handelsregister, LEI, plus feed IDs) with `pg_trgm` on a normalised name
key as the fuzzy fallback. `merged_into_id` handles duplicates without deleting
history.

**2. Deals and positions.** A deal is one transaction event; `investments` is the
holding period that stitches entry → add-ons → exit into a single narrative.
Add-ons hang off `deals.parent_investment_id`, so buy-and-build appetite is
countable rather than anecdotal. Valuations are many-per-deal on purpose:
PitchBook, the press and the filed accounts will disagree, and one row per source
with `is_preferred` beats silently picking a winner.

**3. Evidence.** Every material assertion traces to a `document` with a hash, a
retrieval timestamp and a storage path. `claims` is the extraction staging layer —
conflicting claims coexist as candidates and promotion into the typed tables is a
deliberate, auditable act. `extraction_runs` records model and prompt version, so
when the extractor improves you re-run only the documents processed by the old one.

**4. Matching.** `mandates` captures the target profile explicitly rather than
inferring it, `match_runs` versions the algorithm and the weights, and
`investor_match_reasons` holds one row per contributing signal with arrays of the
deals, people and claims that justify it. That is what turns "top 20 investors"
into "top 20 investors, and here is why, with citations" — and what lets you
reproduce a ranking that went to a client eighteen months earlier.

## The licence gate

`sources.licence_class` is one of `public_domain`, `public_attributable`,
`licensed_internal_only`, `confidential`, and it is denormalised onto every fact
table that can carry a licensed number. `is_redistributable()` is the single
predicate; `v_redistributable_deal_facts` is the client-facing projection.

It masks the restricted *figures* rather than dropping the deal, because the
existence of a transaction is usually public even when a paid feed is the only
source of its EV — and `valuation_withheld_for_licence` tells the report generator
to print "undisclosed" instead of silently omitting a comparable. This is the
control that lets you buy a PitchBook or Mergr seat later without contaminating
client marketing output.

## Stated vs revealed focus

`investor_sector_focus` / `investor_geography_focus` / the mandate box on
`investors` are what a house *says* it does. `v_investor_revealed_sectors` and
`v_investor_revealed_size` are what it has actually done, computed from the deal
history with exponential recency decay (≈15%/yr) and EV percentiles. The ranking
engine should weigh both — stated focus alone is marketing, revealed focus alone
misses a house that has just raised for a new strategy.

## Scoring signals

The `match_signal` enum is the contract between the engine and the report:
`sector_fit`, `size_fit`, `geography_fit`, `deal_type_fit`, `recent_activity`,
`fund_capacity`, `buy_and_build_appetite`, `thesis_similarity`, `people_overlap`,
`adviser_overlap`, `competitor_owned`, `prior_approach`, `hold_period_due`,
`negative_signal`.

Two are worth calling out because they are the ones the paid databases do not
give you directly:

- **`fund_capacity`** — `investor_active_fund()` finds the fund still inside its
  investment period. A house with no deployable fund cannot transact, however
  good the sector fit, and this is the most under-used filter in origination.
- **`people_overlap`** — `person_roles` plus `deal_people` means a track record
  follows the individual through a move between houses. The partner who bought
  your client's closest comparable in 2019 is the approach point, even if she is
  now at a different firm.

`hold_period_due` reads `live_holds_over_4y` off `v_investor_track_record` — a
sponsor with an ageing portfolio is a motivated buyer *and* a source of secondary
processes.

## Security model

Two tiers. The knowledge base (companies, deals, investors, evidence, crawl) is
readable by any active user and writable by `analyst`/`admin`. Engagement data
(clients, mandates, match runs, matches, outcomes, reports) is gated on
`mandate_team` membership, mirroring the deal-team gate in the Ardent CRM. Views
are `security_invoker` so policies apply through them. Verified: a session with no
`profiles` row sees zero rows in every table.

## Deliberately deferred

- LP/fund-investor relationships (`funds` has no LP table yet).
- Debt structures beyond a `debt_quantum` figure on the valuation.
- A materialised view layer — the revealed-focus views are plain views for now;
  promote to matviews with a scheduled refresh once deal volume warrants it.
- Sector taxonomy seeding. `sectors` is empty apart from what you load; a SIC ↔
  ardent crosswalk is Work Package 2 territory.

## Verification performed

All ten migrations applied clean to a scratch Postgres 16 + pgvector cluster, then
a worked example (UK software buyout → add-on → secondary exit, with a partner
who changes firm) exercised every view and function. `supabase/seed_smoke_test.sql`
reproduces it; it asserts the 62-month realised hold, the add-on count, recency
weighting, the licence mask and the fuzzy search hit.
