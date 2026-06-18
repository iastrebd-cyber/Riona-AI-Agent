// Timed working session: one feed pass with our scheme (like all, comment with
// the 1-2 post skip stride, <=3 words + emoji), hard-stopped after 10 minutes.
// No web server, NO shutdown. Single pass => never re-likes/re-comments a post.
require('dotenv').config();
const { getIgClient, closeIgClient } = require('./build/client/Instagram');

const DURATION_MS = 10 * 60 * 1000;

(async () => {
  let stopping = false;
  const stop = async (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[SESSION] Stopping: ${reason}`);
    await closeIgClient().catch(() => {});
    process.exit(0);
  };

  const timer = setTimeout(() => stop('10-minute timer elapsed'), DURATION_MS);
  timer.unref && timer.unref();

  try {
    const client = await getIgClient(process.env.IGusername, process.env.IGpassword);
    console.log('[SESSION] Session ready — running for up to 10 minutes...');
    await client.interactWithPosts();
    await stop('feed pass completed before timer');
  } catch (e) {
    console.error('[SESSION] ERROR:', e && e.stack ? e.stack : e);
    await stop('error');
  }
})();
