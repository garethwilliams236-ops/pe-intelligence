import { createClient } from "@supabase/supabase-js";

// Server-side only. The investor universe includes master-list rows loaded as
// `confidential`, so the service role key must never be exposed to the client.
export function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — " +
        "copy web/.env.local.example to web/.env.local and fill them in."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// PostgREST caps every response at 1,000 rows regardless of .limit(), so a
// single call silently returned the first 1,000 investors alphabetically and
// nothing after about "R". Nothing errors — the list just ends. Any read of the
// full universe goes through here.
export async function selectAll<T = any>(
  table: string, columns: string, orderBy?: string
): Promise<{ rows: T[]; error?: string }> {
  const supabase = db();
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (orderBy) q = q.order(orderBy);
    const { data, error } = await q;
    if (error) return { rows, error: error.message };
    rows.push(...((data || []) as T[]));
    if (!data || data.length < PAGE) return { rows };
    if (from > 50_000) return { rows, error: "refusing to page past 50,000 rows" };
  }
}
