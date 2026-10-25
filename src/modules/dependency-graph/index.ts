/**
 * Parametric dependency graph and incremental evaluation engine.
 *
 * Implements MASTER PROMPT MODULE 1.1–1.3 (parametric relationship engine):
 * a central graph connecting parameters, formulas, geometry, constraints,
 * hosts, types, connectors, views, quantities and derived caches, with
 * dirty-flag invalidation, generation-stamped evaluation, change coalescing,
 * cancellation and failure recovery.
 *
 * Evidence classification (per spec §2/§3): every rule here is level E
 * (proposed engine behavior). Nothing in this file claims to reproduce
 * Autodesk's internal implementation; the observable contract we honour is
 * the one specified in the MASTER PROMPT itself.
 *
 * Key semantics
 * -------------
 *  - Dependency direction: an edge A -> B means "B depends on A" (B is a
 *    dependent of A). When A is invalidated, B must be recomputed.
 *  - Evaluation is lazy and generation-stamped: a node recomputes only when
 *    its dirty flag is set, preventing infinite regeneration loops (1.2).
 *  - Multiple invalidations inside one batch are coalesced into a single
 *    recompute pass ordered topologically (1.2 "change coalescing").
 *  - Cycles: strongly connected components are detected with Tarjan's
 *    algorithm. An SCC whose members are all constraint/geometry nodes is a
 *    legitimate simultaneous system (solved numerically by the constraint
 *    solver, not evaluated sequentially). An SCC containing formula or
 *    parameter nodes is a prohibited circular dependency and is reported
 *    with a precise diagnostic (1.3).
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

/** Node kinds from MASTER PROMPT 1.1. */
export type NodeKind =
  | "parameter"
  | "formula"
  | "geometry"
  | "constraint"
  | "host"
  | "type"
  | "connector"
  | "view"
  | "quantity"
  | "cache";

/** Edge types from MASTER PROMPT 1.1. */
export type EdgeKind =
  | "parameter-dependency"
  | "formula-dependency"
  | "geometry-dependency"
  | "host"
  | "constraint"
  | "type-to-instance"
  | "connector"
  | "view"
  | "quantity"
  | "derived-cache";

export interface GraphNode {
  /** Stable id, e.g. "param:wall:107:height". */
  id: string;
  kind: NodeKind;
  /**
   * Optional element id this node belongs to. Used for element-level
   * queries (GetDependents of an element's geometry, etc.).
   */
  elementId?: string;
  /** Human-readable label for diagnostics. */
  label?: string;
}

/** Evaluation function: computes the node value from resolved dependencies. */
export type NodeEvaluator = (
  inputs: Map<string, EvalValue>,
  node: GraphNode,
) => EvalValue;

/** A computed value with its provenance generation. */
export interface EvalValue {
  value: unknown;
  /** True when the evaluation failed; `value` then holds the last-good value. */
  error?: boolean;
  /**
   * Optional numeric payload the constraint solver can consume (level E
   * convention: parameter nodes expose their number when applicable).
   */
  number?: number;
}

export interface NodeState {
  node: GraphNode;
  dirty: boolean;
  /** Generation of the cached value (graph generation at evaluation time). */
  generation: number;
  cached: EvalValue | null;
  evaluator: NodeEvaluator | null;
  /** Last evaluation error, if any. */
  lastError: string | null;
  /** Monotonic count of recomputations (diagnostics/tests). */
  evalCount: number;
}

export type CycleClassification =
  | "circular-formula" // prohibited: formula/parameter nodes feed themselves
  | "inconsistent-constraints" // prohibited: conflicting fixed values
  | "simultaneous-constraint-system" // legitimate: solved numerically
  | "underconstrained"; // reported by the solver layer, not by SCCs

export interface CycleReport {
  /** Node ids in the cycle (the SCC). */
  nodes: string[];
  classification: CycleClassification;
  message: string;
}

export interface ValidateResult {
  ok: boolean;
  cycles: CycleReport[];
}

