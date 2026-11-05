# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AI CLAN — a Russian-language single-page landing site with an AI chat widget. No build step, no framework, no test suite, no linter. All user-facing text, code comments, and server error messages are in Russian; keep new ones in Russian too.

## Commands

```bash
npm install     # only dependency is dotenv
npm start       # node script.js → http://localhost:3000
```

Requires Node.js 18+ (uses global `fetch` and `AbortSignal.timeout`). The server exits on startup unless `.env` contains `OPENROUTER_API_KEY`. Optional env vars: `PORT` (default 3000), `OPENROUTER_MODEL` (default `nvidia/nemotron-3.5-lightning:free`).

Quick check of the chat endpoint:

```bash
curl -s localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Привет"}]}'
```

## Architecture

Two files hold everything:

- **[index.html](index.html)** — the whole frontend: inline `<style>` (design tokens as CSS custom properties on `:root`), markup (hero, `#features`, `#about`, `#chat` sections, `#modal` join dialog), and one inline `<script>` split into self-contained IIFEs (modal, scroll reveal, cursor trail canvas, chat). The join-form modal is client-side only — the email is validated but not sent anywhere.
- **[script.js](script.js)** — despite the name, this is the **Node backend**, not browser JS. A plain `node:http` server with two routes:
  - `GET /` or `/index.html` → serves `index.html`. It deliberately serves *only* that file so `.env` and other files in the folder are never exposed; adding new static assets (separate CSS/JS/images) requires adding explicit routes here.
  - `POST /api/chat` → body `{ messages: [{role, content}, ...] }`, returns `{ reply }` or `{ error }`. Proxies to OpenRouter's chat completions API with a Russian system prompt (`SYSTEM_PROMPT`) prepended.

Chat contract between the two files: the browser keeps the conversation history and sends the last 10 messages each request; the server re-validates (only `user`/`assistant` roles, last message must be `user`, trims to `MAX_HISTORY`/`MAX_MESSAGE_CHARS`). The server is stateless apart from an in-memory per-IP rate limiter. Errors thrown as `HttpError` have messages shown to the visitor; anything else becomes a generic 500 and upstream details are only logged to the console. On failure the client pops the unanswered user message from its history.

Opening `index.html` directly from disk (or via `python3 -m http.server`, as the README suggests) renders the page but the chat won't work — it needs `npm start`. The README predates the backend and still describes the project as a single static file.
