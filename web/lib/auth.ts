// Sign-in, and the guard every route runs before it touches anything.
//
// Two Supabase clients live in this app and they must not be confused:
//
//   lib/db.ts        service role. Bypasses RLS entirely, server-only, and is
//                    what reads the Bible once a request has been authorised.
//   lib/auth.ts      the user's own session, from cookies, with the anon key.
//                    This is the only thing that can answer "who is asking".
//
// Every route that uses the service-role client must call requireUser() FIRST.
// Skipping it would leave an endpoint that reads confidential data with no
// authentication at all — which is exactly what the app was before this file.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export type Viewer = {
  id: string;
  email: string;
  role: "admin" | "analyst" | "viewer";
  is_active: boolean;
};

export function anonClient(cookieStore: any) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  }
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list: { name: string; value: string; options: any }[]) => {
        try {
          list.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options));
        } catch {
          // Route handlers and server components cannot always write cookies;
          // the middleware refresh covers that case.
        }
      },
    },
  });
}

/** The signed-in, active user — or null. Never throws on a missing session. */
export async function currentViewer(): Promise<Viewer | null> {
  const cookieStore = await cookies();
  const supabase = anonClient(cookieStore);
  // getUser(), not getSession(): getSession trusts the cookie as it stands,
  // which the client could have forged. getUser verifies it against Supabase.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await db()
    .from("profiles")
    .select("id, email, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  // No profile, or an inactive one, is not a user as far as this app is
  // concerned. An account can exist in Supabase and still have no standing here.
  if (!profile || !profile.is_active) return null;
  return profile as Viewer;
}

// One shape for every guard: either a viewer, or a response to return instead.
// Named rather than written inline, because a generic that opens at the end of a
// line is easy to mangle and hard to read.
export type Guard =
  | { viewer: Viewer; deny?: undefined }
  | { viewer?: undefined; deny: NextResponse };

/** Guard for API routes. Returns a 401 response, or the viewer. */
export async function requireUser(): Promise<Guard> {
  const viewer = await currentViewer();
  if (!viewer) {
    return { deny: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  }
  return { viewer };
}

/** Guard for anything that writes. Viewers may read the Bible, not change it. */
export async function requireEditor(): Promise<Guard> {
  const got = await requireUser();
  if (got.deny) return got;
  if (got.viewer.role === "viewer") {
    return {
      deny: NextResponse.json(
        { error: "Your account can read the Bible but not change it." },
        { status: 403 }),
    };
  }
  return got;
}
