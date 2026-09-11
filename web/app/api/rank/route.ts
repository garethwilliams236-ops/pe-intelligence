import { NextRequest, NextResponse } from "next/server";
import { selectAll } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { concepts, excludedBy, keywords, regionFor, score, Investor, Mandate, Scored } from "@/lib/rank";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { deny } = await requireUser();
  if (deny) return deny;
  const body = await req.json();

  const mandate: Mandate = {
    mandate_type: body.mandate_type || null,
    fund_types: body.fund_types || [],
    country_code: body.country_code || null,
    expected_ev_gbp: body.expected_ev_gbp ? Number(body.expected_ev_gbp) : null,
    revenue_gbp: null,
    sector: body.sector || null,
    business_description: body.business_description || null,
    hard_filters: body.hard_filters || ["geography"],
    required_countries: body.country_code ? [body.country_code] : [],
  };

  const want = keywords(
    [mandate.business_description, mandate.sector].filter(Boolean).join(" ")
  );
  const wantConcepts = concepts(want);

  // Every investor, not the first thousand: PostgREST caps a response at 1,000
  // rows, so the ranking used to stop at "R" and never said so.
  const { rows: data, error } = await selectAll<any>("v_investor_universe", "*");
  if (error) return NextResponse.json({ error }, { status: 500 });

  const excluded: Record<string, number> = {};
  const scored: Scored[] = [];
  for (const row of data || []) {
    const inv: Investor = {
      company_id: row.company_id,
      legal_name: row.legal_name,
      country_code: row.country_code,
      fund_type: row.fund_type,
      invest_geographies: row.invest_geographies || [],
      ardent_sector: row.ardent_sector,
      check_band: row.check_band,
      cheque_min: row.cheque_min,
      cheque_max: row.cheque_max,
      cheque_source: row.cheque_source,
      strategies: row.strategies || [],
      focus: row.focus || [],
      grade: row.grade,
      never_approach: row.never_approach,
      holdings: row.holdings || 0,
      blob: row.portfolio_text || "",
      recent: row.recent_count || 0,
      latest: row.latest_year,
    };
    // Defunct and duplicate rows never rank, whatever the analyst has ticked.
    // Counted rather than skipped silently, because "why is Doughty Hanson
    // missing" deserves an answer on the page.
    if (row.status === "defunct") {
      excluded["defunct"] = (excluded["defunct"] || 0) + 1;
      continue;
    }
    if (row.merged_into_id) {
      excluded["duplicate record"] = (excluded["duplicate record"] || 0) + 1;
      continue;
    }
    const reason = excludedBy(mandate, inv, wantConcepts);
    if (reason) {
      excluded[reason] = (excluded[reason] || 0) + 1;
      continue;
    }
    const s = score(mandate, inv, want, wantConcepts);
    if (s.stated <= 0 && s.revealed === null) continue;
    scored.push(s);
  }

  // Stated fit ranks; revealed fit breaks ties and corroborates. Summing them
  // would rank the crawl schedule rather than the investors.
  scored.sort((a, b) => b.stated - a.stated || (b.revealed || 0) - (a.revealed || 0));

  return NextResponse.json({
    concepts: [...wantConcepts],
    region: regionFor(mandate.country_code),
    considered: (data || []).length,
    excluded,
    qualified: scored.length,
    // Coverage counters, so a thin-looking list can be read as thin DATA
    // rather than a thin market.
    with_fund_type: scored.filter((s) => s.fund_type).length,
    with_geographies: scored.filter((s) => (s.invest_geographies || []).length).length,
    with_cheque: scored.filter((s) => s.cheque_min != null).length,
    with_evidence: scored.filter((s) => s.revealed !== null).length,
    results: scored.slice(0, Number(body.top || 20)),
  });
}
