// EPL Predictor — fixture sync
//
// Runs on a 5-minute cron. Pulls the full PL season from
// football-data.org and upserts it into the fixtures table. Also
// manages TWO tiers of odds on each fixture (revised 06 Aug 2026 —
// see README §3/§6 for the full reasoning, and the schema.sql §4
// comment for why these are deliberately separate timers now):
//   - FINAL odds (home_odds/draw_odds/away_odds): frozen once, 24h
//     before kickoff, never touched again. This is what scoring uses.
//   - PREVIEW odds (preview_home_odds/etc): an indicative, clearly-
//     not-final value shown for anything more than 24h out, so a
//     fixture never displays literally nothing. Refreshed at most
//     every PREVIEW_REFRESH_HOURS, real market data when The Odds API
//     has it yet, otherwise left null (the frontend falls back to a
//     flat estimate) — but preview_synced_at still gets stamped
//     either way, or the throttle below would re-check every 5
//     minutes forever for any fixture too far out to be priced yet.
//   Predictions themselves lock separately, 2 hours before kickoff —
//   that's enforced by fixture_is_open() in schema.sql, not here.
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
const ODDS_FREEZE_HOURS = 24; // final odds freeze this many hours before kickoff — see schema.sql §4
const PREVIEW_REFRESH_HOURS = 4; // how often the indicative preview odds refresh before that

// The Odds API's team names for EPL vs football-data.org's shortName
// convention (the column this project actually stores in
// fixtures.home_team/away_team). Confirmed 06 Aug 2026 by comparing a
// live `GET /v4/sports/soccer_epl/odds` response against every
// distinct team name in the live fixtures table — all 20 clubs
// matched exactly, no misses. That was checked before any fixture had
// actually entered the 24-hour freeze window (season hadn't started),
// so re-verify odds_debug.matched vs due_fixtures once real games are
// close, in case The Odds API changes a name mid-season (promoted/
// relegated clubs next season are the likeliest source of a miss).
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

  // --- 6. two-tier odds: freeze FINAL odds for fixtures entering the
  // 24h window, and refresh the indicative PREVIEW for everything
  // beyond that (throttled). One shared API fetch covers both, since
  // The Odds API returns the whole EPL slate in a single call
  // regardless of how many fixtures we actually need from it.
  let oddsSynced = 0;
  let previewSynced = 0;
  const oddsDebug: Record<string, unknown> = {};
  const oddsKey = Deno.env.get("ODDS_API_KEY");

  if (!oddsKey) {
    oddsDebug.skipped = "ODDS_API_KEY not set";
  } else {
    try {
      const freezeWindowEnd = new Date(Date.now() + ODDS_FREEZE_HOURS * 3600 * 1000).toISOString();
      const previewStaleBefore = new Date(Date.now() - PREVIEW_REFRESH_HOURS * 3600 * 1000).toISOString();

      // fixtures entering the 24h freeze window, not yet frozen
      const { data: dueFixtures, error: dueErr } = await db
        .from("fixtures")
        .select("id, home_team, away_team")
        .in("status", ["SCHEDULED", "TIMED"])
        .lte("kickoff_utc", freezeWindowEnd)
        .gt("kickoff_utc", now)
        .is("home_odds", null);

      oddsDebug.due_fixtures = dueFixtures?.length ?? 0;
      if (dueErr) oddsDebug.due_error = dueErr.message;

      // fixtures still more than 24h out, due for a preview refresh
      // (never checked, or checked more than PREVIEW_REFRESH_HOURS ago)
      const { data: previewFixtures, error: previewErr } = await db
        .from("fixtures")
        .select("id, home_team, away_team")
        .in("status", ["SCHEDULED", "TIMED"])
        .gt("kickoff_utc", freezeWindowEnd)
        .is("home_odds", null)
        .or(`preview_synced_at.is.null,preview_synced_at.lt.${previewStaleBefore}`);

      oddsDebug.preview_due_fixtures = previewFixtures?.length ?? 0;
      if (previewErr) oddsDebug.preview_due_error = previewErr.message;

      const needFetch = (dueFixtures && dueFixtures.length > 0) ||
        (previewFixtures && previewFixtures.length > 0);

      if (needFetch) {
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

          // --- freeze final odds ---
          if (dueFixtures && dueFixtures.length > 0) {
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
          }

          // --- refresh preview odds. Stamp EVERY attempted fixture,
          // matched or not — otherwise a fixture too far out to be
          // priced yet would never get a preview_synced_at value and
          // would keep getting re-fetched on every 5-minute tick
          // forever instead of every PREVIEW_REFRESH_HOURS. ---
          if (previewFixtures && previewFixtures.length > 0) {
            const previewRows = previewFixtures.map((f) => {
              const p = priceByTeamPair.get(`${f.home_team}|${f.away_team}`);
              return {
                id: f.id,
                home_odds: p?.h ?? null,
                draw_odds: p?.d ?? null,
                away_odds: p?.a ?? null,
              };
            });
            const matchedCount = previewRows.filter((r) => r.home_odds != null).length;
            oddsDebug.preview_matched = matchedCount;
            oddsDebug.preview_attempted = previewRows.length;

            const { error } = await db.rpc("set_fixture_preview_odds", { rows: previewRows });
            if (error) oddsDebug.preview_write_error = error.message;
            else previewSynced = matchedCount;
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
    odds_synced: oddsSynced, preview_synced: previewSynced, odds_debug: oddsDebug,
  });
});
