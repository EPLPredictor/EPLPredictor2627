// EPL Predictor — admin: onboard/update auto-predict users
//
// Backend for the local admin-autopredict.html form. profiles is self-only
// under RLS (see schema.sql §1) — a real user can never update someone
// else's auto_predict_enabled/risk_tier, by design. This function is the
// one deliberate, gated exception: it writes with the service-role key on
// the admin's behalf, after checking a shared secret.
//
// Stricter than sync-fixtures/send-reminders' auth check on purpose: those
// treat a missing secret as "open" (fine for read-mostly sync jobs); this
// one can flip real users' auto-predict state, so a missing/misconfigured
// ADMIN_SECRET fails closed (403) instead of silently allowing the call.
//
// GET  /admin-autopredict?id=<uuid>   — look up a user: name, current
//   auto-predict state, and current leaderboard standing (so the admin can
//   see where they sit before choosing a risk tier).
// POST /admin-autopredict  { id, risk_tier, enabled? }
//   — sets auto_predict_enabled/risk_tier for that user. 404s (writes
//   nothing) if the id isn't an existing registered user — this must never
//   create an account, only opt an existing one in or out.
//
// Env (set with `supabase secrets set`):
//   ADMIN_SECRET — any long random string; the admin form sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RISK_TIERS = ["conservative", "balanced", "aggressive"] as const;
type RiskTier = typeof RISK_TIERS[number];

interface LeaderboardRow {
  user_id: string;
  rank: number;
  points: number;
  participation_pct: number;
}

function corsHeaders() {
  // Local file:// admin page only — not part of the public app, but the
  // browser still sends a preflight for a cross-origin fetch with a custom
  // header (x-admin-secret), so this needs to answer it.
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-admin-secret, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const secret = Deno.env.get("ADMIN_SECRET");
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return new Response("forbidden", { status: 403, headers: corsHeaders() });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // bypasses RLS
    { auth: { persistSession: false } },
  );

  const respond = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: corsHeaders() });

  async function leaderboardRowFor(id: string): Promise<LeaderboardRow | null> {
    const { data, error } = await db.rpc("get_leaderboard");
    if (error || !data) return null;
    return (data as LeaderboardRow[]).find((r) => r.user_id === id) ?? null;
  }

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!UUID_RE.test(id)) return respond({ error: "id must be a valid UUID" }, 400);

    const { data: profile, error } = await db
      .from("profiles")
      .select("id, full_name, auto_predict_enabled, risk_tier")
      .eq("id", id)
      .maybeSingle();

    if (error) return respond({ error: error.message }, 500);
    if (!profile) return respond({ error: "no registered user with that id" }, 404);

    const leaderboard = await leaderboardRowFor(id);
    return respond({ ...profile, leaderboard });
  }

  if (req.method === "POST") {
    let body: { id?: string; risk_tier?: string; enabled?: boolean };
    try {
      body = await req.json();
    } catch {
      return respond({ error: "invalid JSON body" }, 400);
    }

    const id = body.id ?? "";
    const riskTier = body.risk_tier as RiskTier;
    const enabled = body.enabled ?? true;

    if (!UUID_RE.test(id)) return respond({ error: "id must be a valid UUID" }, 400);
    if (!RISK_TIERS.includes(riskTier)) {
      return respond({ error: `risk_tier must be one of ${RISK_TIERS.join(", ")}` }, 400);
    }
    if (typeof enabled !== "boolean") return respond({ error: "enabled must be a boolean" }, 400);

    // Confirm the id is an existing registered user before writing anything
    // — this must never silently no-op, and must never create a profile.
    const { data: existing, error: findErr } = await db
      .from("profiles")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (findErr) return respond({ error: findErr.message }, 500);
    if (!existing) return respond({ error: "no registered user with that id" }, 404);

    const { data: updated, error: updateErr } = await db
      .from("profiles")
      .update({ auto_predict_enabled: enabled, risk_tier: riskTier })
      .eq("id", id)
      .select("id, full_name, auto_predict_enabled, risk_tier")
      .single();

    if (updateErr) return respond({ error: updateErr.message }, 500);

    const leaderboard = await leaderboardRowFor(id);
    return respond({ ...updated, leaderboard });
  }

  return respond({ error: "method not allowed" }, 405);
});
