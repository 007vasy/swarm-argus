import { describe, it, expect } from 'vitest';
import { replayGraph } from './store.js';
import type { SwarmEvent, SwarmLink, SwarmNode } from '../shared/types.js';

const node = (id: string, firstSeen: number, extra: Partial<SwarmNode> = {}): SwarmNode => ({
  id, kind: 'agent', label: id, status: 'idle', firstSeen, lastActivity: firstSeen,
  toolCount: 0, sessionId: 's', ...extra,
});
const ev = (nodeId: string, ts: number, type: string, extra: Partial<SwarmEvent> = {}): SwarmEvent => ({
  ts, seq: ts, nodeId, sessionId: 's', type, summary: type, ...extra,
});

describe('replayGraph', () => {
  const nodes = [
    node('s', 0, { kind: 'session' }),
    node('a1', 100),
    node('a2', 300),
  ];
  const links: SwarmLink[] = [
    { id: 's->a1', source: 's', target: 'a1', kind: 'spawn' },
    { id: 's->a2', source: 's', target: 'a2', kind: 'spawn' },
  ];
  const events = [
    ev('s', 0, 'system'),
    ev('a1', 100, 'spawn'),
    ev('a1', 5000, 'tool_result', { type: 'end' }),
    ev('a2', 300, 'spawn'),
    ev('a2', 400, 'tool_result', { isError: true }),
  ];

  it('only shows nodes born by time t', () => {
    const g = replayGraph({ events, nodes, links, t: 150 });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a1', 's']); // a2 not born yet
    expect(g.links.map((l) => l.id)).toEqual(['s->a1']);           // link to a2 excluded
  });

  it('reconstructs spawn order over time', () => {
    expect(replayGraph({ events, nodes, links, t: 50 }).nodes.map((n) => n.id)).toEqual(['s']);
    expect(replayGraph({ events, nodes, links, t: 350 }).nodes.length).toBe(3);
  });

  it('derives terminal status from end / error events at time t', () => {
    const g = replayGraph({ events, nodes, links, t: 6000 });
    const a1 = g.nodes.find((n) => n.id === 'a1')!;
    const a2 = g.nodes.find((n) => n.id === 'a2')!;
    expect(a1.visStatus).toBe('done');   // had an 'end' event
    expect(a2.visStatus).toBe('error');  // had an error tool_result
  });

  it('shows a node as active within the window, idle after a long quiet gap', () => {
    // Standalone scenario: one node spawned at t=0 with no terminal event.
    const n = [node('lonely', 0)];
    const e = [ev('lonely', 0, 'spawn')];
    const l: SwarmLink[] = [];
    const active = replayGraph({ events: e, nodes: n, links: l, t: 1000 }).nodes[0];
    expect(active.visStatus).toBe('active'); // 1s after spawn, within 15s window
    const idle = replayGraph({ events: e, nodes: n, links: l, t: 20_000 }).nodes[0];
    expect(idle.visStatus).toBe('idle');     // 20s later, past the window, no terminal
  });
});
