import { CronJob } from "cron";
import fs from "fs/promises";
import path from "path";
import logger from "../config/logger";
import { getIgClient } from "../client/Instagram";
import { generateCaption } from "./captionGenerator";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Контроллер автономных режимов. Владеет ОДНИМ общим браузером (singleton
 * IgClient через getIgClient) и сериализует доступ к нему: цикл лайков/комментов
 * и постинг по расписанию никогда не дёргают page одновременно.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Общий мьютекс браузера (promise-chain). Берётся НА КАЖДУЮ итерацию цикла, а не
// на весь цикл, чтобы запланированный пост мог вклиниться между итерациями.
// ─────────────────────────────────────────────────────────────────────────────
let lockChain: Promise<unknown> = Promise.resolve();

export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = lockChain.then(fn);
  // Цепочку продолжаем независимо от исхода, чтобы одна ошибка не заклинила лок.
  lockChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Режим 1: автономный цикл взаимодействия (лайки + ИИ-комментарии ленты)
// ─────────────────────────────────────────────────────────────────────────────
let interactionRunning = false;
let shouldExit = false;
let interactionIterations = 0;
let interactionLastRun: string | null = null;
let interactionDelayMs = 30000;

// Флаг мгновенной остановки, который опрашивает interactWithPosts() в IgClient
// (раньше жил в api/agent — перенесён сюда как единый владелец состояния агента).
export function getShouldExitInteractions(): boolean {
  return shouldExit;
}

export function interactionStatus() {
  return {
    running: interactionRunning,
    iterations: interactionIterations,
    lastRun: interactionLastRun,
    delayMs: interactionDelayMs,
  };
}

export function startInteraction(opts: { delayMs?: number } = {}) {
  if (interactionRunning) return interactionStatus();
  if (typeof opts.delayMs === "number" && opts.delayMs >= 0) {
    interactionDelayMs = opts.delayMs;
  }
  interactionRunning = true;
  shouldExit = false;

  // Fire-and-forget: цикл крутится в фоне и НИКОГДА не блокирует Express.
  void (async () => {
    logger.info("Interaction loop started.");
    try {
      const ig = await getIgClient(); // singleton; вход уже выполнен по cookies
      while (interactionRunning) {
        await withBrowserLock(() => ig.interactWithPosts());
        interactionIterations++;
        interactionLastRun = new Date().toISOString();
        if (!interactionRunning) break;
        await delay(interactionDelayMs);
      }
    } catch (error) {
      logger.error(`Interaction loop error: ${(error as Error).message}`);
    } finally {
      interactionRunning = false;
      logger.info("Interaction loop stopped.");
    }
  })();

  return interactionStatus();
}

export function stopInteraction() {
  interactionRunning = false;
  shouldExit = true; // прерывает interactWithPosts() в середине прохода
  return interactionStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Режим 2: постинг по расписанию (одно фото за срабатывание cron)
// ─────────────────────────────────────────────────────────────────────────────
const POSTS_DIR = path.join(process.cwd(), "posts");
const QUEUE_PATH = path.join(POSTS_DIR, "queue.json");
const DEFAULT_CRON = "0 9 * * 1"; // каждый понедельник в 09:00

interface QueueItem {
  image: string; // имя файла в posts/ (или абсолютный путь)
  caption?: string; // если пусто — агент сам сгенерирует подпись + хештеги
  posted?: boolean;
}

let postingJob: CronJob | null = null;
let postingCron = DEFAULT_CRON;

async function loadQueue(): Promise<QueueItem[]> {
  try {
    const raw = await fs.readFile(QUEUE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: QueueItem[]): Promise<void> {
  await fs.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2), "utf-8");
}

/** Публикует первый неопубликованный элемент очереди и помечает его posted. */
export async function postNextFromQueue(): Promise<{
  posted: boolean;
  image?: string;
  reason?: string;
}> {
  const queue = await loadQueue();
  const idx = queue.findIndex((it) => !it.posted);
  if (idx === -1) {
    logger.info("Posting queue is empty — nothing to post.");
    return { posted: false, reason: "queue empty" };
  }

  const item = queue[idx];
  const imagePath = path.isAbsolute(item.image)
    ? item.image
    : path.join(POSTS_DIR, item.image);

  // Подпись задана вручную? Иначе агент генерирует короткую подпись + хештеги сам.
  const caption =
    item.caption && item.caption.trim() ? item.caption : generateCaption();

  logger.info(`Posting next queued item: ${item.image} (caption ${item.caption ? "manual" : "auto-generated"})`);
  await withBrowserLock(async () => {
    const ig = await getIgClient();
    await ig.createPost(imagePath, caption);
  });

  queue[idx].posted = true;
  await saveQueue(queue);
  logger.info(`Posted and marked done: ${item.image}`);
  return { posted: true, image: item.image };
}

export function postingStatus() {
  let nextRun: string | null = null;
  if (postingJob) {
    try {
      nextRun = postingJob.nextDate().toString();
    } catch {
      nextRun = null;
    }
  }
  return { running: !!postingJob, cron: postingCron, nextRun };
}

export function startPosting(opts: { cron?: string } = {}) {
  if (postingJob) postingJob.stop();
  if (opts.cron) postingCron = opts.cron;

  postingJob = new CronJob(postingCron, () => {
    postNextFromQueue().catch((e) =>
      logger.error(`Scheduled post failed: ${(e as Error).message}`)
    );
  });
  postingJob.start();
  logger.info(`Posting scheduler started with cron "${postingCron}".`);
  return postingStatus();
}

export function stopPosting() {
  if (postingJob) {
    postingJob.stop();
    postingJob = null;
  }
  logger.info("Posting scheduler stopped.");
  return postingStatus();
}

/** Опубликовать следующий элемент очереди немедленно (для теста). */
export function postNow() {
  return postNextFromQueue();
}

/** Полная остановка всех автономных режимов (для graceful shutdown). */
export function stopAll() {
  stopInteraction();
  stopPosting();
}
