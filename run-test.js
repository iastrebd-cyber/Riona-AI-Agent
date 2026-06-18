// One-off controlled test of the feed interaction (cookie session).
// Likes every eligible post, comments with the 1-2 post skip stride, <=3 words.
// No web server, NO shutdown. Closes the browser and exits when the pass ends.
require('dotenv').config();
const { getIgClient, closeIgClient } = require('./build/client/Instagram');

(async () => {
  try {
    const client = await getIgClient(process.env.IGusername, process.env.IGpassword);
    console.log('[TEST] Session ready — running one feed pass...');
    await client.interactWithPosts();
    console.log('[TEST] Pass complete.');
  } catch (e) {
    console.error('[TEST] ERROR:', e && e.stack ? e.stack : e);
  } finally {
    await closeIgClient().catch(() => {});
    process.exit(0);
  }
})();
