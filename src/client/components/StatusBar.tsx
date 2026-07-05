import React, { useMemo } from 'react';
import { useStore } from '../store.js';
import { STATUS_COLOR } from '../theme.js';
import type { Status } from '../../shared/types.js';

// Top bar: connection state, swarm-wide counts, and the live/replay indicator
// plus the visible-sessions filter.
export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const nodes = useStore((s) => s.nodes);
  const mode = useStore((s) => s.mode);
  const visibleLimit = useStore((s) => s.visibleLimit);
  const setVisibleLimit = useStore((s) => s.setVisibleLimit);
  const exitReplay = useStore((s) => s.exitReplay);

  const stats = useMemo(() => {
    let sessions = 0,
      agents = 0,
      tasks = 0;
    const byStatus: Record<Status, number> = { active: 0, waiting: 0, idle: 0, done: 0, error: 0 };
    let pending = 0;
    for (const n of nodes.values()) {
      if (n.kind === 'session') {
        sessions++;
        pending += n.pendingAgents ?? 0;
      } else if (n.kind === 'agent') {
        agents++;
        byStatus[n.status]++;
      } else tasks++;
    }
    return { sessions, agents, tasks, byStatus, pending };
  }, [nodes]);

  return (
    <header className="statusbar">
      <div className="brand">
        <span className="eye">◎</span> Swarm Argus
      </div>

      <div className={`conn ${connected ? 'on' : 'off'}`}>
        <span className="dot" /> {connected ? 'live' : 'reconnecting…'}
      </div>

      <div className="counts">
        <Count n={stats.sessions} label="sessions" />
        <Count n={stats.agents} label="agents" />
        <Count n={stats.tasks} label="tasks" />
        {stats.pending > 0 && <Count n={stats.pending} label="background" accent="#ffb020" />}
      </div>

      <div className="legend">
        {(['active', 'waiting', 'idle', 'done', 'error'] as Status[]).map((s) => (
          <span key={s} className="leg">
            <i style={{ background: STATUS_COLOR[s] }} />
            {s} {stats.byStatus[s] || ''}
          </span>
        ))}
      </div>

      <div className="spacer" />

      {mode === 'replay' ? (
        <button className="btn small" onClick={exitReplay}>
          ⏻ Exit replay → live
        </button>
      ) : (
        <label className="filter">
          show
          <select value={visibleLimit} onChange={(e) => setVisibleLimit(Number(e.target.value))}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={100000}>all</option>
          </select>
          recent sessions
        </label>
      )}
    </header>
  );
}

function Count({ n, label, accent }: { n: number; label: string; accent?: string }) {
  return (
    <span className="count">
      <b style={accent ? { color: accent } : undefined}>{n}</b> {label}
    </span>
  );
}
