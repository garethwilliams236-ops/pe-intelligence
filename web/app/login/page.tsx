"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

// Password sign-in, with confirmation kept ON for new accounts.
//
// The confirmation email is the only thing proving the person controls the
// address they claimed, and the address is what the access gate is built on:
// active only for @ardentadvisors.com. Turn confirmation off and anyone could
// register as someone@ardentadvisors.com without ever seeing that mailbox, and
// walk straight into the Investor Bible. So it costs one email per person at
// signup, and none thereafter — which is what keeps us clear of Supabase's
// two-an-hour limit in normal use.

export default function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function client() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNote(null);
    const supabase = client();
    const next = new URLSearchParams(window.location.search).get("next") || "/";

    if (mode === "up") {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: {
          emailRedirectTo:
            `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      setBusy(false);
      if (error) return setError(error.message);
      return setNote(
        `Account created. Confirm it from the email sent to ${email}, then sign in.`);
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    // A full navigation rather than a client route: the session cookie has just
    // been set and the middleware needs to see it on a fresh request.
    window.location.href = next;
  }

  async function resetPassword() {
    if (!email) return setError("Enter your address first.");
    setBusy(true); setError(null); setNote(null);
    const { error } = await client().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/account`,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setNote(`Reset link sent to ${email}.`);
  }

  const field = { width: "100%", padding: "9px 11px", fontSize: 14, borderRadius: 6,
    border: "1px solid #d6d3d1", boxSizing: "border-box" as const, marginBottom: 8 };

  return (
    <main style={{ maxWidth: 380, margin: "13vh auto", padding: "0 24px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>PE Intelligence</h1>
      <p style={{ color: "#78716c", fontSize: 13.5, margin: "0 0 18px" }}>
        {mode === "in"
          ? "Sign in with your Ardent address."
          : "Create an account with your Ardent address."}
      </p>

      <form onSubmit={submit}>
        <input type="email" required value={email} autoFocus autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@ardentadvisors.com" style={field} />
        <input type="password" required value={password} minLength={8}
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "in" ? "Password" : "Choose a password (8+ characters)"}
          style={field} />
        <button type="submit" disabled={busy} style={{
          width: "100%", padding: "9px 0", borderRadius: 6, border: "none",
          background: "#1c1917", color: "#fff", fontSize: 14, cursor: "pointer" }}>
          {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </form>

      <div style={{ display: "flex", marginTop: 12, fontSize: 12.5 }}>
        <button onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); setNote(null); }}
          style={{ border: "none", background: "none", color: "#78716c",
            cursor: "pointer", padding: 0 }}>
          {mode === "in" ? "Create an account" : "I already have an account"}
        </button>
        {mode === "in" && (
          <button onClick={resetPassword} style={{ marginLeft: "auto", border: "none",
            background: "none", color: "#78716c", cursor: "pointer", padding: 0 }}>
            Forgotten password
          </button>
        )}
      </div>

      {note && <p style={{ color: "#57534e", fontSize: 13, marginTop: 12 }}>{note}</p>}
      {error && <p style={{ color: "#b91c1c", fontSize: 13, marginTop: 12 }}>{error}</p>}
    </main>
  );
}
