// Изолированная проверка сбора подписчиков (минует Mongo/сервер).
// Запуск:  node test-scrape.js [account] [count]
require('dotenv').config();
const { scrapeFollowersHandler } = require('./build/client/Instagram');

(async () => {
  const acc = process.argv[2] || process.env.IGusername || 'art_yachot';
  const n = Number(process.argv[3] || 25);
  console.log(`[test-scrape] scraping ${n} followers of @${acc} ...`);
  try {
    const followers = await scrapeFollowersHandler(acc, n);
    console.log(`[test-scrape] RESULT count = ${followers.length}`);
    followers.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));
    const looksReal = followers.length > 0 && followers.every((f) => /^[\w.]+$/.test(f));
    console.log(`[test-scrape] verdict: ${looksReal ? '✅ real usernames' : '⚠️ check output'}`);
  } catch (e) {
    console.error('[test-scrape] ERROR:', (e && e.message) || e);
  }
  process.exit(0);
})();
