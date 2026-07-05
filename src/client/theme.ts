import type { NodeKind, Status, SwarmNode } from '../shared/types.js';

export const STATUS_COLOR: Record<Status, string> = {
  active: '#2ee6a6',  // vivid green — working now
  waiting: '#ffb020', // amber — blocked on a human
  idle: '#5b6b8c',    // muted blue-grey — alive but quiet
  done: '#3a7d5d',    // deep teal — finished cleanly
  error: '#ff5470',   // red — failed
};

export const STATUS_LABEL: Record<Status, string> = {
  active: 'Active',
  waiting: 'Waiting',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
};

export function nodeColor(n: SwarmNode & { visStatus?: Status }): string {
  return STATUS_COLOR[n.visStatus ?? n.status];
}

// Relative visual size: sessions are hubs, agents scale with tool volume,
// tasks are small leaves.
export function nodeVal(n: SwarmNode): number {
  if (n.kind === 'session') return 14;
  if (n.kind === 'task') return 2;
  const base = n.id.endsWith(':main') ? 6 : 4;
  return base + Math.min(10, Math.log2(1 + n.toolCount) * 2);
}

export const KIND_SHAPE: Record<NodeKind, string> = {
  session: 'hub',
  agent: 'agent',
  task: 'leaf',
};
