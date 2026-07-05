import React, { useMemo, useState } from 'react';
import { useStore } from '../store.js';
import { STATUS_COLOR, STATUS_LABEL } from '../theme.js';
import type { ResumeResult, SwarmEvent } from '../../shared/types.js';

// Right-hand inspector for the selected node: metadata, its recent activity
// feed, and the "jump in" resume/focus action for observer mode.
export function DetailPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const nodes = useStore((s) => s.nodes);
  const recentEvents = useStore((s) => s.recentEvents);
  const replay = useStore((s) => s.replay);
  const mode = useStore((s) => s.mode);
  const enterReplay = useStore((s) => s.enterReplay);
  const [resume, setResume] = useState<ResumeResult | null>(null);

  const node = selectedId ? nodes.get(selectedId) : null;

  const events = useMemo<SwarmEvent[]>(() => {
    if (!selectedId) return [];
    const src = mode === 'replay' && replay ? replay.events : recentEvents;
    return src.filter((e) => e.nodeId === selectedId).slice(-40).reverse();
  }, [selectedId, recentEvents, replay, mode]);

  if (!node) {
    return (
      <aside className="panel">
        <div className="panel-empty">
          <h2>Swarm Argus</h2>
          <p>Select a node to inspect an agent, session, or task.</p>
          <p className="hint">Click a background to deselect. Use the timeline to replay a session.</p>
        </div>
      </aside>
    );
  }

  const doResume = async () => {
    const res = await fetch('/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: node.sessionId }),
    });
    if (res.ok) {
      const r: ResumeResult = await res.json();
      setResume(r);
      try {
        await navigator.clipboard.writeText(r.command);
      } catch {
        /* clipboard may be blocked; command is still shown */
      }
    }
  };

  return (
    <aside className="panel">
      <header className="panel-head">
        <span className="dot" style={{ background: STATUS_COLOR[node.status] }} />
        <div>
          <div className="panel-title">{node.label}</div>
          <div className="panel-sub">
            {node.kind}
            {node.subagentType ? ` · ${node.subagentType}` : ''} · {STATUS_LABEL[node.status]}
          </div>
        </div>
      </header>

      <dl className="meta">
        {node.currentTool && <Row k="Current tool" v={node.currentTool} />}
        {node.toolCount > 0 && <Row k="Tool calls" v={String(node.toolCount)} />}
        {node.tokenEstimate ? <Row k="~Tokens" v={node.tokenEstimate.toLocaleString()} /> : null}
        {node.model && <Row k="Model" v={node.model} />}
        {node.messageCount != null && <Row k="Messages" v={String(node.messageCount)} />}
        {node.pendingAgents ? <Row k="Background agents" v={String(node.pendingAgents)} /> : null}
        {node.cwd && <Row k="cwd" v={node.cwd} mono />}
        {node.gitBranch && <Row k="Branch" v={node.gitBranch} mono />}
        {node.sessionId && <Row k="Session" v={node.sessionId.slice(0, 8)} mono />}
      </dl>

      <div className="actions">
        <button className="btn primary" onClick={doResume} disabled={!node.sessionId}>
          ⤵ Jump in (resume)
        </button>
        {node.sessionId && mode === 'live' && (
          <button className="btn" onClick={() => enterReplay(node.sessionId!)}>
            ⏮ Replay session
          </button>
        )}
      </div>
      {resume && (
        <div className="resume-out">
          <code>{resume.command}</code>
          <div className="hint">
            {resume.focused ? '✓ focused terminal · ' : ''}copied to clipboard. {resume.note}
          </div>
        </div>
      )}

      <h3 className="feed-title">Activity</h3>
      <ul className="feed">
        {events.length === 0 && <li className="feed-empty">No recorded activity for this node.</li>}
        {events.map((e) => (
          <li key={e.seq} className={e.isError ? 'err' : ''}>
            <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className="sm">{e.summary}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : ''}>{v}</dd>
    </>
  );
}