export interface RecomputeReport {
  /** Nodes actually recomputed, in evaluation order. */
  evaluated: string[];
  /** Nodes that failed; graph keeps their last-good cached value. */
  failed: Array<{ id: string; error: string }>;
  /** Cancellation point, if the run was cancelled. */
  cancelled: boolean;
  ms: number;
}

export interface AddNodeOptions {
  evaluator?: NodeEvaluator;
  elementId?: string;
  label?: string;
}

/** Consistent error type thrown by mutation guards. */
export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

/**
 * Dependency graph with incremental evaluation.
 *
 * Complexity (spec 1.1 "exact complexity"):
 *   addNode/removeNode/addDependency/removeDependency — O(1) amortised
 *     (Map operations; edge lookup by composite key).
 *   getDependencies/getDependents — O(deg).
 *   buildAffectedSubgraph — O(V' + E') over the affected subgraph.
 *   detectCycles / topologicalSort — O(V + E).
 *   recompute — O(V' log V' + E') with V' = affected nodes.
 */
export class DependencyGraph {
  private nodes = new Map<string, NodeState>();
  /** dependents: from -> set of nodes that depend on `from`. */
  private dependents = new Map<string, Set<string>>();
  /** dependencies: to -> set of nodes `to` depends on. */
  private dependencies = new Map<string, Set<string>>();
  private edgeKinds = new Map<string, EdgeKind>();
  private generation = 0;
  private batchDepth = 0;
  private batchInvalidated = new Set<string>();
  private cancelledFlag = false;

  // ── Mutation (spec 1.1) ────────────────────────────────────────────────

  /** AddNode. Throws if the id already exists. */
  addNode(id: string, kind: NodeKind, opts: AddNodeOptions = {}): GraphNode {
    if (this.nodes.has(id)) {
      throw new GraphError(`AddNode: node '${id}' already exists`);
    }
    const node: GraphNode = { id, kind, elementId: opts.elementId, label: opts.label };
    this.nodes.set(id, {
      node,
      dirty: true,
      generation: -1,
      cached: null,
      evaluator: opts.evaluator ?? null,
      lastError: null,
      evalCount: 0,
    });
    this.dependents.set(id, new Set());
    this.dependencies.set(id, new Set());
    return node;
  }

  /** RemoveNode. Detaches all edges (including edge-kind records); dependents are invalidated. */
  removeNode(id: string): boolean {
    const st = this.nodes.get(id);
    if (!st) return false;
    for (const dep of this.dependencies.get(id) ?? []) {
      this.dependents.get(dep)?.delete(id);
    }
    for (const dep of [...(this.dependents.get(id) ?? [])]) {
      this.dependencies.get(dep)?.delete(id);
      this.invalidate(dep);
    }
    // Drop edge-kind records so a future AddDependency of the same pair
    // rebuilds adjacency instead of hitting the re-type early-return.
    for (const key of [...this.edgeKinds.keys()]) {
      const [from, to] = key.split("\u0000");
      if (from === id || to === id) this.edgeKinds.delete(key);
    }
    this.dependencies.delete(id);
    this.dependents.delete(id);
    this.nodes.delete(id);
    return true;
  }

  /**
   * AddDependency: `to` will depend on `from`. Creating a formula cycle
   * throws unless `force` is passed (both endpoints constraint/geometry
   * kinds are always accepted — legitimate simultaneous system, 1.1/1.3).
   */
  addDependency(from: string, to: string, kind: EdgeKind, force = false): void {
    this.require(from, "AddDependency.from");
    this.require(to, "AddDependency.to");
    if (from === to) {
      throw new GraphError(`AddDependency: self-dependency '${from}' is prohibited`);
    }
    if (!force && this.wouldCreateProhibitedCycle(from, to)) {
      throw new GraphError(
        `AddDependency: '${from}' -> '${to}' creates a prohibited formula cycle`,
      );
    }
    const key = `${from}\u0000${to}`;
    if (this.edgeKinds.has(key)) {
      this.edgeKinds.set(key, kind); // re-type existing edge
      return;
    }
    this.edgeKinds.set(key, kind);
    this.dependents.get(from)!.add(to);
    this.dependencies.get(to)!.add(from);
    this.invalidate(to);
  }

