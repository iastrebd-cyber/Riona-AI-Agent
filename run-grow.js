// Audience-growth engine runner: build a target list from seed accounts'
// commenters/followers and engage each (like, optional comment) with the
// existing safety throttling. Cookie session, no server, no shutdown.
//
// Tunable via env (all optional, sensible defaults in growByEngagingAudience):
//   IG_GROWTH_SEED_ACCOUNTS=acc1,acc2     seed accounts whose audience to target
//   IG_GROWTH_SOURCE=commenters           commenters | followers | both
//       (followers is best-effort — IG's virtualized modal yields few rows)
//   IG_GROWTH_SEED_POSTS=3                posts per seed to read commenters from
//   IG_GROWTH_FOLLOWERS_PER_SEED=15       followers to scrape per seed
//   IG_GROWTH_MAX_TARGETS=20              users to engage per run
//   IG_GROWTH_LIKES_PER_USER=2            likes per targeted user
//   IG_GROWTH_COMMENTS_PER_USER=0         comments per targeted user (0 = like-only)
//   IG_GROWTH_USER_DELAY_MIN_MS / _MAX_MS pause between users
require('dotenv').config();
const { getIgClient, closeIgClient } = require('./build/client/Instagram');

(async () => {
  try {
    const client = await getIgClient(process.env.IGusername, process.env.IGpassword);
    console.log('[GROW] Session ready — running audience-growth engine...');
    const res = await client.growByEngagingAudience();
    console.log('[GROW] Done:', JSON.stringify(res));
  } catch (e) {
    console.error('[GROW] ERROR:', e && e.stack ? e.stack : e);
  } finally {
    await closeIgClient().catch(() => {});
    process.exit(0);
  }
})();
