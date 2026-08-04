// EPL Predictor — fixture sync
//
// Runs on a 5-minute cron. Pulls the full PL season and current standings
// from football-data.org, and — only for fixtures within 2 hours of
// kickoff — a locked win/draw/loss probability from ClubElo (free, no key).
//
// Why server-side (brief §4.4):
//   - the API token never reaches the browser
//   - 10 req/min is a shared budget; one caller instead of N users
//
// Up to 3 upstream calls per run now (matches + standings always; ClubElo
// only when a fixture is actually due to lock) — still nowhere near 10/min.
//
// Env (set with `supabase secrets set`):
//   FOOTBALL_DATA_TOKEN  — your free football-data.org token
//   SYNC_SECRET          — any long random string; the cron sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COMPETITION = "PL";
const MIN_INTERVAL_SECONDS = 60; // upstream guard: never poll faster than this
const CLUBELO_LOCK_HOURS = 2; // only lock in a probability this close to kickoff

// ClubElo's own name for each club -> the exact string football-data.org
// uses as home_team/away_team in our fixtures table (confirmed against
// live data from both sources, not guessed — see HANDOVER §12 rev 5).
const CLUBELO_TO_FD: Record<string, string> = {
  "Arsenal": "Arsenal",
  "Aston Villa": "Aston Villa",
  "Bournemouth": "Bournemouth",
  "Brentford": "Brentford",
  "Brighton": "Brighton Hove",
  "Chelsea": "Chelsea",
  "Coventry": "Coventry City",
  "Crystal Palace": "Crystal Palace",
  "Everton": "Everton",
  "Fulham": "Fulham",
  "Hull": "Hull City",
  "Ipswich": "Ipswich Town",
  "Leeds": "Leeds United",
  "Liverpool": "Liverpool",
  "Man City": "Man City",
  "Man United": "Man United",
  "Newcastle": "Newcastle",
  "Forest": "Nottingham",
  "Sunderland": "Sunderland",
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

  // --- 6. freeze table position onto fixtures that haven't kicked off yet ---
  //
  // Used for the upset bonus in scoring (brief: pick-based prediction, points
  // scaled by how far apart the two teams sit in the table). Only written for
  // SCHEDULED/TIMED fixtures — once a match starts we stop overwriting these
  // two columns, so the position captured is "as of just before kickoff",
  // never a value looked up after the fact.
  let standingsSynced = 0;
  let standingsDebug: Record<string, unknown> = {};
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${COMPETITION}/standings`,
      { headers: { "X-Auth-Token": token } },
    );
    standingsDebug.http_status = res.status;
    if (res.ok) {
      const payload = await res.json();
      standingsDebug.season = payload?.season ?? null;
      const types = (payload?.standings ?? []).map((s: any) => s.type);
      standingsDebug.standings_types = types;
      const table = payload?.standings?.find((s: any) => s.type === "TOTAL")?.table ?? [];
      standingsDebug.total_table_length = table.length;
      standingsDebug.sample_row = table[0] ?? null;
      const posMap = new Map<number, { position: number; points: number }>();
      for (const entry of table) {
        if (entry?.team?.id != null) {
          posMap.set(entry.team.id, { position: entry.position, points: entry.points });
        }
      }
      standingsDebug.posmap_size = posMap.size;

      if (posMap.size > 0) {
        const posRows = matches
          .map((raw) => raw as Record<string, any>)
          .filter((m) => ["SCHEDULED", "TIMED"].includes(m.status) && m.id)
          .map((m) => {
            const home = posMap.get(m.homeTeam?.id);
            const away = posMap.get(m.awayTeam?.id);
            if (!home || !away) return null;
            return {
              id: m.id,
              home_position: home.position,
              away_position: away.position,
              home_points: home.points,
              away_points: away.points,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        standingsDebug.pos_rows_built = posRows.length;

        for (let i = 0; i < posRows.length; i += CHUNK) {
          const { error } = await db.rpc("set_fixture_positions", {
            rows: posRows.slice(i, i + CHUNK),
          });
          if (error) standingsDebug.upsert_error = error.message;
          if (!error) standingsSynced += posRows.slice(i, i + CHUNK).length;
        }
      }
    } else {
      standingsDebug.body = (await res.text()).slice(0, 300);
    }
    // Standings failure is non-fatal — fixtures/scores already synced above.
    // Worst case, upcoming fixtures fall back to the flat "no standings yet"
    // score of 5 points for a correct win pick.
  } catch (e) {
    standingsDebug.exception = String(e);
  }

  const live = rows.filter((r) => ["IN_PLAY", "PAUSED"].includes(r.status)).length;

  // --- 7. lock a ClubElo win/draw/loss probability onto fixtures within
  // CLUBELO_LOCK_HOURS of kickoff — deliberately not written any earlier,
  // so the number reflects near-final form/team-news rather than a stale
  // figure from days out. Once written, never touched again (same freeze
  // pattern as home_position, enforced by only selecting fixtures still
  // in the lock window below).
  let clubeloSynced = 0;
  const clubeloDebug: Record<string, unknown> = {};
  try {
    const windowEnd = new Date(Date.now() + CLUBELO_LOCK_HOURS * 3600 * 1000).toISOString();
    const { data: dueFixtures, error: dueErr } = await db
      .from("fixtures")
      .select("id, home_team, away_team")
      .in("status", ["SCHEDULED", "TIMED"])
      .lte("kickoff_utc", windowEnd)
      .gt("kickoff_utc", now)
      .is("home_win_prob", null);

    clubeloDebug.due_fixtures = dueFixtures?.length ?? 0;
    if (dueErr) clubeloDebug.due_error = dueErr.message;

    if (dueFixtures && dueFixtures.length > 0) {
      const res = await fetch("https://api.clubelo.com/Fixtures");
      clubeloDebug.http_status = res.status;
      if (res.ok) {
        const csv = await res.text();
        const lines = csv.trim().split("\n");
        const probByTeamPair = new Map<string, { h: number; d: number; a: number }>();

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          if (cols.length < 17) continue;
          const home = CLUBELO_TO_FD[cols[2]];
          const away = CLUBELO_TO_FD[cols[3]];
          if (!home || !away) continue;

          // GD>0 columns (indices 11-16) = home win; GD=0 (index 10) = draw;
          // GD<0 columns (indices 4-9) = away win. See HANDOVER §12 rev 6.
          const nums = cols.slice(4, 17).map((v) => parseFloat(v) || 0);
          const awayWin = nums.slice(0, 6).reduce((a, b) => a + b, 0); // GD<-5..GD=-1
          const draw = nums[6]; // GD=0
          const homeWin = nums.slice(7, 13).reduce((a, b) => a + b, 0); // GD=1..GD>5

          probByTeamPair.set(`${home}|${away}`, { h: homeWin, d: draw, a: awayWin });
        }
        clubeloDebug.epl_rows_found = probByTeamPair.size;

        const probRows = dueFixtures
          .map((f) => {
            const p = probByTeamPair.get(`${f.home_team}|${f.away_team}`);
            if (!p) return null;
            return { id: f.id, home_win_prob: p.h, draw_prob: p.d, away_win_prob: p.a };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        clubeloDebug.matched = probRows.length;

        if (probRows.length > 0) {
          const { error } = await db.rpc("set_fixture_probabilities", { rows: probRows });
          if (error) clubeloDebug.write_error = error.message;
          else clubeloSynced = probRows.length;
        }
      } else {
        clubeloDebug.body = (await res.text()).slice(0, 300);
      }
    }
    // ClubElo failure is non-fatal — score() falls back to the standings-gap
    // formula automatically when home_win_prob is null. See 06_...sql.
  } catch (e) {
    clubeloDebug.exception = String(e);
  }

  return Response.json({
    synced: rows.length, live, standings_synced: standingsSynced, standings_debug: standingsDebug,
    clubelo_synced: clubeloSynced, clubelo_debug: clubeloDebug, at: now,
  });
});
