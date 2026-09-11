import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { anonClient } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Where the magic link lands. Exchanges the one-time code for a session cookie,
// then sends the user on to whatever they were trying to reach.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const next = req.nextUrl.searchParams.get("next") || "/";
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", req.url));
  }
  const supabase = anonClient(await cookies());
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, req.url));
  }
  return NextResponse.redirect(new URL(next, req.url));
}
