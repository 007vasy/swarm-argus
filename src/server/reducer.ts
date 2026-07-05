// Pure ingestion core: folds raw Claude Code transcript JSONL lines into the
// swarm graph model. No I/O — fully unit-testable. The server wraps this with a
// file watcher and a WebSocket broadcaster; tests drive it with recorded lines.
//
// Design notes on the transcript schema (verified against ~/.claude/projects/*):
//   * Every line carries `type`, and most carry `sessionId`, `uuid`,
//     `parentUuid`, `timestamp` (ISO), `cwd`, `gitBranch`, `isSidechain`, `slug`.
//   * assistant/user lines have `message.content[]` with `tool_use`/`tool_result`.
//   * The Agent tool (input.subagent_type/description) is how a swarm fans out —
//     each Agent tool_use becomes a child "agent" node.
//   * TaskCreate/TaskUpdate track task nodes.
//   * system lines carry messageCount / pendingBackgroundAgentCount.
//   * ai-title lines give a human label.

import type {
  ServerMessage,
  Status,
  SwarmEvent,
  SwarmLink,
  SwarmNode,
} from '../shared/types.js';

export const ACTIVITY_WINDOW_MS = 15_000;

export interface ReducerState {
  nodes: Map<string, SwarmNode>;
  links: Map<string, SwarmLink>;
  events: SwarmEvent[];
  /** tool_use id -> node it belongs to (for result matching / subagent completion) */
  toolUseOwner: Map<string, string>;
  seq: number;
}

export function createState(): ReducerState {
  return {
    nodes: new Map(),
    links: new Map(),
    events: [],
    toolUseOwner: new Map(),
    seq: 0,
  };
}

const SPAWN_TOOLS = new Set(['Agent', 'Task']);

function tsToMs(line: any, fallbackNow: number): number {
  const t = line?.timestamp;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return fallbackNow;
}

function sessionNodeId(sessionId: string) {
  return sessionId;
}
function mainAgentId(sessionId: string) {
  return `${sessionId}:main`;
}
function subAgentId(sessionId: string, toolUseId: string) {
  return `${sessionId}:agent:${toolUseId}`;
}
function taskNodeId(sessionId: string, taskId: string) {
  return `task:${sessionId}:${taskId}`;
}

