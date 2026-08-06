// EPL Predictor — fixture sync
//
// Runs on a 5-minute cron. Pulls the full PL season from
// football-data.org and upserts it into the fixtures table. Also
// freezes 1X2 odds onto any fixture that's entered its 2-hour-before-
// kickoff lock window and doesn't have odds yet — see README §5/§6
// for why odds are locked at T-2h rather than fetched live, and why
// this replaced flat scoring (again — this is the second dynamic
// formula this project has tried; read the history before reverting).
//
// Why server-side:
//   - API tokens never reach the browser
//   - upstream rate limits are shared budgets; one caller instead of N users
//
// Env (set with `supabase secrets set`):
//   FOOTBALL_DATA_TOKEN  — your free football-data.org token
//   ODDS_API_KEY         — your free the-odds-api.com key
//   SYNC_SECRET           — any long random string; the cron sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COMPETITION = "PL";
const MIN_INTERVAL_SECONDS = 60; // upstream guard: never poll faster than this
const ODDS_LOCK_HOURS = 2; // MUST match the interval in fixture_is_open() in schema.sql

// The Odds API's team names for EPL vs football-data.org's shortName
// convention (the column this project actually stores in
// fixtures.home_team/away_team). Best-effort mapping, NOT yet
// confirmed against a live API response the way the old ClubElo
// mapping was (that one was checked against real data before being
// trusted — this one hasn't been able to be, yet, for lack of an API
// key at write time). Verify this against a real `?force=1` run's
// odds_debug output the first time it's used, and fix any misses.
const ODDS_API_TO_FD: Record<string, string> = {
  "Arsenal": "Arsenal",
  "Aston Villa": "Aston Villa",
  "Bournemouth": "Bournemouth",
  "AFC Bournemouth": "Bournemouth",
  "Brentford": "Brentford",
  "Brighton and Hove Albion": "Brighton Hove",
  "Brighton & Hove Albion": "Brighton Hove",
  "Chelsea": "Chelsea",
  "Coventry City": "Coventry City",
  "Crystal Palace": "Crystal Palace",
  "Everton": "Everton",
  "Fulham": "Fulham",
  "Hull City": "Hull City",
  "Ipswich Town": "Ipswich Town",
  "Leeds United": "Leeds United",
  "Liverpool": "Liverpool",
  "Manchester City": "Man City",
  "Manchester United": "Man United",
  "Newcastle United": "Newcastle",
  "Nottingham Forest": "Nottingham",
  "Nott'm Forest": "Nottingham",
  "Sunderland": "Sunderland",
  "Tottenham Hotspur": "Tottenham",
  "Tottenham": "Tottenham",
};

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

  // --- 6. freeze 1X2 odds onto fixtures that just entered the lock
  // window (kickoff - ODDS_LOCK_HOURS <= now < kickoff) and don't have
  // odds yet. Deliberately not written any earlier than that, same
  // reasoning as every other "frozen near kickoff" value this project
  // has used — the number should reflect close-to-final market
  // pricing, not something from days out. Once written, never
  // touched again (enforced by only selecting fixtures with
  // home_odds is null below).
  let oddsSynced = 0;
  const oddsDebug: Record<string, unknown> = {};
  const oddsKey = Deno.env.get("ODDS_API_KEY");

  if (!oddsKey) {
    oddsDebug.skipped = "ODDS_API_KEY not set";
  } else {
    try {
      const lockWindowEnd = new Date(Date.now() + ODDS_LOCK_HOURS * 3600 * 1000).toISOString();
      const { data: dueFixtures, error: dueErr } = await db
        .from("fixtures")
        .select("id, home_team, away_team")
        .in("status", ["SCHEDULED", "TIMED"])
        .lte("kickoff_utc", lockWindowEnd)
        .gt("kickoff_utc", now)
        .is("home_odds", null);

      oddsDebug.due_fixtures = dueFixtures?.length ?? 0;
      if (dueErr) oddsDebug.due_error = dueErr.message;

      if (dueFixtures && dueFixtures.length > 0) {
        const res = await fetch(
          `https://api.the-odds-api.com/v4/sports/soccer_epl/odds/?apiKey=${oddsKey}&regions=uk&markets=h2h&oddsFormat=decimal`,
        );
        oddsDebug.http_status = res.status;

        if (res.ok) {
          const events = await res.json() as Array<Record<string, any>>;
          oddsDebug.events_returned = events.length;

          const priceByTeamPair = new Map<string, { h: number; d: number; a: number }>();
          for (const ev of events) {
            const home = ODDS_API_TO_FD[ev.home_team] ?? ev.home_team;
            const away = ODDS_API_TO_FD[ev.away_team] ?? ev.away_team;
            const market = ev.bookmakers?.[0]?.markets?.find((m: any) => m.key === "h2h");
            if (!market) continue;
            const outcomes = market.outcomes as Array<{ name: string; price: number }>;
            const homePrice = outcomes.find((o) => (ODDS_API_TO_FD[o.name] ?? o.name) === home)?.price;
            const awayPrice = outcomes.find((o) => (ODDS_API_TO_FD[o.name] ?? o.name) === away)?.price;
            const drawPrice = outcomes.find((o) => o.name === "Draw")?.price;
            if (homePrice && awayPrice && drawPrice) {
              priceByTeamPair.set(`${home}|${away}`, { h: homePrice, d: drawPrice, a: awayPrice });
            }
          }
          oddsDebug.epl_pairs_found = priceByTeamPair.size;

          const oddsRows = dueFixtures
            .map((f) => {
              const p = priceByTeamPair.get(`${f.home_team}|${f.away_team}`);
              if (!p) return null;
              return { id: f.id, home_odds: p.h, draw_odds: p.d, away_odds: p.a };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          oddsDebug.matched = oddsRows.length;

          if (oddsRows.length > 0) {
            const { error } = await db.rpc("set_fixture_odds", { rows: oddsRows });
            if (error) oddsDebug.write_error = error.message;
            else oddsSynced = oddsRows.length;
          }
        } else {
          oddsDebug.body = (await res.text()).slice(0, 300);
        }
      }
      // Odds failure is non-fatal — fixtures/scores already synced above.
      // score() falls back to flat +5/+6 automatically when home_odds
      // is null, so a due fixture that misses this window just scores
      // flat instead of odds-based. See schema.sql §5.
    } catch (e) {
      oddsDebug.exception = String(e);
    }
  }

  return Response.json({
    synced: rows.length, live, at: now,
    odds_synced: oddsSynced, odds_debug: oddsDebug,
  });
});
