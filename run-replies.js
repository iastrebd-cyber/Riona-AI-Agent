// Reply to recent comments on YOUR OWN posts with warm short AI replies.
// Safest community-growth signal. Cookie session, no server, no shutdown.
// A persisted store (data/igRepliedComments.json) prevents replying twice.
//
// Tunable via env (optional):
//   IG_REPLY_OWN_POSTS=3        how many of your latest posts to scan
//   IG_REPLY_MAX_PER_RUN=5      total replies per run
//   IG_REPLY_MAX_PER_POST=3     replies per single post
//   IG_REPLY_MAX_WORDS=4        reply length cap (+1 emoji)
//   IG_REPLY_DELAY_MIN_MS / _MAX_MS   pause between replies
require('dotenv').config();
const { getIgClient, closeIgClient } = require('./build/client/Instagram');

(async () => {
  try {
    const client = await getIgClient(process.env.IGusername, process.env.IGpassword);
    console.log('[REPLIES] Session ready — replying to comments on your posts...');
    const res = await client.replyToOwnPostComments();
    console.log('[REPLIES] Done:', JSON.stringify(res));
  } catch (e) {
    console.error('[REPLIES] ERROR:', e && e.stack ? e.stack : e);
  } finally {
    await closeIgClient().catch(() => {});
    process.exit(0);
  }
})();
