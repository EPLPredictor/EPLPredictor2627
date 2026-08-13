// EPL Predictor — reminder emails
//
// Runs once daily at 23:55 IST (18:25 UTC) — 5 minutes before Brevo's
// free-plan daily send quota resets at midnight IST (confirmed with
// Brevo support 13 Aug 2026). Finds the current gameweek (the earliest
// matchday that still has an open fixture), and emails players who
// haven't predicted any fixture in it yet and haven't already been
// sent a reminder for it this gameweek.
//
// OTP registration/login emails share this same Brevo account and
// daily quota — different send path (SMTP relay vs this function's
// transactional API call), same 300/day pool. Running this batch late
// in the day, capped to whatever Brevo reports as still unused at call
// time (see getRemainingSendQuota below), means reminders only ever
// spend leftover capacity after that day's OTP demand has already had
// first claim on it — they never compete for the same credits. If the
// quota check itself fails, the run is skipped rather than guessing a
// batch size — reminder_log dedup (per gameweek) means anyone missed
// today just rolls into tomorrow's run automatically, no extra
// backlog bookkeeping needed here.
//
// Env (set with `supabase secrets set`):
//   BREVO_API_KEY   — Brevo transactional email API key (starts xkeysib-)
//   REMINDER_SECRET — any long random string; the cron sends it back
// Injected automatically by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Used only once a paid Brevo plan removes the daily cap entirely (no
// "sendLimit" entry in the account response) — a ceiling on a single
// run, not a guess at remaining quota.
const UNCAPPED_PLAN_BATCH_LIMIT = 100000;
const SENDER_EMAIL = "predictorepl@gmail.com";
const SENDER_NAME = "Redfooty EPL Predictor";
const APP_URL = "https://redfooty-epl-predictor.netlify.app/predict";

// Brevo's GET /v3/account reports plan[].credits as the *remaining*
// send allowance for the current day (creditsType "sendLimit"), live-
// updating as sends go out and resetting to the plan total at the
// daily reset. Returns null if the check itself couldn't be trusted
// (network/API failure) — caller must not guess a fallback number.
async function getRemainingSendQuota(brevoKey: string): Promise<number | null> {
  const res = await fetch("https://api.brevo.com/v3/account", {
    headers: { "api-key": brevoKey, "Accept": "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const plans = Array.isArray(data?.plan) ? data.plan : [];
  const sendLimitPlan = plans.find((p: { creditsType?: string }) => p.creditsType === "sendLimit");
  if (!sendLimitPlan) return UNCAPPED_PLAN_BATCH_LIMIT; // paid plan, no daily cap
  return typeof sendLimitPlan.credits === "number" ? sendLimitPlan.credits : null;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("REMINDER_SECRET");
  if (secret && req.headers.get("x-reminder-secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const brevoKey = Deno.env.get("BREVO_API_KEY");
  if (!brevoKey) return new Response("BREVO_API_KEY not set", { status: 500 });

  // --- 0. how much Brevo send quota is actually left today? OTP always
  // gets first claim on it during the day — this run only spends what's
  // still unused, and skips entirely rather than risk guessing wrong.
  const batchLimit = await getRemainingSendQuota(brevoKey);
  if (batchLimit === null) {
    return Response.json({ skipped: true, reason: "could not read Brevo quota; not guessing a batch size" });
  }
  if (batchLimit <= 0) {
    return Response.json({ skipped: true, reason: "no Brevo quota remaining today" });
  }

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

  // --- 2. up to `batchLimit` (today's remaining Brevo quota) players who
  // haven't predicted this gameweek and haven't already been reminded ---
  const { data: candidates, error: cErr } = await db.rpc("reminder_candidates", {
    target_matchday: matchday,
    batch_limit: batchLimit,
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
