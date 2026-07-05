// Swarm Argus backend: file watcher -> reducer -> WebSocket broadcast, plus a
// small REST surface for session listing, replay detail, resume, and an
// optional hook bridge for lower-latency real-time events.

import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { TranscriptWatcher } from './watcher.js';
import { apply, createState, sweepIdle } from './reducer.js';
import { resumeSession } from './resume.js';
import type {
  ServerMessage,
  SessionDetail,
  SessionSummary,
  SwarmNode,
  SwarmSnapshot,
} from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 4000);

const state = createState();
const app = express();
app.use(express.json({ limit: '4mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function snapshot(): SwarmSnapshot {
  return {
    nodes: [...state.nodes.values()],
    links: [...state.links.values()],
    serverTime: Date.now(),
  };
}

// ---- Ingestion ----
const watcher = new TranscriptWatcher();
watcher.on('line', (line) => {
  const deltas = apply(state, line, Date.now());
  for (const d of deltas) broadcast(d);
});
watcher.on('error', (err) => console.error('[watcher]', err.message));
watcher.on('ready', () => console.log(`[watcher] tailing ${watcher.watchRoot}`));
watcher.start().catch((err) => console.error('[watcher] start failed', err));

// Periodic idle decay sweep.
setInterval(() => {
  const changed = sweepIdle(state, Date.now());
  for (const node of changed) broadcast({ t: 'upsertNode', node });
}, 5000).unref();

// ---- WebSocket: snapshot on connect, deltas thereafter ----
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'snapshot', snapshot: snapshot() } satisfies ServerMessage));
});

// ---- REST ----
app.get('/api/health', (_req, res) => res.json({ ok: true, nodes: state.nodes.size }));

app.get('/api/sessions', (_req, res) => {
  const sessions: SessionSummary[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== 'session') continue;
    const agentCount = [...state.nodes.values()].filter(
      (n) => n.kind === 'agent' && n.sessionId === node.sessionId,
    ).length;
    sessions.push({
      sessionId: node.sessionId!,
      label: node.label,
      cwd: node.cwd,
      gitBranch: node.gitBranch,
      firstSeen: node.firstSeen,
      lastActivity: node.lastActivity,
      agentCount,
      status: node.status,
    });
  }
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  res.json(sessions);
});

app.get('/api/session/:id', (req, res) => {
  const id = req.params.id;
  const nodes: SwarmNode[] = [...state.nodes.values()].filter(
    (n) => n.sessionId === id || n.id === id,
  );
  if (nodes.length === 0) return res.status(404).json({ error: 'unknown session' });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const detail: SessionDetail = {
    sessionId: id,
    nodes,
    links: [...state.links.values()].filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target)),
    events: state.events.filter((e) => e.sessionId === id),
  };
  res.json(detail);
});

app.post('/api/resume', async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const node = state.nodes.get(sessionId);
  res.json(await resumeSession(sessionId, node?.cwd));
});

// ---- Optional hook bridge (real-time accelerator) ----
// Claude Code hooks POST their JSON payload here. We synthesize a minimal
// transcript-shaped line and fold it through the same reducer so hook-driven
// updates and file-driven updates converge on one model.
app.post('/api/hook', (req, res) => {
  const p = req.body ?? {};
  const sessionId = p.session_id ?? p.sessionId;
  if (!sessionId) return res.status(200).json({ ok: true, ignored: true });
  const event = p.hook_event_name ?? p.hookEventName ?? '';
  const now = new Date().toISOString();
  let line: any = null;

  if (event === 'PostToolUse' || event === 'PreToolUse') {
    line = {
      type: 'assistant', sessionId, timestamp: now, cwd: p.cwd,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `hook-${state.seq}`, name: p.tool_name, input: p.tool_input ?? {} }],
      },
    };
  } else if (event === 'SubagentStop') {
    // Reflect as generic activity on the session's main agent.
    line = { type: 'system', sessionId, timestamp: now, cwd: p.cwd, subtype: 'subagent-stop' };
  } else if (event === 'Notification') {
    line = { type: 'system', sessionId, timestamp: now, cwd: p.cwd, subtype: 'notification' };
    // Mark session's main agent as waiting on a human.
    const main = state.nodes.get(`${sessionId}:main`);
    if (main && !main.ended) {
      main.status = 'waiting';
      broadcast({ t: 'upsertNode', node: main });
    }
  } else if (event === 'Stop' || event === 'SessionEnd') {
    line = { type: 'system', sessionId, timestamp: now, cwd: p.cwd, subtype: 'end' };
  } else if (event === 'SessionStart') {
    line = { type: 'system', sessionId, timestamp: now, cwd: p.cwd, subtype: 'start' };
  }

  if (line) {
    for (const d of apply(state, line, Date.now())) broadcast(d);
  }
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`[server] Swarm Argus backend on http://localhost:${PORT}`);
  console.log(`[server] WebSocket: ws://localhost:${PORT}/ws`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — shutting down`);
    watcher.stop().finally(() => server.close(() => process.exit(0)));
  });
}
