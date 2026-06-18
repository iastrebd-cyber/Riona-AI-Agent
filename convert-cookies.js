// Converts a Cookie-Editor (or DevTools) cookie export into the exact shape
// Puppeteer's browser.setCookie() needs, and writes cookies/Instagramcookies.json.
//
// Usage:  node convert-cookies.js [path-to-raw-export.json]
// Default input: ./cookies/raw-export.json
const fs = require('fs');
const path = require('path');

const inPath = process.argv[2] || './cookies/raw-export.json';
const outPath = './cookies/Instagramcookies.json';

if (!fs.existsSync(inPath)) {
  console.error(`! Input file not found: ${inPath}`);
  console.error(`  Save your Cookie-Editor export there first (see instructions).`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
} catch (e) {
  console.error(`! ${inPath} is not valid JSON: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(raw)) {
  // Some exporters wrap the array in {cookies:[...]}
  raw = raw.cookies || [];
}

const mapSameSite = (s) => {
  if (!s) return undefined;
  const v = String(s).toLowerCase();
  if (v === 'no_restriction' || v === 'none') return 'None';
  if (v === 'lax') return 'Lax';
  if (v === 'strict') return 'Strict';
  return undefined; // "unspecified" -> let the browser default
};

const out = [];
for (const c of raw) {
  if (!c || !c.name || c.value === undefined) continue;
  // Only Instagram cookies.
  const domain = c.domain || '.instagram.com';
  if (!String(domain).includes('instagram.com')) continue;

  // expires: Cookie-Editor uses expirationDate; Puppeteer/DevTools use expires.
  let expires;
  const exp = c.expires ?? c.expirationDate;
  if (typeof exp === 'number' && exp > 0) expires = exp;

  const cookie = {
    name: c.name,
    value: c.value,
    domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false, // IG cookies are all secure
  };
  if (expires !== undefined) cookie.expires = expires;
  const ss = mapSameSite(c.sameSite);
  if (ss) cookie.sameSite = ss;
  // sameSite=None requires Secure.
  if (cookie.sameSite === 'None') cookie.secure = true;

  out.push(cookie);
}

const names = out.map((c) => c.name);
const hasSession = names.includes('sessionid');

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} cookies -> ${path.resolve(outPath)}`);
console.log(`Cookies: ${names.join(', ') || '(none)'}`);
console.log(`sessionid present: ${hasSession ? 'YES ✅' : 'NO ❌  (you are not logged in — re-export)'}`);
if (!hasSession) process.exit(2);