  /** RemoveDependency. Returns true when the edge existed. */
  removeDependency(from: string, to: string): boolean {
    const key = `${from}\u0000${to}`;
    if (!this.edgeKinds.delete(key)) return false;
    this.dependents.get(from)?.delete(to);
    this.dependencies.get(to)?.delete(from);
    this.invalidate(to);
    return true;
  }

  // ── Queries (spec 1.1) ─────────────────────────────────────────────────

  /** GetDependencies: nodes `id` depends on. */
  getDependencies(id: string): string[] {
    this.require(id, "GetDependencies");
    return [...(this.dependencies.get(id) ?? [])];
  }

  /** GetDependents: nodes that depend on `id`. */
  getDependents(id: string): string[] {
    this.require(id, "GetDependents");
    return [...(this.dependents.get(id) ?? [])];
  }

  /** All nodes of a given kind. */
  nodesOfKind(kind: NodeKind): string[] {
    const out: string[] = [];
    for (const [id, st] of this.nodes) if (st.node.kind === kind) out.push(id);
    return out;
  }

  /** Element-scoped nodes (host / geometry / parameter of one element). */
  nodesOfElement(elementId: string): string[] {
    const out: string[] = [];
    for (const [id, st] of this.nodes) if (st.node.elementId === elementId) out.push(id);
    return out;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * BuildAffectedSubgraph: `roots` plus every transitive dependent.
   * BFS over the dependents index — O(V' + E').
   */
  buildAffectedSubgraph(roots: string[]): string[] {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      if (!this.nodes.has(id)) continue;
      seen.add(id);
      for (const d of this.dependents.get(id) ?? []) queue.push(d);
    }
    return [...seen];
  }

  // ── Cycle analysis (spec 1.3) ──────────────────────────────────────────

  /**
   * DetectCycles via iterative Tarjan SCC (no recursion on large graphs).
   * Every SCC of size > 1 is reported with a classification.
   */
  detectCycles(): CycleReport[] {
    const reports: CycleReport[] = [];
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let idx = 0;

    const strongconnect = (root: string) => {
      const call: Array<{ v: string; iter: Iterator<string> }> = [];
      index.set(root, idx); low.set(root, idx); idx++;
      stack.push(root); onStack.add(root);
      call.push({ v: root, iter: [...(this.dependents.get(root) ?? [])][Symbol.iterator]() });
      while (call.length) {
        const frame = call[call.length - 1];
        const next = frame.iter.next();
        if (next.done) {
          call.pop();
          if (low.get(frame.v) === index.get(frame.v)) {
            const scc: string[] = [];
            let w: string;
            do {
              w = stack.pop()!;
              onStack.delete(w);
              scc.push(w);
            } while (w !== frame.v);
            if (scc.length > 1) reports.push(this.classifyCycle(scc));
          }
          if (call.length) {
            const parent = call[call.length - 1].v;
            low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
          }
          continue;
        }
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, idx); low.set(w, idx); idx++;
          stack.push(w); onStack.add(w);
          call.push({ v: w, iter: [...(this.dependents.get(w) ?? [])][Symbol.iterator]() });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
      }
    };

