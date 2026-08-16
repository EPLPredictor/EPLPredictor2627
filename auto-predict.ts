// EPL Predictor — auto-predict bot
//
// Fills in H/D/A picks for a small set of real, opted-in users
// (profiles.auto_predict_enabled = true) who can't check in daily. Runs
// every few hours (see cron.sql) — much more often than once a day, since
// a gameweek's fixtures kick off across several different days/times and
// each one locks independently 2 hours before its own kickoff.
//
// Deliberately reproduces fixture_is_open() from schema.sql instead of
// relying on it: this function writes with the service-role key, which
// bypasses RLS (and therefore bypasses the fixture_is_open() check inside
// the predictions insert policy) entirely. Without reproducing that same
// cutoff here, the bot could write a pick the app itself would never have
// allowed a real user to submit.
//
// Only acts once a fixture's FINAL odds are frozen (home_odds/draw_odds/
// away_odds, set by sync-fixtures 24h before kickoff) — never guesses off
// the indicative preview_* odds. See README §3/§6 and schema.sql §4 for why
// those two timers (odds freeze at 24h, prediction lock at 2h) are
// deliberately 22 hours apart: this function relies on that gap to have a
// long, stable window to act in. A fixture whose odds fetch genuinely never
// succeeds by lock time is left unpredicted for these users this run,
// rather than guessed blind — same "don't guess" posture as sync-fixtures'
// own odds handling.
//
// Never overwrites an existing prediction, manual or auto — every write is
// a plain insert with onConflict do-nothing against the (user_id,
// fixture_id) primary key.
//
// Env (set with `supabase secrets set`):
//   AUTOPREDICT_SECRET — any long random string; the cron sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LOCK_HOURS_BEFORE_KICKOFF = 2; // must match fixture_is_open() in schema.sql

type RiskTier = "conservative" | "balanced" | "aggressive";

interface LeaderboardRow {
  user_id: string;
  points: number;
  rank: number;
}

interface Fixture {
  id: number;
  home_odds: number;
  draw_odds: number;
  away_odds: number;
}

interface Profile {
  id: string;
  risk_tier: RiskTier | null;
}

// Stable, explainable "randomness" for tie-breaking between two
// close-implied-probability outcomes — deterministic per (user, fixture) so
// a retry of this function (e.g. after a partial failure) reasons its way
// to the same pick instead of flip-flopping. Not cryptographic; just needs
// to be evenly distributed and reproducible.
function stableFraction(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return (h >>> 0) / 0xffffffff;
}

// De-vigged implied probabilities from decimal odds.
function impliedProbs(f: Fixture): { H: number; D: number; A: number } {
  const rawH = 1 / f.home_odds, rawD = 1 / f.draw_odds, rawA = 1 / f.away_odds;
  const total = rawH + rawD + rawA;
  return { H: rawH / total, D: rawD / total, A: rawA / total };
}

// How much "pressure" a user is under to gamble on a riskier pick: 0
// (leading/safe) .. 2 (well behind). Compares points to the current leader,
// not to the field average, since chasing 1st is what actually drives real
// risk-taking behavior on a leaderboard.
function pressureFromRank(row: LeaderboardRow | undefined, leaderPoints: number): 0 | 1 | 2 {
  if (!row || row.rank === 1) return 0;
  const gap = leaderPoints - row.points;
  if (gap <= 5) return 0; // effectively tied, protect it
  if (gap <= 20) return 1;
  return 2;
}

const TIER_WEIGHT: Record<RiskTier, 0 | 1 | 2> = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
};

