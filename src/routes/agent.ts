import express, { Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import logger from "../config/logger";
import * as agent from "../Agent/AgentController";

// Управление автономными режимами агента. Всё под JWT-аутентификацией.
const router = express.Router();
router.use(requireAuth);

// ── Режим 1: цикл взаимодействия (лайки + ИИ-комментарии) ───────────────────
router.post("/interaction/start", (req: Request, res: Response) => {
  try {
    const delayMs =
      req.body && req.body.delayMs !== undefined ? Number(req.body.delayMs) : undefined;
    const status = agent.startInteraction({ delayMs });
    return res.json({ message: "Interaction loop started", status });
  } catch (error) {
    logger.error("interaction/start error:", error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

router.post("/interaction/stop", (_req: Request, res: Response) => {
  return res.json({ message: "Interaction loop stopping", status: agent.stopInteraction() });
});

router.get("/interaction/status", (_req: Request, res: Response) => {
  return res.json(agent.interactionStatus());
});

// ── Режим 2: постинг по расписанию ──────────────────────────────────────────
router.post("/posting/start", (req: Request, res: Response) => {
  const cron = req.body && req.body.cron ? String(req.body.cron) : undefined;
  return res.json({ message: "Posting scheduler started", status: agent.startPosting({ cron }) });
});

router.post("/posting/stop", (_req: Request, res: Response) => {
  return res.json({ message: "Posting scheduler stopped", status: agent.stopPosting() });
});

router.get("/posting/status", (_req: Request, res: Response) => {
  return res.json(agent.postingStatus());
});

router.post("/posting/post-now", async (_req: Request, res: Response) => {
  try {
    const result = await agent.postNow();
    return res.json(result);
  } catch (error) {
    logger.error("posting/post-now error:", error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
