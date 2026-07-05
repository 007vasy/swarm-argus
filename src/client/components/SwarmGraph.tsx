import React, { useEffect, useMemo, useRef } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { selectGraph, useStore, type GraphData } from '../store.js';
import { nodeColor, nodeVal } from '../theme.js';
import type { SwarmNode } from '../../shared/types.js';

// Wraps the imperative 3d-force-graph in a React component. We keep the graph
// instance across renders and only feed it new data, so the force simulation
// and camera stay stable while nodes come and go.
export function SwarmGraph() {
  const mountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  const nodes = useStore((s) => s.nodes);
  const links = useStore((s) => s.links);
  const mode = useStore((s) => s.mode);
  const replay = useStore((s) => s.replay);
  const visibleLimit = useStore((s) => s.visibleLimit);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  const data: GraphData = useMemo(
    () => selectGraph(useStore.getState()),
    // recompute when any of the inputs change
    [nodes, links, mode, replay, visibleLimit],
  );

  // Initialize the graph once.
  useEffect(() => {
    if (!mountRef.current) return;
    const g = new ForceGraph3D(mountRef.current)
      .backgroundColor('#0a0e1a')
      .showNavInfo(false)
      .nodeRelSize(2.2)
      .nodeVal((n: any) => nodeVal(n))
      .nodeColor((n: any) => (n.id === selectedIdRef.current ? '#ffffff' : nodeColor(n)))
      .nodeOpacity(0.92)
      .nodeLabel((n: any) => nodeTooltip(n))
      .linkColor(() => 'rgba(120,150,200,0.25)')
      .linkWidth((l: any) => (l.kind === 'spawn' ? 1.2 : 0.5))
      .linkDirectionalParticles((l: any) => (l.__active ? 3 : 0))
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleSpeed(0.012)
      .onNodeClick((n: any) => {
        select(n.id);
        // Ease the camera toward the clicked node.
        const dist = 120;
        const ratio = 1 + dist / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
        g.cameraPosition({ x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio }, n, 800);
      })
      .onBackgroundClick(() => select(null))
      // Frame the swarm once the force layout settles.
      .onEngineStop(() => g.zoomToFit(500, 60));

    // Spread the force layout a little for readability.
    g.d3Force('charge')?.strength(-90);
    graphRef.current = g;

    const onResize = () => g.width(mountRef.current!.clientWidth).height(mountRef.current!.clientHeight);
    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      g._destructor?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a ref of the selection for the color accessor (avoids re-init).
  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    graphRef.current?.nodeColor((n: any) => (n.id === selectedId ? '#ffffff' : nodeColor(n)));
  }, [selectedId]);

  // Feed data in, preserving node object identity so positions persist.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const prev = g.graphData();
    const prevById = new Map(prev.nodes.map((n: any) => [n.id, n]));
    const active = new Set<string>();
    for (const n of data.nodes) if ((n.visStatus ?? n.status) === 'active') active.add(n.id);

    const nextNodes = data.nodes.map((n) => {
      const existing = prevById.get(n.id);
      if (existing) return Object.assign(existing, n);
      return { ...n };
    });
    const nextLinks = data.links.map((l) => ({
      ...l,
      // A spawn link "flows" particles while its child is active.
      __active: active.has(l.target),
    }));
    g.graphData({ nodes: nextNodes, links: nextLinks });
  }, [data]);

  return <div className="graph" ref={mountRef} />;
}

function nodeTooltip(n: SwarmNode): string {
  const bits = [
    `<b>${escapeHtml(n.label)}</b>`,
    `${n.kind}${n.currentTool ? ` · ${escapeHtml(n.currentTool)}` : ''}`,
  ];
  if (n.kind === 'session' && n.pendingAgents) bits.push(`${n.pendingAgents} background agent(s)`);
  if (n.toolCount) bits.push(`${n.toolCount} tool calls`);
  return `<div class="tt">${bits.join('<br/>')}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
