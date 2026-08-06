/* ============================================================
   Redfooty EPL Predictor — rules & prizes, single source of truth.
   Loaded by both Landing_Page.html and epl-predictor.html so the two
   never drift. Edit here; both pages pick it up automatically.

   Prizes are explicitly tentative (per the project owner, Aug 2026) —
   change PRIZES freely, nothing else needs to change.
   ============================================================ */

const REDFOOTY_RULES = {
  season: "2026/27",
  eligibilityPct: 75, // of matches completed so far — a rolling window, not a fixed season total
  predictionLockHours: 2, // predictions close this many hours before kickoff
  // Revised 06 Aug 2026: the odds freeze and the prediction lock are two
  // separate timers now, not one. Odds go final 24h out, giving a long
  // stable window before the 2h prediction lock; before that 24h freeze,
  // the app shows a clearly-marked (~) indicative estimate instead of
  // nothing. See "How Scoring Works" below for the full explanation.
  oddsFreezeHours: 24,
  // Fallback scoring when a fixture has no odds data at all yet (too far
  // out for even an estimate, or the odds fetch failed) — same numbers as
  // the flat system this replaced, still used as the safety net.
  scoring: { win: 5, draw: 6, wrong: 0 },
  // Odds-based scoring, used once a fixture has final (or, for the ~
  // estimate, preview) odds on file: clamp(round(multiplier x odds),
  // floor, ceiling). At odds 2.5 a correct win scores exactly
  // `scoring.win` (5); at odds 3.0 a correct draw scores exactly
  // `scoring.draw` (6) — the two systems agree exactly at a coin-flip and
  // only diverge where the odds say a pick was more or less obvious than
  // that.
  oddsFormula: { multiplier: 2, floor: 4, ceiling: 10 },
  contactEmail: "predictorepl@gmail.com",

  prizes: [
    {
      place: "1st",
      title: "Jersey of your choice + Dinner for Two",
      detail: "An original club jersey — any player, any season — plus dinner for two on Redfooty. Arranged within 7 days of the final gameweek.",
    },
    {
      place: "2nd",
      title: "₹5,000 cash + Dinner for Two",
      detail: "Cash transferred via UPI/bank transfer, plus dinner for two, within 7 days of the final gameweek.",
    },
    {
      place: "3rd",
      title: "₹5,000 cash",
      detail: "Cash transferred via UPI/bank transfer within 7 days of the final gameweek.",
    },
  ],

  rulesSections: [
    {
      title: "Eligibility & Entry",
      points: [
        "Open to residents of India, aged 18 and above at the time of registration.",
        "One account per person — tied to one unique email and one unique phone number, both verified by a one-time code before the account is active.",
        "Duplicate accounts (same person, multiple emails/numbers) will be merged or removed at Redfooty's discretion, and forfeit any accumulated points.",
        "Employees, moderators, or immediate family of anyone involved in operating Redfooty or judging the competition are welcome to play but are not eligible to win prizes.",
        "Registration stays open all season, but points can only be earned for gameweeks predicted after signup — there is no retroactive scoring.",
      ],
    },
    {
      title: "How Scoring Works",
      points: [
        "Each fixture offers three outcomes to predict: Home Win, Draw, Away Win.",
        "Points are based on real bookmaker odds: the less likely your correct pick was, the more it's worth. Calling a heavy favourite correctly is worth less than calling a genuine upset. A correct pick scores between 4 and 10 points once odds are final for that fixture.",
        "Odds go final (frozen, permanent) 24 hours before kickoff — not at the same moment predictions close. Once final, the point value shown is exactly what you'll be scored on if you're right, and it will not change again.",
        "Before that 24-hour mark, the app shows a point value with a ~ in front of it (like ~7) — an estimate, not a promise. It reflects the current market where real odds are already available, or a flat placeholder where they aren't yet, and it can move as the real odds move, right up until it freezes at the 24-hour mark. Predicting on a ~ value means accepting the final number may differ once it freezes — that's the deal, stated plainly.",
        "Why estimate at all instead of just freezing odds right away? Bookmaker odds are least reliable days out and most reliable close to kickoff — freezing too early would lock in a worse number for everyone. The 24-hour window is a deliberate middle ground: real, current information as early as it's meaningfully available, without pretending a week-out number is final when it can't be.",
        "If a fixture has no odds data on file at all (nothing from the market yet, or a fetch failure), scoring falls back to a flat +5 for a correct win, +6 for a correct draw — the same numbers this project used before switching to odds. This fallback is itself shown with a ~ before the 24-hour freeze, same as any other estimate.",
        "Incorrect prediction: 0 points, always. There is no negative scoring.",
        "Predictions stay open until 2 hours before kickoff — a separate deadline from the 24-hour odds freeze, see Prediction Deadlines below.",
      ],
    },
    {
      title: "The 75% Participation Rule",
      points: [
        "Prize eligibility is based on 75% of matches — not gameweeks — and it's a rolling requirement, recalculated continuously as the season goes on.",
        "Specifically: of all the matches that have finished so far this season, you must have predicted at least 75% of them to be currently eligible for a prize. Example: if 30 matches have been completed and you predicted 15 of them, that's 50% — below the threshold, not eligible right now.",
        "Because it's rolling, your eligibility can move up or down as the season progresses — it's always measured against matches played to date, not a fixed target set once at the start.",
        "Players below the threshold can keep playing and appear on the leaderboard, but are flagged as “not currently eligible” and cannot claim a top-3 prize unless they're back above 75% by the time the season ends.",
        "Postponed or abandoned fixtures are excluded from both scoring and the participation count, for everyone — they're simply never counted as \"completed.\"",
      ],
    },
    {
      title: "Tie-Breakers",
      points: [
        "1. Higher number of correctly predicted draws (rewards the harder skill).",
        "2. Higher match participation percentage.",
        "3. Earlier account registration date.",
        "4. If still tied, a sudden-death predictor question on the final matchday decides it.",
      ],
    },
    {
      title: "Fair Play & Disqualification",
      points: [
        "One person, one account. Using multiple accounts, bots, or scripts to submit predictions is grounds for disqualification and forfeiture of all points.",
        "Redfooty reserves the right to review any account showing suspicious patterns before finalising prizes.",
        "Abuse, harassment, or spam directed at other players or Redfooty staff results in removal from the competition.",
      ],
    },
    {
      title: "Prediction Deadlines",
      points: [
        "Each fixture's predictions lock 2 hours before its official kickoff time (IST) — not at kickoff itself, and not at the same moment odds go final (see How Scoring Works above; that happens separately, 24 hours out).",
        "The 2-hour cutoff mainly closes the window before official starting lineups are typically confirmed, so nobody's predicting with knowledge of the actual XI. It's the same deadline regardless of when a fixture's odds froze.",
        "The app shows a live countdown per fixture to that 2-hour mark — no predictions are accepted after lock, no exceptions for missed deadlines.",
      ],
    },
    {
      title: "Disputes",
      points: [
        "Any scoring or eligibility dispute must be raised within 7 days of the gameweek results being published.",
        "Redfooty's decision on scoring, eligibility, and prize allocation is final.",
      ],
    },
  ],
};
