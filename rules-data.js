/* ============================================================
   Redfooty EPL Predictor — rules & prizes, single source of truth.
   Loaded by both Landing_Page.html and epl-predictor.html so the two
   never drift. Edit here; both pages pick it up automatically.

   Prizes are explicitly tentative (per the project owner, Aug 2026) —
   change PRIZES freely, nothing else needs to change.
   ============================================================ */

const REDFOOTY_RULES = {
  season: "2026/27",
  totalGameweeks: 38,
  eligibilityGameweeks: 29, // 75% of 38
  eligibilityPct: 75,
  scoring: { win: 5, draw: 6, wrong: 0 },
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
        "Correct result (home or away win): +5 points.",
        "Correct draw: +6 points — weighted higher, since draws are statistically harder to call.",
        "Incorrect prediction: 0 points. There is no negative scoring.",
        "Predictions lock at kickoff for each fixture and cannot be changed after that point.",
      ],
    },
    {
      title: "The 75% Participation Rule",
      points: [
        "The Premier League season runs 38 gameweeks.",
        "A player must submit at least one prediction in 75% of gameweeks (29 of 38) to remain eligible for a prize.",
        "“Submitting a gameweek” means predicting at least one fixture in that gameweek before it locks — partial gameweeks still count toward the 75% threshold, but only correctly-predicted fixtures earn points.",
        "Players below the threshold can keep playing and appear on the leaderboard, but are flagged as “not currently eligible” and cannot claim a top-3 prize even if their points would otherwise qualify.",
        "Postponed or abandoned fixtures are excluded from both scoring and the participation count, for everyone.",
      ],
    },
    {
      title: "Tie-Breakers",
      points: [
        "1. Higher number of correctly predicted draws (rewards the harder skill).",
        "2. Higher gameweek participation percentage.",
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
        "Each fixture's predictions lock at its official kickoff time (IST).",
        "The app shows a live countdown per fixture — no predictions are accepted after lock, no exceptions for missed deadlines.",
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
