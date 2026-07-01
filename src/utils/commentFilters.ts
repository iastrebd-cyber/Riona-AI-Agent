export type CommentFilterConfig = {
  allow?: string[];
  deny?: string[];
  sentiment?: 'positive' | 'neutral' | 'any';
};

const normalize = (s: string) => s.toLowerCase();

export const getCommentFilterConfig = (): CommentFilterConfig => {
  const allow = (process.env.IG_COMMENT_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const deny = (process.env.IG_COMMENT_DENYLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sentiment = (process.env.IG_COMMENT_SENTIMENT || 'any').toLowerCase() as
    | 'positive'
    | 'neutral'
    | 'any';
  return { allow, deny, sentiment };
};

const positiveWords = [
  'love',
  'great',
  'amazing',
  'awesome',
  'nice',
  'beautiful',
  'cool',
  'dope',
  'fire',
  'perfect',
  'slay',
  'wow',
];

const negativeWords = [
  'hate',
  'bad',
  'terrible',
  'awful',
  'worst',
  'ugly',
  'boring',
  'stupid',
  'trash',
];

const hasAny = (text: string, list: string[]) =>
  list.some((w) => normalize(text).includes(normalize(w)));

const sentimentScore = (text: string) => {
  const lower = normalize(text);
  let score = 0;
  for (const w of positiveWords) if (lower.includes(w)) score++;
  for (const w of negativeWords) if (lower.includes(w)) score--;
  return score;
};

// Spam/low-value detector for INCOMING comments (used before we reply on our
// own posts). The goal is to engage genuine fans, never spam/scam bots.
const SPAM_PHRASES = [
  'check dm', 'check your dm', 'check inbox', 'dm me', 'dm back', 'message me',
  'follow me', 'follow back', 'f4f', 'l4l', 'follow for follow', 'like for like',
  'link in bio', 'click link', 'click the link', 'promo', 'promotion',
  'free followers', 'buy followers', 'grow your', 'get verified',
  'investment', 'invest with', 'forex', 'crypto', 'bitcoin', 'btc', 'casino',
  'betting', 'gambling', 'whatsapp', 'telegram', 't.me', 'onlyfans', 'cashapp',
  'giveaway', 'you won', 'you have won', 'congratulations you', 'claim your',
  'earn money', 'make money', 'work from home', 'hookup', 'nudes',
];

// Solicitation patterns matched with word boundaries (so "admire" won't trip
// on "dm", etc.). These are the comments we must never engage with.
const SOLICIT_REGEXES = [
  /\bdm\b/, /\bdm's\b/, /\bdms\b/, /\binbox\b/, /\bi sent you\b/, /\bsent you a\b/,
  /\breply (me|my|back)\b/, /\bcheck (your |my )?(dm|inbox|pinned)\b/,
  /\bfollow (me|back|for follow)\b/, /\bf4f\b/, /\bl4l\b/, /\blink in bio\b/,
];

export const looksLikeSpamComment = (author: string, text: string): boolean => {
  const a = (author || '').toLowerCase();
  const t = (text || '').toLowerCase();
  // Strict mode (default on): flag bot-pattern handles like "jacob_jek3",
  // "amelia1sh7" — a short name ending in 1-4 digits. May skip a few real fans
  // with numeric handles; disable with IG_REPLY_STRICT_SPAM=false.
  const strict = (process.env.IG_REPLY_STRICT_SPAM || 'true').toLowerCase() !== 'false';
  if (strict && /[a-z][a-z._]*\d{1,4}$/.test(a)) return true;
  // A link in a comment is almost always spam.
  if (/https?:\/\/|www\.|t\.me\/|\.(com|ru|xyz|click|shop|online)\b/.test(t)) return true;
  // Known spam phrases (extendable via IG_REPLY_SPAM_DENYLIST) + solicitations.
  const extra = (process.env.IG_REPLY_SPAM_DENYLIST || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if ([...SPAM_PHRASES, ...extra].some((p) => t.includes(p))) return true;
  if (SOLICIT_REGEXES.some((re) => re.test(t))) return true;
  // Mass-mention spam (tagging several accounts).
  if ((t.match(/@\w+/g) || []).length >= 3) return true;
  // Strong author-name spam signals.
  if (/(crypto|forex|casino|promo\d|freefollow|buyfollow|cheapfollow)/.test(a)) return true;
  return false;
};

// Language gate for ENGAGING a comment (liking/replying). We only engage
// comments written predominantly in Latin (English) or Cyrillic (Russian)
// script. Comments dominated by Arabic or CJK (Chinese/Japanese/Korean) are
// skipped — we don't want to like content we can't read/moderate. A comment
// with no letters at all (pure emoji/punctuation) is treated as engageable,
// since liking it is harmless. Disable the whole gate with
// IG_ENGAGE_LANG_FILTER=false.
export const isSupportedCommentLanguage = (text: string): boolean => {
  if ((process.env.IG_ENGAGE_LANG_FILTER || 'true').toLowerCase() === 'false') return true;
  const t = text || '';
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const cyrillic = (t.match(/[Ѐ-ӿ]/g) || []).length;
  const arabic = (t.match(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g) || []).length;
  // Hiragana/Katakana, CJK ideographs, Hangul.
  const cjk = (t.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g) || []).length;
  const supported = latin + cyrillic;
  const unsupported = arabic + cjk;
  if (unsupported === 0) return true;          // no Arabic/CJK present → fine
  return supported >= unsupported;             // skip only if non-RU/EN dominates
};

export const shouldSkipComment = (comment: string, cfg: CommentFilterConfig): boolean => {
  if (!comment) return true;

  if (cfg.allow && cfg.allow.length > 0 && !hasAny(comment, cfg.allow)) return true;
  if (cfg.deny && cfg.deny.length > 0 && hasAny(comment, cfg.deny)) return true;

  if (cfg.sentiment && cfg.sentiment !== 'any') {
    const score = sentimentScore(comment);
    if (cfg.sentiment === 'positive' && score <= 0) return true;
    if (cfg.sentiment === 'neutral' && score < 0) return true;
  }

  return false;
};
