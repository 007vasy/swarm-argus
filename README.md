# Swarm Argus

A standalone local app that hooks into **Claude Code** and renders a **live 3D graph of your agent swarm** — so you can oversee many agents at once, inspect any one in detail ("jump in"), and replay past sessions.

> Argus Panoptes — the many-eyed watchman. Point it at your `~/.claude` and it watches every session for you.

![kinds](https://img.shields.io/badge/nodes-sessions·agents·tasks-2ee6a6) ![mode](https://img.shields.io/badge/mode-observer-6aa8ff)

## What it does

- **Live 3D swarm view.** Every Claude Code session becomes a hub; its main agent and each spawned subagent (`Agent`/`Task`) orbit it; tasks hang off as leaves. Nodes are colored by status (active / waiting / idle / done / error), sized by tool volume, and spawn links flow particles while a child is working.
- **Inspect + jump in.** Click any node for a detail panel — current tool, tool/token counts, cwd, branch, and a live activity feed. **Jump in (resume)** copies `claude --resume <id>` (and best-effort focuses the terminal on Linux via `wmctrl`).
- **Replay.** Scrub any session's timeline; the graph reconstructs agent spawn order and activity at any instant. Play/pause with variable speed.

It is **observer-first**: it passively watches Claude Code sessions already running on your machine. It never injects input into a running session — resume is attach-only.

## How it hooks into Claude Code

Zero config. The backbone is the append-only transcript at
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` that Claude Code writes for
every session. Swarm Argus tails these files (live) and reads the backlog
(replay). No changes to your Claude Code setup are required.

Optionally, install **hooks** for lower-latency real-time updates (see below).

## Quick start

```bash
npm install
npm run dev        # backend :4000 + Vite client :5173
```

Open **http://localhost:5173**. Existing sessions appear immediately; run a
Claude Code session in another terminal and watch its agents spawn live.

By default the view shows the **25 most-recently-active sessions** (you have a
lot of history!). Use the *show N recent sessions* control in the top bar to
widen or narrow.

## Optional: real-time hooks

File tailing already gives live updates within ~100ms. For even lower latency
you can install hooks that push events directly:

```bash
npm run install-hooks     # additive + idempotent; backs up settings.json
# ... restart your Claude Code sessions ...
npm run uninstall-hooks   # cleanly removes only Argus's entries
```

The installer merges into `~/.claude/settings.json` **without touching your
existing hooks**, and marks its own entries so uninstall restores the file
exactly. It targets `PostToolUse`, `SubagentStop`, `Notification`, `Stop`,
`SessionStart`, and `SessionEnd`.

## Architecture

```
Claude Code ──writes──▶ ~/.claude/projects/**/*.jsonl
                              │  fs.watch + tail          (optional) hooks POST
                              ▼                                     │
      Backend (Node/TS)  watcher ─▶ reducer ─▶ WebSocket ◀──── /api/hook
                              │                    │
                              │ REST: /api/sessions, /api/session/:id, /api/resume
                              ▼
      Frontend (React + 3d-force-graph)  live view · inspect · replay
```

- **`src/server/watcher.ts`** — tails JSONL with per-file byte offsets (re-reads
  partial trailing lines safely; handles rotation).
- **`src/server/reducer.ts`** — pure fold of transcript lines → swarm graph
  (sessions, agents, tasks, status). No I/O; fully unit-tested.
- **`src/server/index.ts`** — Express + `ws`; snapshot on connect, deltas after;
  REST + the optional hook bridge.
- **`src/client/`** — `SwarmGraph` (3d-force-graph), `DetailPanel`, `StatusBar`,
  `Timeline`, a `zustand` store, and reconnecting WebSocket.
- **`src/shared/types.ts`** — the wire/graph contract shared by both sides.

## Scripts

| command | what |
|---|---|
| `npm run dev` | run backend + client with hot reload |
| `npm test` | run the reducer + replay unit tests |
| `npm run build` | typecheck server + build client bundle |
| `npm run install-hooks` / `uninstall-hooks` | manage optional real-time hooks |

## Notes & limits

- **Observer-only.** No live steering of agents in this version; "jump in" is
  inspect + resume. Orchestrating a swarm from the app (SDK-driven, bidirectional
  steering) is a natural future lane.
- Subagent internals may or may not appear in the transcript depending on your
  Claude Code version; the graph is driven by explicit `Agent`/`Task` spawns plus
  sidechain markers, so it stays robust across versions. The JSONL parser is
  tolerant — unknown line shapes are ignored, not fatal.
- Long histories: the live view caps to the N most-recent sessions and decays
  idle nodes so the scene stays readable.
