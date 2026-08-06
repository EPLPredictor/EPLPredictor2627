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
  lockHours: 2, // predictions + odds both lock this many hours before kickoff
  // Fallback scoring when a fixture has no locked odds (either it hasn't hit
  // the lockHours window yet, or the odds fetch failed) — same numbers as
  // the flat system this replaced, still used as the safety net.
  scoring: { win: 5, draw: 6, wrong: 0 },
  // Odds-based scoring, used whenever a fixture has locked odds:
  // clamp(round(multiplier x odds), floor, ceiling). At odds 2.5 a correct
  // win scores exactly `scoring.win` (5); at odds 3.0 a correct draw scores
  // exactly `scoring.draw` (6) — the two systems agree exactly at a
  // coin-flip and only diverge where the odds say a pick was more or less
  // obvious than that.
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
        "Points are based on real bookmaker odds, frozen 2 hours before kickoff: the less likely your correct pick was, the more it's worth. Calling a heavy favourite correctly is worth less than calling a genuine upset.",
        "Concretely: a correct pick scores between 4 and 10 points, scaled to the odds at freeze time. A coin-flip pick (odds around 2.5–3.0) scores close to the old flat 5/6 — the scale only really diverges from that for picks that were clearly more or less likely than even.",
        "If odds aren't available for a fixture (too early before kickoff, or a data hiccup), scoring falls back to a flat +5 for a correct win, +6 for a correct draw — the same numbers this project used before switching to odds.",
        "Incorrect prediction: 0 points, always. There is no negative scoring.",
        "Predictions lock 2 hours before kickoff, not at kickoff — see Prediction Deadlines below for why.",
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
        "Each fixture's predictions lock 2 hours before its official kickoff time (IST) — not at kickoff itself.",
        "That's deliberate, not a buffer for buffer's sake: match odds also freeze at the same 2-hour mark, and locking predictions at a different time would let someone pick using information (team news, lineups) that's newer than the odds their points are based on.",
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