// Picks H/D/A for one (user, fixture) pair. Always starts from the
// odds-implied favorite; only deviates to the second-best outcome when
// BOTH the user's combined aggressiveness (tier + leaderboard pressure)
// calls for it AND the odds themselves say the fixture is genuinely close
// (never "risky" against what the odds say, only within what they allow).
function choosePick(
  f: Fixture,
  tier: RiskTier,
  pressure: 0 | 1 | 2,
  seed: string,
): { pick: "H" | "D" | "A"; reasoning: Record<string, unknown> } {
  const probs = impliedProbs(f);
  const ranked = (["H", "D", "A"] as const)
    .map((k) => ({ k, p: probs[k] }))
    .sort((a, b) => b.p - a.p);
  const favorite = ranked[0];
  const runnerUp = ranked[1];

  const aggro = TIER_WEIGHT[tier] + pressure; // 0..4
  const gapToRunnerUp = favorite.p - runnerUp.p;

  // Only consider the runner-up when it's a plausible outcome (odds don't
  // treat it as a near-impossibility) and the fixture is close enough that
  // preferring it isn't just ignoring the favorite for no reason.
  const runnerUpIsPlausible = runnerUp.p >= 0.22 && gapToRunnerUp <= 0.30;

  let chosen = favorite.k;
  if (aggro >= 3 && runnerUpIsPlausible) {
    chosen = runnerUp.k;
  } else if (aggro === 2 && runnerUpIsPlausible && gapToRunnerUp <= 0.12) {
    // borderline case — deterministic coin flip on a close fixture only
    chosen = stableFraction(seed) < 0.5 ? runnerUp.k : favorite.k;
  }

  return {
    pick: chosen,
    reasoning: {
      implied_probs: probs,
      favorite: favorite.k,
      risk_tier: tier,
      pressure,
      aggro,
      chosen,
    },
  };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("AUTOPREDICT_SECRET");
  if (secret && req.headers.get("x-autopredict-secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // bypasses RLS
    { auth: { persistSession: false } },
  );

  // --- 1. fixtures that are still open AND have final odds frozen ---
  // Reproduces fixture_is_open() from schema.sql — see file header comment
  // for why this can't just rely on the RLS policy of the same name.
  const lockBefore = new Date(Date.now() + LOCK_HOURS_BEFORE_KICKOFF * 3600 * 1000).toISOString();
  const { data: fixtures, error: fErr } = await db
    .from("fixtures")
    .select("id, home_odds, draw_odds, away_odds")
    .in("status", ["SCHEDULED", "TIMED"])
    .gt("kickoff_utc", lockBefore)
    .not("home_odds", "is", null)
    .not("draw_odds", "is", null)
    .not("away_odds", "is", null);

  if (fErr) return Response.json({ error: fErr.message }, { status: 500 });
  if (!fixtures || fixtures.length === 0) {
    return Response.json({ skipped: true, reason: "no open fixtures with frozen odds" });
  }

  // --- 2. opted-in users ---
  const { data: profiles, error: pErr } = await db
    .from("profiles")
    .select("id, risk_tier")
    .eq("auto_predict_enabled", true);

  if (pErr) return Response.json({ error: pErr.message }, { status: 500 });
  if (!profiles || profiles.length === 0) {
    return Response.json({ skipped: true, reason: "no opted-in users" });
  }

  // --- 3. current leaderboard standing for those users ---
  const { data: leaderboard, error: lErr } = await db.rpc("get_leaderboard");
  if (lErr) return Response.json({ error: lErr.message }, { status: 500 });

  const rows2 = (leaderboard ?? []) as LeaderboardRow[];
  const leaderPoints = rows2.reduce((max, r) => Math.max(max, r.points), 0);
  const byUser = new Map<string, LeaderboardRow>(rows2.map((r) => [r.user_id, r]));

  // --- 4. existing predictions for these users, so we never re-derive a
  // pick for a fixture that already has one (manual or auto) ---
  const userIds = (profiles as Profile[]).map((p) => p.id);
  const fixtureIds = (fixtures as Fixture[]).map((f) => f.id);
  const { data: existing, error: eErr } = await db
    .from("predictions")
    .select("user_id, fixture_id")
    .in("user_id", userIds)
    .in("fixture_id", fixtureIds);

  if (eErr) return Response.json({ error: eErr.message }, { status: 500 });
  const already = new Set((existing ?? []).map((r) => `${r.user_id}:${r.fixture_id}`));

  // --- 5. derive + write missing picks ---
  const toWrite: Array<{
    user_id: string;
    fixture_id: number;
    pick: string;
    source: string;
    auto_reasoning: Record<string, unknown>;
  }> = [];

  for (const profile of profiles as Profile[]) {
    const tier: RiskTier = profile.risk_tier ?? "balanced";
    const pressure = pressureFromRank(byUser.get(profile.id), leaderPoints);

    for (const fixture of fixtures as Fixture[]) {
      const key = `${profile.id}:${fixture.id}`;
      if (already.has(key)) continue;

      const { pick, reasoning } = choosePick(fixture, tier, pressure, key);
      toWrite.push({
        user_id: profile.id,
        fixture_id: fixture.id,
        pick,
        source: "auto",
        auto_reasoning: reasoning,
      });
    }
  }

  if (toWrite.length === 0) {
    return Response.json({ candidates: 0, written: 0, reason: "nothing missing" });
  }

  // onConflict do-nothing: if a manual pick landed between step 4's read and
  // now, this insert is a silent no-op for that row instead of overwriting it.
  const { error: wErr, count } = await db
    .from("predictions")
    .upsert(toWrite, { onConflict: "user_id,fixture_id", ignoreDuplicates: true, count: "exact" });

  if (wErr) return Response.json({ error: wErr.message, attempted: toWrite.length }, { status: 500 });

  return Response.json({
    opted_in_users: profiles.length,
    open_fixtures: fixtures.length,
    candidates: toWrite.length,
    written: count ?? toWrite.length,
  });
});
