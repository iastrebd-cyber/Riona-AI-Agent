// Welcome-DM new followers: send a warm, varied, non-salesy DM to people who
// NEWLY followed us (diff vs a stored baseline). Cookie session, no server.
//
// SAFETY: the FIRST run only records the baseline and sends NOTHING. DMs are the
// riskiest action — keep caps low and prefer a DRY_RUN first.
//
// Tunable via env (optional):
//   IG_WELCOME_SCAN=50              how many followers to read per run
//   IG_WELCOME_MAX_PER_RUN=5        max DMs per run
//   IG_WELCOME_DELAY_MIN_MS=60000   pause between DMs (min)
//   IG_WELCOME_DELAY_MAX_MS=180000  pause between DMs (max)
//   IG_WELCOME_DRY_RUN=false        decide only, don't send (and don't persist)
require('dotenv').config();
const { getIgClient, closeIgClient } = require('./build/client/Instagram');

(async () => {
  try {
    const client = await getIgClient(process.env.IGusername, process.env.IGpassword);
    console.log('[WELCOME] Session ready — checking for new followers...');
    const res = await client.welcomeNewFollowers();
    console.log('[WELCOME] Done:', JSON.stringify(res));
  } catch (e) {
    console.error('[WELCOME] ERROR:', e && e.stack ? e.stack : e);
  } finally {
    await closeIgClient().catch(() => {});
    process.exit(0);
  }
})();