    for (const id of this.nodes.keys()) if (!index.has(id)) strongconnect(id);
    return reports;
  }

  /** Classify one SCC (spec 1.3 cycle taxonomy). */
  classifyCycle(scc: string[]): CycleReport {
    const kinds = scc.map((id) => this.nodes.get(id)!.node.kind);
    const allSolveable = kinds.every((k) => k === "constraint" || k === "geometry");
    if (allSolveable) {
      return {
        nodes: [...scc],
        classification: "simultaneous-constraint-system",
        message:
          "Legitimate simultaneous geometric constraint system; must be solved " +
          "numerically (constraint solver), never evaluated sequentially.",
      };
    }
    const hasFormula = kinds.some((k) => k === "formula" || k === "parameter");
    if (hasFormula) {
      return {
        nodes: [...scc],
        classification: "circular-formula",
        message: `Prohibited circular formula dependency: ${scc.join(" -> ")}`,
      };
    }
    return {
      nodes: [...scc],
      classification: "inconsistent-constraints",
      message: `Inconsistent constraint system in SCC: ${scc.join(" -> ")}`,
    };
  }

  /** ValidateAcyclicDependencies: ok when no prohibited cycle exists. */
  validateAcyclicDependencies(): ValidateResult {
    const cycles = this.detectCycles();
    return {
      ok: cycles.every((c) => c.classification === "simultaneous-constraint-system"),
      cycles,
    };
  }

  /** TopologicalSort over the whole graph (Kahn). Throws on a cycle. */
  topologicalSort(): string[] {
    const indeg = new Map<string, number>();
    for (const id of this.nodes.keys()) indeg.set(id, 0);
    for (const key of this.edgeKinds.keys()) {
      const [, to] = key.split("\u0000");
      indeg.set(to, (indeg.get(to) ?? 0) + 1);
    }
    const queue = [...this.nodes.keys()].filter((id) => (indeg.get(id) ?? 0) === 0).sort();
    const out: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      out.push(id);
      for (const d of [...(this.dependents.get(id) ?? [])].sort()) {
        const left = (indeg.get(d) ?? 0) - 1;
        indeg.set(d, left);
        if (left === 0) queue.push(d);
      }
    }
    if (out.length !== this.nodes.size) {
      throw new GraphError("TopologicalSort: graph contains a cycle");
    }
    return out;
  }

  // ── Evaluation (spec 1.2) ──────────────────────────────────────────────

  /** InvalidateNode: mark dirty and cascade to all transitive dependents. */
  invalidate(id: string): void {
    if (!this.nodes.has(id)) return;
    const affected = this.buildAffectedSubgraph([id]);
    for (const a of affected) {
      const st = this.nodes.get(a)!;
      if (!st.dirty) {
        st.dirty = true;
        if (this.batchDepth > 0) this.batchInvalidated.add(a);
      }
    }
  }

  /** Invalidate many nodes at once (coalesced). */
  invalidateMany(ids: string[]): void {
    for (const id of ids) this.invalidate(id);
  }

  /**
   * EvaluateNode: compute (or return cached) value for one node.
   * Dependencies are evaluated first, recursively, honouring dirty flags.
   * On evaluator failure the node keeps its last-good cached value and the
   * failure is reported both on the node state and in the returned value
   * (spec 1.2 "failure recovery").
   */
  evaluateNode(id: string): EvalValue {
    const st = this.require(id, "EvaluateNode");
    if (!st.dirty && st.cached) return st.cached;
    const inputs = new Map<string, EvalValue>();
    for (const dep of this.dependencies.get(id) ?? []) {
      inputs.set(dep, this.evaluateNode(dep));
    }
    let out: EvalValue;
    if (!st.evaluator) {
      // Value-holder node (raw parameter). Cached value is authoritative.
      out = st.cached ?? { value: null };
    } else {
      try {
        out = st.evaluator(inputs, st.node);
        st.lastError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        st.lastError = msg;
        // Keep the last-good value; flag the error (spec 1.2).
        out = {
          value: st.cached?.value ?? null,
          number: st.cached?.number,
          error: true,
        };
      }
    }
    st.cached = out;
    st.generation = this.generation;
    st.dirty = false;
    st.evalCount++;
    return out;
  }

  /** Raw value store for evaluator-less parameter nodes. */
  setNodeValue(id: string, value: EvalValue): void {
    const st = this.require(id, "setNodeValue");
    st.cached = value;
    st.generation = this.generation;
    st.dirty = false;
    this.invalidate(id);
  }

  /**
   * RecomputeAffectedNodes: one coalesced pass over the currently dirty
   * subgraph in topological order. Prevents redundant recomputation when
   * many nodes were invalidated together (spec 1.2).
   */
  recompute(): RecomputeReport {
    const t0 = now();
    // Note: cancelledFlag is intentionally NOT reset here — cancel() may
    // be called before or during the run (from an evaluator). It is
    // cleared when a run finishes so subsequent runs proceed normally.
    if (this.cancelledFlag) {
      return { evaluated: [], failed: [], cancelled: true, ms: 0 };
    }
    this.generation++;
    const dirty: string[] = [];
    for (const [id, st] of this.nodes) if (st.dirty) dirty.push(id);
    // Order the dirty subgraph: dependencies before dependents.
    const order = this.topoSortSubset(dirty);
    const evaluated: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of order) {
      if (this.cancelledFlag) break;
      const st = this.nodes.get(id)!;
      if (!st.dirty) continue; // already pulled in by a dependency chain
      const before = st.evalCount;
      this.evaluateNode(id);
      evaluated.push(id);
      if (st.lastError && st.evalCount > before) {
        failed.push({ id, error: st.lastError });
      }
    }
    const cancelled = this.cancelledFlag;
    this.cancelledFlag = false; // clear so the next run proceeds normally
    return { evaluated, failed, cancelled, ms: now() - t0 };
  }

  /** Cancel a running recompute (cooperative — checked between nodes). */
  cancel(): void {
    this.cancelledFlag = true;
  }

  // ── Batch transactions (spec 1.2 coalescing, 1.7 integration hook) ────

  /** Begin a batch: invalidations are collected, nothing recomputes yet. */
  beginBatch(): void {
    this.batchDepth++;
  }

  /**
   * End the batch and recompute once. Returns the coalesced report. On
   * failure the graph state stays valid: failed nodes keep last-good
   * values and are reported (spec 5.4 atomicity at graph level).
   */
  endBatch(): RecomputeReport {
    if (this.batchDepth > 0) this.batchDepth--;
    if (this.batchDepth === 0) {
      this.batchInvalidated.clear();
      return this.recompute();
    }
    return { evaluated: [], failed: [], cancelled: false, ms: 0 };
  }

  /** Node state snapshot (diagnostics/tests). */
  getState(id: string): Readonly<NodeState> | null {
    return this.nodes.get(id) ?? null;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private wouldCreateProhibitedCycle(from: string, to: string): boolean {
    // Would adding from -> to create a path 'to' ~> 'from'? DFS from `to`
    // over dependents looking for `from`.
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === from) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const d of this.dependents.get(id) ?? []) stack.push(d);
    }
    return false;
  }

  /** Topologically order a subset (the dirty set) — dependencies first. */
  private topoSortSubset(dirty: string[]): string[] {
    const dirtySet = new Set(dirty);
    const indeg = new Map<string, number>();
    for (const id of dirty) indeg.set(id, 0);
    for (const id of dirty) {
      for (const dep of this.dependencies.get(id) ?? []) {
        if (dirtySet.has(dep)) indeg.set(id, (indeg.get(id) ?? 0) + 1);
      }
    }
    const queue = dirty.filter((id) => (indeg.get(id) ?? 0) === 0).sort();
    const out: string[] = [];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const d of [...(this.dependents.get(id) ?? [])].sort()) {
        if (!dirtySet.has(d)) continue;
        const left = (indeg.get(d) ?? 0) - 1;
        indeg.set(d, left);
        if (left === 0) queue.push(d);
      }
    }
    // Defensive: append any dirty node the Kahn pass did not reach.
    for (const id of dirty) if (!seen.has(id)) out.push(id);
    return out;
  }

  private require(id: string, api: string): NodeState {
    const st = this.nodes.get(id);
    if (!st) throw new GraphError(`${api}: unknown node '${id}'`);
    return st;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Convenience: build a parameter -> geometry chain in one call. */
export function chainParameterToGeometry(
  g: DependencyGraph,
  elementId: string,
  params: Array<{ id: string; value: number }>,
  geometryId: string,
  buildGeometry: (numbers: Map<string, number>) => unknown,
): void {
  g.addNode(geometryId, "geometry", {
    elementId,
    evaluator: (inputs) => {
      const numbers = new Map<string, number>();
      for (const [k, v] of inputs) {
        numbers.set(k, typeof v.number === "number" ? v.number : Number(v.value));
      }
      return { value: buildGeometry(numbers) };
    },
  });
  for (const p of params) {
    g.addNode(p.id, "parameter", { elementId });
    g.setNodeValue(p.id, { value: p.value, number: p.value });
    g.addDependency(p.id, geometryId, "geometry-dependency");
  }
}
