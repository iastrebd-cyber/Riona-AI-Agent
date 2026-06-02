# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Instagram-AI-Agent (package name `riona-ai-agent`) is a TypeScript/Node automation tool that drives Instagram through a headful browser, using Google Gemini to generate human-like comments and DMs. It exposes an Express HTTP API and serves a built SPA. Twitter (`X-bot`) and GitHub (`Github.ts`) clients exist but are stubbed/commented out — Instagram is the only live platform.

## Commands

```sh
npm start              # tsc -> copy character JSON -> node build/index.js  (the only "run" command)
npm run train-model    # train AI character from local files
npm run train:link     # train from a website URL
npm run train:audio    # train from an audio file
npm run train:youtube  # train from a YouTube URL
```

There is **no test runner, linter, or dev/watch script wired up** despite `src/test/` existing — `npm start` is a full `tsc` build each time. The build output goes to `build/` (gitignored). To compile without running, use `npx tsc`.

## Required environment (.env)

`IGusername`, `IGpassword` (Instagram login), `MONGODB_URI` (Mongo connection). The app also reads up to 50 numbered `GEMINI_API_KEY_1..50` keys (see "AI agent" below), optional `JWT_SECRET`/`SESSION_SECRET`, `PORT` (default 3000), and Twitter API creds. All defaults in `src/secret/index.ts` are placeholder strings, so missing keys fail at call time, not startup.

## Architecture

**Two ways the automation runs, sharing one browser:**

1. **HTTP API** (default, what `npm start` boots). `src/index.ts` → `src/app.ts` builds the Express app, mounts `src/routes/api.ts` at `/api`, serves the SPA from `frontend/dist/` (a separate front-end build, not in this repo's `src`), and connects Mongo. A second router lives at `src/api/agent/index.ts`.
2. **Autonomous loop**: a `runAgents()` while-loop in `src/app.ts` that repeatedly calls Instagram automation — currently **commented out**.

**Single shared browser instance.** `src/client/Instagram.ts` holds a module-level singleton `IgClient` via `getIgClient(username?, password?)`. It re-inits only when credentials change; `closeIgClient()` tears it down. So all API requests act on one logged-in Puppeteer session — there is no per-user isolation. `scrapeFollowersHandler` is the exception: it spins up its own throwaway `IgClient`.

**`IgClient` (`src/client/IG-bot/IgClient.ts`)** is the core. It launches **puppeteer-extra with stealth + adblocker plugins, `headless: false`** (a visible Chrome window is required). Login prefers saved cookies (`./cookies/Instagramcookies.json`, gitignored) and falls back to credentials, re-saving cookies on success. Cookie validity is checked against `sessionid`/`csrftoken` expiry in `src/utils/index.ts`. Key methods: `interactWithPosts()` (like + AI-comment a feed, capped at 20 posts), `sendDirectMessage*()`, `sendDirectMessagesFromFile()` (30s delay between recipients to avoid flagging), `scrapeFollowers()`. All UI interaction relies on brittle DOM/`textContent` selectors (e.g. buttons matched by the literal text "Message"/"Send"/"Post") and `handleNotificationPopup()` to dismiss Instagram's "Not Now" dialogs — expect these to break when Instagram changes its markup.

**AI agent (`src/Agent/index.ts`)** wraps Gemini (`gemini-2.0-flash`) with `responseMimeType: application/json` + a `responseSchema`. `runAgent(schema, prompt, apiKeyIndex)` is the single entry point; `interactWithPosts` builds the comment prompt inline and uses `getInstagramCommentSchema()`. On failure, `handleError` in `src/utils/index.ts` **rotates through the `geminiApiKeys` array circularly and retries** — this is why 50 numbered keys exist (free-tier quota spreading). `chooseCharacter()` always loads the *first* JSON in `Agent/characters/` (copied into `build/` by the `postbuild` step); the `train:*` scripts generate these character files from external sources.

**Auth.** `POST /api/login` validates by actually logging into Instagram via `getIgClient`, then issues a JWT (`src/secret/index.ts`, 2h expiry) set as an httpOnly cookie named `token`. `requireAuth` middleware in `routes/api.ts` gates every route below `/login`/`/me`/`/status`; `getTokenFromRequest` accepts either the cookie or a `Bearer` header. There is also `express-session` configured but the JWT cookie is the real mechanism.

**Cross-cutting:** logging is Winston with daily-rotate files in `logs/` (`src/config/logger.ts`, also installs process-level error handlers); Mongo via Mongoose (`src/config/db.ts`); graceful shutdown via `src/services/index.ts` on SIGTERM/SIGINT.

## API surface (`src/routes/api.ts`, prefix `/api`)

Public: `GET /status`, `POST /login`, `GET /me`, `DELETE /clear-cookies`. Authed: `POST /interact`, `POST /dm` (`{username, message}`), `POST /dm-file`, `POST|GET /scrape-followers` (`?download=1` streams a `.txt`), `POST /exit`, `POST /logout`. The separate `src/api/agent/index.ts` router exposes `POST /exit-interactions`, which flips an in-memory flag polled by `interactWithPosts()`'s loop to stop it mid-run.

## Notes & gotchas

- `i.front.html` (repo root) is a standalone single-file React (CDN + Babel) client that talks directly to `/api` (login → send DM). It is separate from the `frontend/dist` SPA the server serves.
- Because the browser is non-headless and stateful, automation cannot run in a plain headless CI/container without a display.
- Selector-based scraping and the 20-post / 30s-delay limits are hardcoded — change them in `IgClient.ts`.
