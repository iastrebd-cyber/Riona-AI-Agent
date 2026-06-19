# Rate Limits, Warm-up & Cooldowns

Practical safety guide for running Insta AI Agent without tripping Instagram's
anti-automation systems. Tuned conservatively because the working account was
previously hit by a reCAPTCHA/checkpoint block.

All values below are set via environment variables (see `.env`). The numbers
shown are the **warm-up** defaults; code defaults live in `src/config/igProfile.ts`
and the per-engine getters in `src/client/IG-bot/IgClient.ts`.

## What actually gets accounts blocked (in order of risk)

1. **Round-the-clock activity.** A real person is not on Instagram 24/7. Running
   the infinite agent loop all day is itself a bot signal — more than the raw
   action count.
2. **Comments / replies.** The spammiest-looking action, especially in bursts.
3. **Bursts without spacing.** Many actions within a minute.
4. **Hard restart after a block.** Resuming at full speed right after a flag.
5. Likes are relatively safe; story **views** are nearly free (passive).

## Golden rules

- **Do NOT enable the 24/7 loop** (`IG_AGENT_ENABLED=false`). Run discrete
  sessions via the runners 1–2× per day, in daytime hours.
- One shared daily ceiling governs everything: `IG_DAILY_MAX_ACTIONS`.
- Keep spacing between actions; never below ~20s.
- On any block signal, stop and wait (handled automatically — see Cooldowns).

## Warm-up profile (weeks 1–2 after a block)

| Setting | Value | Meaning |
| --- | --- | --- |
| `IG_AGENT_ENABLED` | `false` | No 24/7 loop; run sessions manually |
| `IG_RUN_PROFILE` | `safe` | Conservative base profile |
| `IG_DAILY_MAX_ACTIONS` | `25` | **Master cap**: likes+comments+reactions+replies (story views NOT counted) |
| `IG_ACTION_DELAY_MIN_MS` / `MAX_MS` | `45000` / `90000` | 45–90s between actions |

### Per-engine caps

| Engine | Env vars | Warm-up value |
| --- | --- | --- |
| Feed (`run-10min.js`) | `IG_MAX_POSTS_PER_RUN` / `IG_MAX_COMMENTS_PER_RUN` | 8 posts / 2 comments |
| Growth (`run-grow.js`) | `IG_GROWTH_MAX_TARGETS` / `IG_GROWTH_LIKES_PER_USER` / `IG_GROWTH_COMMENTS_PER_USER` | 8 / 1 / 0 |
| Growth source | `IG_GROWTH_SOURCE` | `commenters` |
| Replies (`run-replies.js`) | `IG_REPLY_MAX_PER_RUN` / `IG_REPLY_MAX_PER_POST` / `IG_REPLY_STRICT_SPAM` | 2 / 1 / `true` |
| Stories (`run-stories.js`) | `IG_STORY_MAX_TARGETS` / `IG_STORY_REACT` | 20 / `false` (view-only) |
| Welcome-DM (`run-welcome.js`) | `IG_WELCOME_MAX_PER_RUN` / `IG_WELCOME_DELAY_MIN_MS`–`MAX_MS` | 5 / 60–180s |

**Welcome-DM is the riskiest engine** (DMs). It only messages people who NEWLY
followed us (diff vs a stored baseline). The **first run only seeds the baseline
and sends nothing**. Spam/bot follower handles are skipped, every recipient is
de-duped (`data/igWelcomedFollowers.json`), and `IG_WELCOME_DRY_RUN=true`
previews without sending.

Story **reactions** are a DM-like action — keep `IG_STORY_REACT=false` during
warm-up. When enabled later, cap with `IG_STORY_MAX_REACTIONS`.

## Cooldowns

| Trigger | Env var | Effect |
| --- | --- | --- |
| Login / challenge failure | `IG_COOLDOWN_MINUTES=120` | Pause the agent loop for 2h |
| **"Action Blocked" wall detected** | `IG_BLOCK_COOLDOWN_MINUTES=180` | `handleActionBlock()` sets a 3h cooldown, screenshots `cookies/action-block.png`, and **stops the current run** |

`handleActionBlock()` runs in all four engines (feed, growth, replies, stories).
It scans the page for Instagram's rate-limit dialog ("Action Blocked", "Try
Again Later", "we restrict certain activity", etc.). The cooldown is shared
state (`data/igCooldown.json`); every engine checks it before starting.

## Ramp-up to steady state

Only after **1–2 weeks with no blocks**:

| Setting | Warm-up | Steady | Never exceed |
| --- | --- | --- | --- |
| Daily total (`IG_DAILY_MAX_ACTIONS`) | 25 | 60–80 | ~150 |
| Likes / day | 15–25 | 40–60 | ~150 |
| Comments + replies / day | 3–5 | 8–12 | ~20 |
| Story views / day | 20–40 | 50–100 | — (passive) |
| Story reactions / day | 0 | 0–5 | ~10 |
| Sessions / day | 1–2 | 2–3 | — |
| Action spacing | 45–90s | 30–60s | never <20s |

Ramp up gradually (e.g. +25–50% per week), not in one jump. If a block appears,
drop back to warm-up values and rest the account.

## Notes

- `.env` is gitignored — these values are local to each machine. This file
  documents the intended configuration; the code ships safe defaults.
- Daily counters reset by calendar day (`data/igActionData.json`).
- Story views do not increment the daily counter (passive, low-risk).
