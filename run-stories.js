// Story engagement: view (and optionally lightly react to) the Stories of the
// niche audience (commenters of seed accounts). View-only by default — safest.
// Cookie session, no server, no shutdown.
//
// Tunable via env (optional):
//   IG_GROWTH_SEED_ACCOUNTS=acc1,acc2   audience source (shared with growth)
//   IG_STORY_SEED_POSTS=2               posts per seed to read commenters from
//   IG_STORY_MAX_TARGETS=15             users whose story to check per run
//   IG_STORY_REACT=false                send an emoji reaction (DM-like!) — off by default
//   IG_STORY_MAX_REACTIONS=0            cap on reactions per run (when react=true)
//   IG_STORY_DWELL_MIN_MS / _MAX_MS     how long to watch each story
//   IG_STORY_DELAY_MIN_MS / _MAX_MS     pause between targets
//   IG_STORY_DRY_RUN=false              decide only, don't view/react
require('dotenv').config();
const { getIgClient, closeIgClient } = require('./build/client/Instagram');

(async () => {
  try {
    const client = await getIgClient(process.env.IGusername, process.env.IGpassword);
    console.log('[STORIES] Session ready — engaging audience stories...');
    const res = await client.engageAudienceStories();
    console.log('[STORIES] Done:', JSON.stringify(res));
  } catch (e) {
    console.error('[STORIES] ERROR:', e && e.stack ? e.stack : e);
  } finally {
    await closeIgClient().catch(() => {});
    process.exit(0);
  }
})();
