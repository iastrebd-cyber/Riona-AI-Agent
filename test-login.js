// Изолированная проверка входа в Instagram через браузер (Puppeteer).
// Минует Mongo и initAgent — дёргает напрямую getIgClient из сборки build/.
require('dotenv').config();
const { getIgClient } = require('./build/client/Instagram');

(async () => {
  const user = process.env.IGusername;
  const pass = process.env.IGpassword;
  console.log('[test-login] Logging in as:', user);

  try {
    const client = await getIgClient(user, pass);
    // page приватное поле в TS, но в JS-сборке доступно как обычное свойство
    const page = client.page;
    const url = page ? page.url() : '(no page)';
    const cookies = page ? await page.cookies() : [];
    const sessionid = cookies.find((c) => c.name === 'sessionid');
    const ds_user = cookies.find((c) => c.name === 'ds_user_id');

    console.log('[test-login] Final URL :', url);
    console.log('[test-login] sessionid :', sessionid ? 'present' : 'MISSING');
    console.log('[test-login] ds_user_id:', ds_user ? ds_user.value : 'MISSING');

    if (/\/(login|challenge|auth_platform|two_factor)/i.test(url)) {
      console.log('[test-login] RESULT: ❌ NOT LOGGED IN — stuck on', url);
    } else if (sessionid) {
      console.log('[test-login] RESULT: ✅ LOGIN OK');
    } else {
      console.log('[test-login] RESULT: ⚠️ UNCERTAIN (no sessionid, url=' + url + ')');
    }

    console.log('[test-login] Keeping browser open 90s for visual inspection...');
    await new Promise((r) => setTimeout(r, 90000));
  } catch (e) {
    console.error('[test-login] LOGIN ERROR:', (e && e.message) || e);
  }
  process.exit(0);
})();
