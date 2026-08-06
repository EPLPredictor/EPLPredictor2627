# CLAUDE.md — Redfooty EPL Predictor

Project-specific rules for any Claude Code session working in this repo. Read this
before running anything against the live Supabase project.

## Database safety — real user data lives here

As of Aug 2026 this is **not a disposable test database**. Real people — including the
project owner and outside testers — sign up here. An incident on 06 Aug 2026 is the
reason this rule exists: a cleanup script called an admin API "list users by email"
endpoint expecting it to return one test account, got back 5 unrelated users instead
(the filter didn't work the way it looked like it would), and a blind delete loop wiped
all of them — including 3 real accounts, one belonging to someone outside the immediate
team who'd signed up in good faith. It happened because the delete ran against an
unverified query result instead of an ID already known to be correct.

**Rules going forward:**

- **Never delete (or bulk-update) based on a filtered/searched list without printing the
  full result set and verifying every entry first.** A query "scoped" by email, name, or
  any other filter is not proof it only matches what you intended.
- When cleaning up test users/data created during a session: **capture the exact ID(s) at
  creation time** and delete only those specific IDs. Don't delete by a broader filter
  (email pattern, "recently created," "looks like a test account," etc.) even if it seems
  safe.
- If a query result might contain real user data and you're not certain, **stop and ask
  before running any delete or destructive update against it** — don't proceed on an
  assumption.
- This applies to every table, not just `auth.users`/`profiles` — `predictions`,
  `reminder_log`, anything with real rows now.
