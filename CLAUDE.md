# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AI CLAN — a Russian-language single-page landing site with an AI chat widget. No build step, no framework, no test suite, no linter. All user-facing text, code comments, and server error messages are in Russian; keep new ones in Russian too.

## Commands

```bash
npm install     # only dependency is dotenv
npm start       # node script.js → http://localhost:3000
```

Requires Node.js 18+ (uses global `fetch` and `AbortSignal.timeout`). The server exits on startup unless `.env` contains `OPENROUTER_API_KEY`. Optional env vars: `PORT` (default 3000), `OPENROUTER_MODEL` (default `nvidia/nemotron-3.5-lightning:free`), `TRUST_PROXY` (number of reverse proxies in front of the server, default 0; when > 0 the rate limiter takes the client IP from `X-Forwarded-For` instead of the socket address).

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

Opening `index.html` directly from disk (or via `python3 -m http.server`) renders the page but the chat won't work — it needs `npm start`.

## Security headers (CSP)

[script.js](script.js) sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` on every response, and a strict `Content-Security-Policy` on the page. The CSP allows scripts and styles only with a per-request `nonce`: the server reads `index.html` on each request and adds the nonce to every bare `<script>` / `<style>` tag. Consequences when editing the frontend:

- Keep inline scripts and styles as plain `<script>` / `<style>` tags with no attributes, otherwise the nonce is not injected and they are blocked.
- No `style="..."` attributes or inline event handlers (`onclick=`) in the markup — they are blocked. Put the rule in the `<style>` block instead (setting `element.style.x` from JS is fine).
- External resources are limited to Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`); `connect-src` is `'self'`, so the page can only call its own `/api/*`. New origins need to be added to `buildCsp()`.

## Light theme

The theme toggle (`#themeToggle`, fixed in the top-right corner) sets `data-theme="light"` on `<html>`; dark is the default and has no attribute. The choice is stored in `localStorage['theme']`, and a tiny inline script in `<head>` applies it before first paint to avoid a flash. All theme-dependent colors are CSS custom properties: dark values on `:root`, light overrides in `:root[data-theme="light"]`. When adding styles, use these variables (`--surface`, `--shadow`, `--glass`, ...) rather than hardcoded `rgba(255,255,255,…)` / `rgba(0,0,0,…)`, or the element will break in one of the themes. The cursor trail on the canvas still uses fixed colors in both themes.

## Tooling

- **Playwright MCP** is configured in [.mcp.json](.mcp.json) (`@playwright/mcp`) for browser checks and screenshots against the running site (`npm start` first). It writes its output to `.playwright-mcp/`.
- **`/check` skill** ([.claude/skills/check/SKILL.md](.claude/skills/check/SKILL.md)) is a custom security audit of `index.html` and `script.js` (XSS, key leaks, input validation). It reports findings and suggested fixes; it does not change code.
