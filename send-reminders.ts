// EPL Predictor — reminder emails
//
// Runs on a daily cron. Finds the current gameweek (the earliest
// matchday that still has an open fixture), and emails every
// registered player who hasn't predicted any fixture in it yet and
// hasn't already been sent a reminder for it this gameweek.
//
// Deliberately simple, by request (see README §11): no 48h/6h timing
// rule, just "who's still pending, once a day." Capped at 300 sends
// per run — Brevo's free-tier daily limit — so a large pending list
// just rolls over to the next day's run automatically; reminder_log
// dedup means nobody already emailed gets emailed again for the same
// gameweek, so the batch naturally works through the backlog over a
// few days without any extra bookkeeping here.
//
// Env (set with `supabase secrets set`):
//   BREVO_API_KEY   — Brevo transactional email API key (starts xkeysib-)
//   REMINDER_SECRET — any long random string; the cron sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BATCH_LIMIT = 300;
const SENDER_EMAIL = "predictorepl@gmail.com";
const SENDER_NAME = "Redfooty EPL Predictor";
const APP_URL = "https://redfooty-epl-predictor.netlify.app/predict";

Deno.serve(async (req) => {
  const secret = Deno.env.get("REMINDER_SECRET");
  if (secret && req.headers.get("x-reminder-secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const brevoKey = Deno.env.get("BREVO_API_KEY");
  if (!brevoKey) return new Response("BREVO_API_KEY not set", { status: 500 });

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // bypasses RLS
    { auth: { persistSession: false } },
  );

  // --- 1. find the current gameweek: earliest matchday with an open fixture ---
  const { data: openFixture, error: fErr } = await db
    .from("fixtures")
    .select("matchday")
    .in("status", ["SCHEDULED", "TIMED"])
    .order("matchday", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fErr) return Response.json({ error: fErr.message }, { status: 500 });
  if (!openFixture || openFixture.matchday == null) {
    return Response.json({ skipped: true, reason: "no open gameweek" });
  }
  const matchday = openFixture.matchday;

  // --- 2. up to 300 players who haven't predicted this gameweek and
  // haven't already been reminded about it ---
  const { data: candidates, error: cErr } = await db.rpc("reminder_candidates", {
    target_matchday: matchday,
    batch_limit: BATCH_LIMIT,
  });
  if (cErr) return Response.json({ error: cErr.message }, { status: 500 });
  if (!candidates || candidates.length === 0) {
    return Response.json({ matchday, sent: 0, reason: "no pending candidates" });
  }

  // --- 3. send each one via Brevo's transactional email API ---
  let sent = 0;
  const failures: string[] = [];
  for (const c of candidates) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": brevoKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        sender: { email: SENDER_EMAIL, name: SENDER_NAME },
        to: [{ email: c.email, name: c.full_name || undefined }],
        subject: `Gameweek ${matchday} is open — predict now`,
        htmlContent: `
          <p>Hi ${c.full_name || "there"},</p>
          <p>Gameweek ${matchday} is open and you haven't predicted any of its fixtures yet.</p>
          <p><a href="${APP_URL}">Predict now</a> to stay on track for the 75% eligibility rule.</p>
          <p>— Redfooty EPL Predictor</p>
        `,
      }),
    });

    if (res.ok) {
      sent++;
      const { error: logErr } = await db.from("reminder_log").insert({
        user_id: c.user_id,
        matchday,
      });
      if (logErr) failures.push(`log-insert ${c.user_id}: ${logErr.message}`);
    } else {
      failures.push(`send ${c.user_id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  return Response.json({
    matchday,
    candidates: candidates.length,
    sent,
    failures: failures.slice(0, 5),
  });
});
