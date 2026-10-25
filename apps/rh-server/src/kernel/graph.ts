// Plugin dependency resolution (spec plugin-system: Dependencies and exported APIs): activation order, and why a
// plugin cannot be activated (missing, disabled or incompatible dependency, or part of a cycle).
import semver from "semver";
import type { PluginManifest } from "./manifest.ts";

export interface GraphNode {
  manifest: PluginManifest;
  enabled: boolean;
  /** Set when the plugin itself cannot run (e.g. incompatible kernel). */
  problem?: string;
}

export interface Resolution {
  /** Plugins that can be activated, dependencies first. */
  order: string[];
  /** Plugins that cannot be activated, with the reason. */
  blocked: Map<string, string>;
}

export function resolve(nodes: Map<string, GraphNode>): Resolution {
  const blocked = new Map<string, string>();
  for (const [id, node] of nodes)
    if (!node.enabled) blocked.set(id, "disabled");
    else if (node.problem) blocked.set(id, node.problem);

  // Dependency problems propagate: a plugin is blocked while any dependency is.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of nodes) {
      if (blocked.has(id)) continue;
      for (const [dep, range] of Object.entries(node.manifest.dependencies)) {
        const target = nodes.get(dep);
        let reason: string | undefined;
        if (!target) reason = `needs ${dep} (not installed)`;
        else if (!semver.satisfies(target.manifest.version, range))
          reason = `needs ${dep} ${range} (installed ${target.manifest.version})`;
        else if (blocked.has(dep))
          reason = `needs ${dep} (${blocked.get(dep) === "disabled" ? "disabled" : "not active"})`;
        if (reason) {
          blocked.set(id, reason);
          changed = true;
          break;
        }
      }
    }
  }

  // Topological order over the remaining plugins (Kahn's algorithm, ties by id for a stable order).
  const remaining = [...nodes.keys()].filter((id) => !blocked.has(id));
  const pending = new Map(
    remaining.map((id) => [id, Object.keys(nodes.get(id)!.manifest.dependencies).filter((d) => !blocked.has(d))]),
  );
  const order: string[] = [];
  while (pending.size) {
    const ready = [...pending]
      .filter(([, deps]) => deps.every((d) => order.includes(d)))
      .map(([id]) => id)
      .toSorted();
    if (!ready.length) {
      const cycle = [...pending.keys()].toSorted();
      for (const id of cycle) blocked.set(id, `dependency cycle: ${cycle.join(" → ")}`);
      break;
    }
    for (const id of ready) {
      order.push(id);
      pending.delete(id);
    }
  }
  return { order, blocked };
}

/** Plugins that depend on `id`, directly or indirectly (to warn before disabling it). */
export function dependents(nodes: Map<string, GraphNode>, id: string): string[] {
  const out = new Set<string>();
  const visit = (target: string) => {
    for (const [other, node] of nodes)
      if (!out.has(other) && target in node.manifest.dependencies) {
        out.add(other);
        visit(other);
      }
  };
  visit(id);
  return [...out].toSorted();
}
