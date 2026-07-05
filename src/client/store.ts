import { create } from 'zustand';
import type {
  ServerMessage,
  SwarmEvent,
  SwarmLink,
  SwarmNode,
} from '../shared/types.js';

export type Mode = 'live' | 'replay';

const ACTIVITY_WINDOW_MS = 15_000;

interface ReplayState {
  sessionId: string;
  events: SwarmEvent[]; // sorted ascending
  nodes: SwarmNode[];   // final nodes for the session
  links: SwarmLink[];
  tMin: number;
  tMax: number;
  t: number;            // current scrub position (epoch ms)
  playing: boolean;
  speed: number;
}

interface Store {
  connected: boolean;
  nodes: Map<string, SwarmNode>;
  links: Map<string, SwarmLink>;
  recentEvents: SwarmEvent[]; // ring buffer for the live feed
  selectedId: string | null;
  mode: Mode;
  visibleLimit: number;       // number of most-recent sessions to render (live)
  replay: ReplayState | null;

  setConnected: (v: boolean) => void;
  applyMessage: (msg: ServerMessage) => void;
  select: (id: string | null) => void;
  setVisibleLimit: (n: number) => void;

  enterReplay: (sessionId: string) => Promise<void>;
  exitReplay: () => void;
  setReplayTime: (t: number) => void;
  setReplayPlaying: (p: boolean) => void;
  setReplaySpeed: (s: number) => void;
}

const RING = 250;

export const useStore = create<Store>((set, get) => ({
  connected: false,
  nodes: new Map(),
  links: new Map(),
  recentEvents: [],
  selectedId: null,
  mode: 'live',
  visibleLimit: 25,
  replay: null,

  setConnected: (v) => set({ connected: v }),

  applyMessage: (msg) => {
    const s = get();
    switch (msg.t) {
      case 'snapshot': {
        const nodes = new Map<string, SwarmNode>();
        const links = new Map<string, SwarmLink>();
        for (const n of msg.snapshot.nodes) nodes.set(n.id, n);
        for (const l of msg.snapshot.links) links.set(l.id, l);
        set({ nodes, links });
        break;
      }
      case 'upsertNode': {
        const nodes = new Map(s.nodes);
        nodes.set(msg.node.id, msg.node);
        set({ nodes });
        break;
      }
      case 'removeNode': {
        const nodes = new Map(s.nodes);
        nodes.delete(msg.id);
        set({ nodes });
        break;
      }
      case 'upsertLink': {
        const links = new Map(s.links);
        links.set(msg.link.id, msg.link);
        set({ links });
        break;
      }
      case 'event': {
        const recentEvents = [...s.recentEvents, msg.event];
        if (recentEvents.length > RING) recentEvents.splice(0, recentEvents.length - RING);
        set({ recentEvents });
        break;
      }
    }
  },

  select: (id) => set({ selectedId: id }),
  setVisibleLimit: (n) => set({ visibleLimit: n }),

  enterReplay: async (sessionId) => {
    const res = await fetch(`/api/session/${sessionId}`);
    if (!res.ok) return;
    const detail = await res.json();
    const events: SwarmEvent[] = [...detail.events].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const tMin = events.length ? events[0].ts : Date.now();
    const tMax = events.length ? events[events.length - 1].ts : Date.now();
    set({
      mode: 'replay',
      selectedId: sessionId,
      replay: {
        sessionId,
        events,
        nodes: detail.nodes,
        links: detail.links,
        tMin,
        tMax,
        t: tMax,
        playing: false,
        speed: 8,
      },
    });
  },

  exitReplay: () => set({ mode: 'live', replay: null }),
  setReplayTime: (t) => set((st) => (st.replay ? { replay: { ...st.replay, t } } : {})),
  setReplayPlaying: (p) => set((st) => (st.replay ? { replay: { ...st.replay, playing: p } } : {})),
  setReplaySpeed: (speed) => set((st) => (st.replay ? { replay: { ...st.replay, speed } } : {})),
}));

// ---- Derived selectors (kept out of the store to avoid recompute churn) ----

export interface GraphData {
  nodes: (SwarmNode & { visStatus: SwarmNode['status'] })[];
  links: SwarmLink[];
}

/** The subgraph to render right now, honoring live/replay mode + filters. */
export function selectGraph(s: Store): GraphData {
  if (s.mode === 'replay' && s.replay) return replayGraph(s.replay);
  return liveGraph(s);
}

function liveGraph(s: Store): GraphData {
  // Pick the N most-recently-active sessions, then include their descendants.
  const sessions = [...s.nodes.values()]
    .filter((n) => n.kind === 'session')
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, s.visibleLimit);
  const keepSession = new Set(sessions.map((n) => n.sessionId));
  const nodes = [...s.nodes.values()]
    .filter((n) => n.sessionId && keepSession.has(n.sessionId))
    .map((n) => ({ ...n, visStatus: n.status }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = [...s.links.values()].filter((l) => ids.has(l.source) && ids.has(l.target));
  return { nodes, links };
}

export function replayGraph(r: {
  events: SwarmEvent[];
  nodes: SwarmNode[];
  links: SwarmLink[];
  t: number;
}): GraphData {
  const t = r.t;
  // A node is present once it has been born by time t.
  const born = new Map<string, number>();
  const lastEvt = new Map<string, SwarmEvent>();
  const terminal = new Map<string, 'done' | 'error'>();
  for (const e of r.events) {
    if (e.ts > t) break;
    if (!born.has(e.nodeId)) born.set(e.nodeId, e.ts);
    lastEvt.set(e.nodeId, e);
    if (e.type === 'tool_result' && e.isError) terminal.set(e.nodeId, 'error');
    if (e.type === 'end') terminal.set(e.nodeId, 'done');
  }
  const nodes = r.nodes
    .filter((n) => born.has(n.id) || n.firstSeen <= t)
    .map((n) => {
      let visStatus: SwarmNode['status'];
      const term = terminal.get(n.id);
      if (term) visStatus = term;
      else {
        const e = lastEvt.get(n.id);
        visStatus = e && t - e.ts <= ACTIVITY_WINDOW_MS ? 'active' : 'idle';
      }
      return { ...n, visStatus };
    });
  const ids = new Set(nodes.map((n) => n.id));
  const links = r.links.filter((l) => ids.has(l.source) && ids.has(l.target));
  return { nodes, links };
}
