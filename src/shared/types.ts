// Shared contract between the ingestion backend and the 3D client.
// Kept dependency-free so both sides can import it directly.

export type NodeKind = 'session' | 'agent' | 'task';

/**
 * Derived lifecycle status for a node. Ordered roughly by "attention worthiness".
 * - active:  produced an event within the activity window
 * - waiting: blocked on a human (permission prompt / Notification)
 * - idle:    alive but quiet past the activity window
 * - done:    session/agent ended cleanly
 * - error:   last tool_result was an error, or ended abnormally
 */
export type Status = 'active' | 'waiting' | 'idle' | 'done' | 'error';

export interface SwarmNode {
  id: string;                // session: sessionId | agent: sessionId+':'+agentUuid | task: 'task:'+taskId
  kind: NodeKind;
  parentId?: string;         // agent -> session, task -> agent (or session)
  label: string;
  status: Status;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  subagentType?: string;     // for agent nodes spawned via the Agent tool
  sessionId?: string;        // owning session (for resume/focus), on every node
  firstSeen: number;         // epoch ms
  lastActivity: number;      // epoch ms — drives glow/pulse + idle decay
  toolCount: number;         // number of tool_use calls attributed to this node
  tokenEstimate?: number;    // rough cumulative token volume → node size hint
  currentTool?: string;      // most recent tool_use name
  messageCount?: number;     // from system lines (sessions)
  pendingAgents?: number;    // pendingBackgroundAgentCount (sessions)
  ended?: boolean;
}

export interface SwarmLink {
  id: string;                // `${source}->${target}`
  source: string;
  target: string;
  kind: 'spawn' | 'task';
}

/** Append-only activity record — the substrate for replay. */
export interface SwarmEvent {
  ts: number;                // epoch ms
  seq: number;               // monotonic ingestion order (tiebreaker for equal ts)
  nodeId: string;
  sessionId: string;
  type: string;              // 'message' | 'tool_use' | 'tool_result' | 'spawn' | 'end' | 'notification' | 'system'
  summary: string;           // short human-readable line for the detail panel
  toolName?: string;
  isError?: boolean;
}

/** Full graph state snapshot. */
export interface SwarmSnapshot {
  nodes: SwarmNode[];
  links: SwarmLink[];
  serverTime: number;
}

// ---- WebSocket wire protocol (server -> client) ----
export type ServerMessage =
  | { t: 'snapshot'; snapshot: SwarmSnapshot }
  | { t: 'upsertNode'; node: SwarmNode }
  | { t: 'removeNode'; id: string }
  | { t: 'upsertLink'; link: SwarmLink }
  | { t: 'event'; event: SwarmEvent };

// ---- REST payloads ----
export interface SessionSummary {
  sessionId: string;
  label: string;
  cwd?: string;
  gitBranch?: string;
  firstSeen: number;
  lastActivity: number;
  agentCount: number;
  status: Status;
}

export interface SessionDetail {
  sessionId: string;
  nodes: SwarmNode[];
  links: SwarmLink[];
  events: SwarmEvent[]; // full ordered timeline for replay
}

export interface ResumeResult {
  sessionId: string;
  command: string;       // e.g. `claude --resume <id>`
  focused: boolean;      // whether we managed to focus a terminal window
  note?: string;
}
