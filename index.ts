// EPL Predictor — fixture sync
//
// Runs on a 5-minute cron. Pulls the full PL season from
// football-data.org and upserts it into the fixtures table.
//
// Why server-side:
//   - the API token never reaches the browser
//   - 10 req/min is a shared budget; one caller instead of N users
//
// This function used to also pull standings and ClubElo win/draw/loss
// probabilities to freeze an "upset bonus" onto scoring. That scoring
// formula was tried and dropped — see README.md's decisions log — and
// this function was simplified back down to just fixtures/scores.
//
// Env (set with `supabase secrets set`):
//   FOOTBALL_DATA_TOKEN  — your free football-data.org token
//   SYNC_SECRET          — any long random string; the cron sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COMPETITION = "PL";
const MIN_INTERVAL_SECONDS = 60; // upstream guard: never poll faster than this

Deno.serve(async (req) => {
  // --- 1. auth: the anon key is public, so gate on a shared secret ---
  const secret = Deno.env.get("SYNC_SECRET");
  if (secret && req.headers.get("x-sync-secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
  if (!token) return new Response("FOOTBALL_DATA_TOKEN not set", { status: 500 });

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // bypasses RLS
    { auth: { persistSession: false } },
  );

  // --- 2. don't hammer upstream if something retries in a loop ---
  const { data: age } = await db.rpc("sync_age_seconds");
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && typeof age === "number" && age < MIN_INTERVAL_SECONDS) {
    return Response.json({ skipped: true, reason: "synced recently", age_seconds: age });
  }

  // --- 3. fetch the season ---
  let payload: { matches?: unknown[] };
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${COMPETITION}/matches`,
      { headers: { "X-Auth-Token": token } },
    );

    if (res.status === 429) {
      return Response.json({ error: "upstream rate limited" }, { status: 429 });
    }
    if (!res.ok) {
      return Response.json(
        { error: `upstream ${res.status}`, body: (await res.text()).slice(0, 400) },
        { status: 502 },
      );
    }
    payload = await res.json();
  } catch (e) {
    return Response.json({ error: `fetch failed: ${e}` }, { status: 502 });
  }

  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  if (matches.length === 0) {
    return Response.json({ error: "upstream returned no matches" }, { status: 502 });
  }

  // --- 4. map to our shape ---
  const now = new Date().toISOString();
  const rows = matches.map((raw) => {
    const m = raw as Record<string, any>;
    return {
      id: m.id,
      matchday: m.matchday ?? null,
      kickoff_utc: m.utcDate,
      home_team: m.homeTeam?.shortName ?? m.homeTeam?.name ?? "TBD",
      away_team: m.awayTeam?.shortName ?? m.awayTeam?.name ?? "TBD",
      home_crest: m.homeTeam?.crest ?? null,
      away_crest: m.awayTeam?.crest ?? null,
      status: m.status,
      home_score: m.score?.fullTime?.home ?? null,
      away_score: m.score?.fullTime?.away ?? null,
      synced_at: now,
    };
  }).filter((r) => r.id && r.kickoff_utc);

  // --- 5. upsert in chunks (380 rows is fine in one go, but be safe) ---
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db
      .from("fixtures")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "id" });
    if (error) {
      return Response.json({ error: error.message, at_row: i }, { status: 500 });
    }
  }

  const live = rows.filter((r) => ["IN_PLAY", "PAUSED"].includes(r.status)).length;

  return Response.json({ synced: rows.length, live, at: now });
});