function basename(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** Ensure a session node + its main agent node exist; returns both. */
function ensureSession(
  state: ReducerState,
  line: any,
  now: number,
  out: ServerMessage[],
): { session: SwarmNode; main: SwarmNode } {
  const sessionId: string = line.sessionId;
  const sid = sessionNodeId(sessionId);
  let session = state.nodes.get(sid);
  if (!session) {
    session = {
      id: sid,
      kind: 'session',
      label: basename(line.cwd) ?? sessionId.slice(0, 8),
      status: 'active',
      cwd: line.cwd,
      gitBranch: line.gitBranch,
      sessionId,
      firstSeen: now,
      lastActivity: now,
      toolCount: 0,
    };
    state.nodes.set(sid, session);
    out.push({ t: 'upsertNode', node: session });
  }
  if (line.cwd && !session.cwd) session.cwd = line.cwd;
  if (line.gitBranch) session.gitBranch = line.gitBranch;

  const mid = mainAgentId(sessionId);
  let main = state.nodes.get(mid);
  if (!main) {
    main = {
      id: mid,
      kind: 'agent',
      parentId: sid,
      label: 'main',
      status: 'active',
      sessionId,
      cwd: line.cwd,
      gitBranch: line.gitBranch,
      firstSeen: now,
      lastActivity: now,
      toolCount: 0,
    };
    state.nodes.set(mid, main);
    out.push({ t: 'upsertNode', node: main });
    const link: SwarmLink = { id: `${sid}->${mid}`, source: sid, target: mid, kind: 'spawn' };
    state.links.set(link.id, link);
    out.push({ t: 'upsertLink', link });
  }
  return { session, main };
}

function touch(node: SwarmNode, ts: number, status: Status = 'active') {
  node.lastActivity = Math.max(node.lastActivity, ts);
  // Do not resurrect a terminal node unless there is genuinely new activity.
  if (node.ended && status === 'active') return;
  node.status = status;
}

function pushEvent(
  state: ReducerState,
  out: ServerMessage[],
  ev: Omit<SwarmEvent, 'seq'>,
): void {
  const event: SwarmEvent = { ...ev, seq: state.seq++ };
  state.events.push(event);
  out.push({ t: 'event', event });
}

/**
 * Apply one raw transcript line. Mutates `state`, returns the wire deltas the
 * server should broadcast. `now` is a fallback timestamp (epoch ms) used only
 * when a line lacks its own timestamp — pass a fixed value in tests.
 */
export function apply(state: ReducerState, line: any, now: number = Date.now()): ServerMessage[] {
  const out: ServerMessage[] = [];
  if (!line || typeof line !== 'object') return out;

  const type = line.type;
  const sessionId: string | undefined = line.sessionId;

  // Lines without a session we can still use for labels (ai-title) below.
  if (type === 'ai-title' && sessionId && line.aiTitle) {
    const session = state.nodes.get(sessionNodeId(sessionId));
    if (session) {
      session.label = String(line.aiTitle);
      out.push({ t: 'upsertNode', node: session });
    }
    return out;
  }

  if (!sessionId) return out;
  const ts = tsToMs(line, now);
  const { session, main } = ensureSession(state, line, ts, out);
  touch(session, ts);

  if (type === 'system') {
    if (typeof line.messageCount === 'number') session.messageCount = line.messageCount;
    if (typeof line.pendingBackgroundAgentCount === 'number')
      session.pendingAgents = line.pendingBackgroundAgentCount;
    // End-of-turn / session end subtypes.
    const sub = String(line.subtype ?? '');
    if (/end|complete|finish/i.test(sub)) {
      main.ended = true;
      touch(main, ts, 'done');
    }
    pushEvent(state, out, {
      ts, nodeId: session.id, sessionId, type: 'system',
      summary: sub ? `system: ${sub}` : 'system',
    });
    out.push({ t: 'upsertNode', node: session });
    out.push({ t: 'upsertNode', node: main });
    return out;
  }

  const msg = line.message;
  const content = msg && typeof msg === 'object' ? msg.content : undefined;

  // Plain text message (assistant/user) — activity + token accounting.
  if (type === 'assistant' || type === 'user') {
    touch(main, ts);
    const usage = msg?.usage;
    if (usage && typeof usage === 'object') {
      const out_t = (usage.output_tokens ?? 0) + (usage.input_tokens ?? 0);
      if (out_t) main.tokenEstimate = (main.tokenEstimate ?? 0) + out_t;
    }
    if (Array.isArray(content)) {
      for (const blk of content) {
        if (!blk || typeof blk !== 'object') continue;
        if (blk.type === 'tool_use') applyToolUse(state, out, line, blk, ts, session, main);
        else if (blk.type === 'tool_result') applyToolResult(state, out, blk, ts, session, main);
      }
    } else if (typeof content === 'string' && content.trim()) {
      pushEvent(state, out, {
        ts, nodeId: main.id, sessionId, type: 'message',
        summary: `${type}: ${content.slice(0, 120)}`,
      });
    }
    out.push({ t: 'upsertNode', node: main });
    out.push({ t: 'upsertNode', node: session });
  }

  return out;
}

function applyToolUse(
  state: ReducerState,
  out: ServerMessage[],
  line: any,
  blk: any,
  ts: number,
  session: SwarmNode,
  main: SwarmNode,
): void {
  const name: string = blk.name ?? 'tool';
  const input = blk.input ?? {};
  const sessionId = session.sessionId!;

  // --- Subagent spawn (Agent / Task tool) ---
  if (SPAWN_TOOLS.has(name)) {
    const id = subAgentId(sessionId, blk.id ?? `${state.seq}`);
    const label =
      [input.subagent_type, input.description].filter(Boolean).join(': ') ||
      input.description ||
      'agent';
    const agent: SwarmNode = {
      id,
      kind: 'agent',
      parentId: main.id,
      label: String(label).slice(0, 80),
      status: 'active',
      sessionId,
      subagentType: input.subagent_type,
      model: input.model ?? undefined,
      cwd: session.cwd,
      firstSeen: ts,
      lastActivity: ts,
      toolCount: 0,
    };
    state.nodes.set(id, agent);
    out.push({ t: 'upsertNode', node: agent });
    const link: SwarmLink = { id: `${main.id}->${id}`, source: main.id, target: id, kind: 'spawn' };
    state.links.set(link.id, link);
    out.push({ t: 'upsertLink', link });
    if (blk.id) state.toolUseOwner.set(blk.id, id);
    pushEvent(state, out, {
      ts, nodeId: id, sessionId, type: 'spawn',
      summary: `spawn ${agent.label}`, toolName: name,
    });
    return;
  }

  // --- Task tracking ---
  if (name === 'TaskCreate') {
    const taskId = String(input.taskId ?? input.id ?? blk.id ?? state.seq);
    const id = taskNodeId(sessionId, taskId);
    const node: SwarmNode = {
      id,
      kind: 'task',
      parentId: main.id,
      label: String(input.subject ?? input.description ?? 'task').slice(0, 80),
      status: 'active',
      sessionId,
      firstSeen: ts,
      lastActivity: ts,
      toolCount: 0,
    };
    state.nodes.set(id, node);
    out.push({ t: 'upsertNode', node });
    const link: SwarmLink = { id: `${main.id}->${id}`, source: main.id, target: id, kind: 'task' };
    state.links.set(link.id, link);
    out.push({ t: 'upsertLink', link });
    pushEvent(state, out, {
      ts, nodeId: id, sessionId, type: 'tool_use',
      summary: `task created: ${node.label}`, toolName: name,
    });
    return;
  }
  if (name === 'TaskUpdate') {
    const taskId = String(input.taskId ?? input.id ?? '');
    const id = taskNodeId(sessionId, taskId);
    const node = state.nodes.get(id);
    if (node) {
      const st = String(input.status ?? '');
      if (st === 'completed') { node.ended = true; touch(node, ts, 'done'); }
      else if (st === 'in_progress') touch(node, ts, 'active');
      else if (st === 'deleted') { state.nodes.delete(id); out.push({ t: 'removeNode', id }); return; }
      out.push({ t: 'upsertNode', node });
    }
    return;
  }

  // --- Ordinary tool call: attribute to the owning agent ---
  const owner = main; // main-stream tool calls belong to the main agent
  owner.toolCount += 1;
  owner.currentTool = name;
  session.toolCount += 1;
  touch(owner, ts);
  if (blk.id) state.toolUseOwner.set(blk.id, owner.id);
  pushEvent(state, out, {
    ts, nodeId: owner.id, sessionId, type: 'tool_use',
    summary: toolSummary(name, input), toolName: name,
  });
  out.push({ t: 'upsertNode', node: owner });
}

function applyToolResult(
  state: ReducerState,
  out: ServerMessage[],
  blk: any,
  ts: number,
  session: SwarmNode,
  main: SwarmNode,
): void {
  const useId = blk.tool_use_id;
  const ownerId = useId ? state.toolUseOwner.get(useId) : undefined;
  const owner = (ownerId && state.nodes.get(ownerId)) || main;
  const isError = blk.is_error === true;

  if (owner.kind === 'agent' && owner.id !== main.id) {
    // A subagent's result came back → it has finished.
    owner.ended = true;
    touch(owner, ts, isError ? 'error' : 'done');
  } else if (isError) {
    touch(owner, ts, 'error');
  } else {
    touch(owner, ts);
  }
  pushEvent(state, out, {
    ts, nodeId: owner.id, sessionId: session.sessionId!, type: 'tool_result',
    summary: isError ? 'tool error' : 'tool result', isError,
  });
  out.push({ t: 'upsertNode', node: owner });
}

function toolSummary(name: string, input: any): string {
  try {
    if (name === 'Bash' && input?.command) return `Bash: ${String(input.command).slice(0, 80)}`;
    if ((name === 'Read' || name === 'Edit' || name === 'Write') && input?.file_path)
      return `${name}: ${basename(input.file_path)}`;
    if ((name === 'Grep' || name === 'Glob') && input?.pattern) return `${name}: ${input.pattern}`;
    if (name.startsWith('mcp__')) return name;
  } catch {
    /* ignore */
  }
  return name;
}

/**
 * Re-evaluate time-based idle decay for all non-terminal nodes. Called
 * periodically by the server; returns nodes whose status changed.
 */
export function sweepIdle(state: ReducerState, now: number): SwarmNode[] {
  const changed: SwarmNode[] = [];
  for (const node of state.nodes.values()) {
    if (node.ended) continue;
    if (node.status === 'waiting' || node.status === 'error') continue;
    const nextIdle = now - node.lastActivity > ACTIVITY_WINDOW_MS;
    const next: Status = nextIdle ? 'idle' : 'active';
    if (node.status !== next) {
      node.status = next;
      changed.push(node);
    }
  }
  return changed;
}
