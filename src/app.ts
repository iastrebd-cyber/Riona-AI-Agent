import express, { Application } from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import helmet from "helmet"; // For securing HTTP headers
import cors from "cors";
import session from 'express-session';

import logger, { setupErrorHandlers } from "./config/logger";
import { connectDB } from "./config/db";
import apiRoutes from "./routes/api";
import agentRoutes from "./routes/agent";
// import { main as twitterMain } from './client/Twitter'; //
// import { main as githubMain } from './client/GitHub'; //

// Set up process-level error handlers
setupErrorHandlers();

// Initialize environment variables
dotenv.config();

// Initialize Express app
const app: Application = express();

// Connect to the database
connectDB();

// Middleware setup
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            // 'unsafe-eval' + unpkg are required by the i.front.html chat client,
            // which loads React/Babel from a CDN and compiles JSX in the browser.
            "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
        },
    },
}));
// Reflect the request origin and allow credentials so the JWT cookie is
// accepted on cross-origin requests (a wildcard '*' origin forbids credentials).
// Set CLIENT_ORIGIN in production to lock this down to a known front-end URL.
app.use(cors({
    origin: process.env.CLIENT_ORIGIN || true,
    credentials: true,
}));
app.use(express.json()); // JSON body parsing
app.use(express.urlencoded({ extended: true, limit: "1kb" })); // URL-encoded data
app.use(cookieParser()); // Cookie parsing
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000, sameSite: 'lax' },
}));

// Serve static files from the 'public' directory
app.use(express.static('frontend/dist'));

// API Routes — agent-роутер монтируем ПЕРЕД '/api', иначе '/api/agent/*' будет
// перехвачен apiRoutes (его requireAuth) и до agentRoutes не дойдёт.
app.use('/api/agent', agentRoutes);
app.use('/api', apiRoutes);

// Standalone single-file chat client (served from the project root, same origin
// as /api so the JWT cookie flows without any CORS/credentials concerns).
app.get(['/chat', '/i.front.html'], (_req, res) => {
    res.sendFile('i.front.html', { root: process.cwd() });
});

app.get('*', (_req, res) => {
    res.sendFile('index.html', { root: 'frontend/dist' });
});

// Автономные режимы (цикл взаимодействия и постинг по расписанию) больше не
// крутятся бесконечным циклом при старте — они управляются по требованию через
// agent-роутер (/api/agent/*), см. src/agent/AgentController.ts.

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
