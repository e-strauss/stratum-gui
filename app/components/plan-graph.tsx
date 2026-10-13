"use client";
import { useMemo } from "react";
import type { NodeTiming, Plan } from "../../lib/types";

const seconds = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(4)} s`;

export default function Graph({ plan, timings, selected, onSelect }: {
  plan: Plan; timings: Record<string, NodeTiming>; selected: number | null; onSelect: (id: number) => void;
}) {
  const layout = useMemo(() => {
    const depths = new Map<number, number>();
    const columns = new Map<number, number>();
    return plan.nodes.map(node => {
      const depth = Math.max(-1, ...node.inputs.map(id => depths.get(id) ?? -1)) + 1;
      const column = columns.get(depth) ?? 0;
      depths.set(node.id, depth);
      columns.set(depth, column + 1);
      return { ...node, x: column * 250 + 24, y: depth * 112 + 24 };
    });
  }, [plan]);
  if (plan.nodes.length > 250) return <p className="muted">This plan has {plan.nodes.length} nodes. Use the searchable node table below to explore it.</p>;
  const width = Math.max(550, ...layout.map(n => n.x + 246));
  const height = Math.max(150, ...layout.map(n => n.y + 100));
  const positions = new Map(layout.map(n => [n.id, n]));
  const maxTime = Math.max(0.000001, ...Object.values(timings).map(t => t.seconds));
  return <div className="graph-scroll"><svg width={width} height={height} role="group" aria-label={`${plan.name} dependency graph`}>
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#8f9ca5" /></marker></defs>
    {layout.flatMap(node => node.inputs.map((id, edge) => {
      const input = positions.get(id)!;
      return <path key={`${node.id}-${edge}`} d={`M${input.x + 110},${input.y + 74} C${input.x + 110},${input.y + 94} ${node.x + 110},${node.y - 20} ${node.x + 110},${node.y}`} fill="none" stroke="#b1bcc1" markerEnd="url(#arrow)" />;
    }))}
    {layout.map(node => {
      const timing = timings[node.id];
      const fill = timing ? `rgba(218, 146, 75, ${0.1 + 0.55 * timing.seconds / maxTime})` : "#f3f6f5";
      return <g key={node.id} role="button" tabIndex={0} aria-label={`Node ${node.id}: ${node.label}`} aria-pressed={selected === node.id}
        onClick={() => onSelect(node.id)} onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelect(node.id); } }} className="graph-node">
        <title>{node.label}{timing ? ` · ${seconds(timing.seconds)} · ${timing.count} calls` : ""}</title>
        <rect x={node.x} y={node.y} width="220" height="74" rx="8" fill={fill} stroke={selected === node.id ? "#176759" : "#c5cfca"} strokeWidth={selected === node.id ? 2 : 1} />
        <text x={node.x + 12} y={node.y + 22} className="graph-id">#{node.id} · {node.output_type}</text>
        <text x={node.x + 12} y={node.y + 43}>{node.implementation.length > 27 ? `${node.implementation.slice(0, 25)}…` : node.implementation}</text>
        <text x={node.x + 12} y={node.y + 62} className="graph-id">{timing ? `${seconds(timing.seconds)} · ${timing.count} calls` : ""}</text>
      </g>;
    })}
  </svg></div>;
}
