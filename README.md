# QIRI Web

A web frontend for the QIRI research agent: an [assistant-ui](https://github.com/assistant-ui/assistant-ui) chat interface plus a thin gateway that translates the QIRI app-server JSON-RPC protocol into [AG-UI](https://github.com/ag-ui-protocol/ag-ui) events over SSE/REST.

Features: streaming chat, tool-call cards, command/file-change approval (approve or deny), diffs, session list and resume, and inline preview of artifacts (PNG/JPEG) produced by the agent.

## Quick start

```sh
./start.sh
```

Then open http://127.0.0.1:8787. No dev server is needed; `start.sh` installs dependencies on first run, builds the frontend if needed, and serves in the foreground (Ctrl-C / SIGTERM to stop, rerun to restart).

Prerequisites:

- Node.js LTS (via nvm)
- An installed and authenticated `qiri` binary on `PATH` — the gateway spawns `qiri app-server` as a stdio child process and never handles QIRI credentials itself.

Additional bind addresses can be set with the `QIRI_WEB_HOSTS` environment variable (comma-separated). The gateway binds only the listed addresses, never `0.0.0.0`. After source changes, rebuild with `npm run build`.

> This is a single-user research spike. Host/Origin checks prevent casual cross-site browser use, but they are **not** authentication. Do not expose the gateway to untrusted networks.

## How it works

```
Browser (assistant-ui, React)
   │  AG-UI events over SSE + REST
Gateway (Express, server/)
   │  JSON-RPC over stdio, fixed method whitelist (thread/turn only)
qiri app-server (child process)
```

- `server/rpc.ts` owns the app-server child process and the JSON-RPC channel.
- `server/mapping.ts` holds the fixed translation between app-server notifications/requests and AG-UI events, including CUSTOM events for artifacts.
- `server/index.ts` exposes the REST/SSE API and serves the built frontend.
- Client-supplied tools, config, or RPC fields are never forwarded; there is no arbitrary RPC endpoint.

## API

- `POST /api/threads` with `{}` creates a workspace-write thread; `{ "review": true }` uses QIRI's untrusted command approval policy. Workspace roots are always generated under `.runtime/workspaces/`.
- `GET /api/threads?cursor=...` lists this gateway's threads via app-server `thread/list`, with pagination.
- `GET /api/threads/:id` resumes and returns `{thread, messages, approvals}`; messages use AG-UI format. Paginated QIRI histories are hydrated via `thread/turns/list` and `thread/items/list`.
- `POST /api/agui/run` accepts AG-UI RunAgentInput (`threadId`, `runId`, `messages`, `tools`, `context`, `state`, `forwardedProps`), uses the last user text, and streams `data: {...}\n\n` AG-UI events. QIRI owns history, tools and the agent loop.
- `POST /api/agui/approval` accepts `{requestId, decision:"once"|"session"|"deny"}`. Request IDs are opaque and expire after resolution. The existing run stream remains open while the user decides.
- `POST /api/agui/cancel` accepts `{threadId}`. Closing the run stream also denies pending approvals and interrupts the turn. Runs time out after ten minutes.
- `GET /api/threads/:id/artifacts` lists relative filenames and URLs. Artifact bytes are only served inside that thread's root after realpath validation. PNG/JPEG are displayed inline; other files download.
- `GET /api/health` reports process availability.

## Tests

```sh
npm run test:gateway   # live QIRI: creates files, executes commands, approves a command
PLAYWRIGHT_BROWSERS_PATH="$PWD/.runtime/browsers" npx playwright install chromium
npm run test:browser   # live browser + QIRI acceptance scenarios
npm run build
```

Tests require a running gateway and use only generated task workspaces. `.runtime/` (local workspaces, thread registry, browsers) and `.web-evidence/` (acceptance results and screenshots) are local state and are not committed.

## Based on / acknowledgements

This project stands on the shoulders of:

- **[QIRI](https://github.com/0xLogicLab/qiri)** — the AI4S research agent this UI fronts. QIRI is built on **[OpenAI Codex](https://github.com/openai/codex)** (Apache-2.0); the gateway implements the Codex app-server protocol, and this frontend would not exist without that foundation. Thank you to the Codex team.
- **[assistant-ui](https://github.com/assistant-ui/assistant-ui)** (MIT) — the React chat UI components.
- **[AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui)** (MIT) — the agent–user interaction protocol spoken between the frontend and the gateway.
- React, Vite, Express, and the wider open-source ecosystem.

Third-party components remain under their own licenses.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
