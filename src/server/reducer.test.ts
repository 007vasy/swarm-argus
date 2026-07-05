import { describe, it, expect } from 'vitest';
import { apply, createState, sweepIdle, ACTIVITY_WINDOW_MS } from './reducer.js';

const T0 = Date.parse('2026-07-05T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function line(partial: any) {
  return { sessionId: 'sess-1', cwd: '/tmp/demo', gitBranch: 'main', ...partial };
}
function assistantWith(content: any[], offset = 0) {
  return line({ type: 'assistant', timestamp: iso(offset), message: { role: 'assistant', content } });
}

describe('reducer', () => {
  it('creates a session node and a main agent node on first line', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'text', text: 'hello' }]), T0);
    expect(s.nodes.get('sess-1')?.kind).toBe('session');
    expect(s.nodes.get('sess-1')?.label).toBe('demo'); // basename of cwd
    expect(s.nodes.get('sess-1:main')?.kind).toBe('agent');
    expect(s.links.get('sess-1->sess-1:main')?.kind).toBe('spawn');
  });

  it('labels the session from an ai-title line', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'text', text: 'hi' }]));
    apply(s, { type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Refactor auth' }, T0);
    expect(s.nodes.get('sess-1')?.label).toBe('Refactor auth');
  });

  it('spawns a subagent node + spawn link for an Agent tool_use', () => {
    const s = createState();
    apply(s, assistantWith([
      { type: 'tool_use', id: 'tu-1', name: 'Agent', input: { subagent_type: 'Explore', description: 'find types' } },
    ]));
    const agent = s.nodes.get('sess-1:agent:tu-1');
    expect(agent?.kind).toBe('agent');
    expect(agent?.subagentType).toBe('Explore');
    expect(agent?.label).toContain('Explore');
    expect(s.links.get('sess-1:main->sess-1:agent:tu-1')?.kind).toBe('spawn');
    expect(s.events.some((e) => e.type === 'spawn')).toBe(true);
  });

  it('marks a subagent done when its tool_result returns', () => {
    const s = createState();
    apply(s, assistantWith([
      { type: 'tool_use', id: 'tu-1', name: 'Agent', input: { subagent_type: 'Explore', description: 'x' } },
    ], 0));
    apply(s, line({
      type: 'user', timestamp: iso(1000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] },
    }), T0);
    const agent = s.nodes.get('sess-1:agent:tu-1');
    expect(agent?.ended).toBe(true);
    expect(agent?.status).toBe('done');
  });

  it('marks a subagent errored when its tool_result is an error', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'tool_use', id: 'tu-9', name: 'Agent', input: { description: 'x' } }]));
    apply(s, line({
      type: 'user', timestamp: iso(500),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-9', is_error: true, content: 'boom' }] },
    }), T0);
    expect(s.nodes.get('sess-1:agent:tu-9')?.status).toBe('error');
  });

  it('counts ordinary tool calls against the main agent and tracks currentTool', () => {
    const s = createState();
    apply(s, assistantWith([
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a/b/foo.ts' } },
      { type: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'ls -la' } },
    ]));
    const main = s.nodes.get('sess-1:main')!;
    expect(main.toolCount).toBe(2);
    expect(main.currentTool).toBe('Bash');
    expect(s.events.find((e) => e.toolName === 'Read')?.summary).toContain('foo.ts');
  });

  it('creates and completes task nodes from TaskCreate/TaskUpdate', () => {
    const s = createState();
    apply(s, assistantWith([
      { type: 'tool_use', id: 'tc', name: 'TaskCreate', input: { taskId: '1', subject: 'Write tests' } },
    ], 0));
    expect(s.nodes.get('task:sess-1:1')?.kind).toBe('task');
    apply(s, assistantWith([
      { type: 'tool_use', id: 'tu', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
    ], 100));
    expect(s.nodes.get('task:sess-1:1')?.status).toBe('done');
  });

  it('removes a task node on deletion', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'tool_use', id: 'tc', name: 'TaskCreate', input: { taskId: '2', subject: 'X' } }]));
    const deltas = apply(s, assistantWith([
      { type: 'tool_use', id: 'tu', name: 'TaskUpdate', input: { taskId: '2', status: 'deleted' } },
    ], 50));
    expect(s.nodes.has('task:sess-1:2')).toBe(false);
    expect(deltas.some((d) => d.t === 'removeNode')).toBe(true);
  });

  it('records pendingBackgroundAgentCount and messageCount from system lines', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'text', text: 'hi' }]));
    apply(s, line({ type: 'system', timestamp: iso(10), messageCount: 42, pendingBackgroundAgentCount: 3, subtype: 'turn' }), T0);
    const session = s.nodes.get('sess-1')!;
    expect(session.messageCount).toBe(42);
    expect(session.pendingAgents).toBe(3);
  });

  it('sweepIdle downgrades quiet active nodes but leaves terminal ones', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'tool_use', id: 'a', name: 'Agent', input: { description: 'x' } }], 0));
    apply(s, line({
      type: 'user', timestamp: iso(100),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    }), T0);
    const later = T0 + ACTIVITY_WINDOW_MS + 5000;
    const changed = sweepIdle(s, later);
    expect(s.nodes.get('sess-1')?.status).toBe('idle');      // session decayed to idle
    expect(s.nodes.get('sess-1:agent:a')?.status).toBe('done'); // terminal, untouched
    expect(changed.every((n) => !n.ended)).toBe(true);
  });

  it('ignores malformed lines without throwing', () => {
    const s = createState();
    expect(() => apply(s, null, T0)).not.toThrow();
    expect(() => apply(s, { type: 'weird' }, T0)).not.toThrow();
    expect(() => apply(s, 'not an object' as any, T0)).not.toThrow();
    expect(s.nodes.size).toBe(0);
  });

  it('assigns monotonic event sequence numbers', () => {
    const s = createState();
    apply(s, assistantWith([{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/x' } }]));
    apply(s, assistantWith([{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/y' } }], 10));
    const seqs = s.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
