import { hasRealGeminiKey } from "../secret";

// Локальный генератор подписи к посту — работает БЕЗ ключа Gemini.
// Когда ключ появится, сюда можно подключить ИИ-генерацию по теме изображения
// (см. заглушку в generateCaption).

const CAPTIONS = [
  "Свежий кадр ✨",
  "Новая работа 🎨",
  "Момент дня 📷",
  "Немного вдохновения",
  "Из мастерской 🖌️",
  "Сегодняшнее настроение",
  "Работа, что говорит сама за себя",
  "Творческий процесс продолжается",
  "Делюсь новым 🤍",
];

const HASHTAGS = [
  "#art", "#artwork", "#artist", "#drawing", "#painting", "#sketch",
  "#illustration", "#contemporaryart", "#artoftheday", "#creative",
  "#instaart", "#fineart", "#artistsoninstagram", "#искусство", "#арт",
];

/** Случайный отбор n уникальных элементов. */
function pickRandom<T>(arr: T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Возвращает короткую подпись + несколько хештегов. Внешние API не нужны.
 * @param tagCount сколько хештегов добавить (по умолчанию 5).
 */
export function generateCaption(tagCount: number = 5): string {
  // На будущее: при наличии ключа Gemini здесь можно генерировать подпись по
  // изображению/теме через runAgent. Пока ключа нет — используем локальные шаблоны.
  if (hasRealGeminiKey()) {
    // TODO: подключить ИИ-генерацию подписи (нужен контекст изображения/темы).
  }
  const caption = CAPTIONS[Math.floor(Math.random() * CAPTIONS.length)];
  const tags = pickRandom(HASHTAGS, tagCount).join(" ");
  return `${caption}\n\n${tags}`;
}
