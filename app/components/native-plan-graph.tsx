"use client";
import { useEffect, useRef } from "react";
import type { Plan } from "../../lib/types";

export default function Graph({ plan, selected, onSelect, zoom }: {
  plan: Plan; selected: number | null; onSelect: (id: number) => void; zoom: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const svg = container.current?.querySelector("svg");
    if (!svg) return;
    // Keep Graphviz's original dimensions; resizing the viewport preserves its
    // viewBox/layout and lets the scroll area grow and shrink with the graph.
    svg.style.width = `${svg.width.baseVal.value * zoom}px`;
    svg.style.height = `${svg.height.baseVal.value * zoom}px`;
  }, [plan, zoom]);
  useEffect(() => {
    container.current?.scrollTo(0, 0);
  }, [plan]);
  useEffect(() => {
    for (const node of plan.nodes) {
      const group = container.current?.querySelector(`#node-${node.id}`);
      if (!group) continue;
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `Node ${node.id}: ${node.label}`);
      group.setAttribute("aria-pressed", String(selected === node.id));
    }
  }, [plan, selected]);

  function select(target: EventTarget | null) {
    const group = target instanceof Element ? target.closest("g.node") : null;
    const match = group?.id.match(/^node-(\d+)$/);
    if (match && container.current?.contains(group) && plan.nodes.some(node => node.id === Number(match[1]))) {
      onSelect(Number(match[1]));
    }
  }

  if (!plan.svg) return <p className="muted">No SVG was captured for this stage. Explore the nodes below.</p>;
  return <div className="graph-scroll native-plan-graph" ref={container}
    role="group" aria-label={`${plan.name} dependency graph`}
    onClick={event => select(event.target)}
    onKeyDown={event => {
      if (["Enter", " "].includes(event.key) && event.target instanceof Element && event.target.closest("g.node")) {
        event.preventDefault(); select(event.target);
      }
    }} dangerouslySetInnerHTML={{ __html: plan.svg }} />;
}
