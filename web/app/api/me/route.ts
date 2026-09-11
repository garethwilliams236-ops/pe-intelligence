import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Who is signed in, for the header. Returns null rather than 401 — the page
// asking is already past the middleware, and a 401 here would look like an
// error rather than an answer.
export async function GET() {
  return NextResponse.json({ viewer: await currentViewer() });
}
