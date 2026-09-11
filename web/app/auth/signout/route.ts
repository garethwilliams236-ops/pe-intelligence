import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { anonClient } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const supabase = anonClient(await cookies());
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
