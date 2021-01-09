import { setMap } from "collection-utils";
import { numberArray } from "./CycleBreaker";
import { assert, defined, repeated, repeatedCall } from "./support";

function countComponentGraphNodes(components: numberArray[]): number {
  if (!components.length) return 0;
  let largest = -1,
    count = 0;
  for (const c of components) {
    assert(c.length > 0, "Empty component not allowed");
    for (const v of c) {
      assert(v >= 0, "Negative vertex index is invalid");
      largest = Math.max(largest, v);
      count += 1;
    }
  }
  assert(largest + 1 === count, "Vertex indexes and count don't match up");
  return count;
}

function stronglyConnectedComponents(successor: numberArray[]): numberArray[] {
  let index = 0;
  const stack: numberArray = [];
  const numNodes = successor.length;
  const indexes: numberArray = Array(numNodes).fill(-1);
  const lowLinks: numberArray = Array(numNodes).fill(-1);
  const onStack: boolean[] = Array(numNodes).fill(false);
  const sccs: numberArray[] = [];

  function strongConnect(v: number): void {
    indexes[v] = index;
    lowLinks[v] = index;
    index += 1;
    stack.push(v);
    onStack[v] = true;

    for (const w of successor[v]) {
      if (indexes[w] < 0) {
        strongConnect(w);
        lowLinks[v] = Math.min(lowLinks[v], lowLinks[w]);
      } else if (onStack[w]) {
        lowLinks[v] = Math.min(lowLinks[v], indexes[w]);
      }
    }

    if (lowLinks[v] === indexes[v]) {
      const scc: numberArray = [];
      let w: number;
      do {
        w = defined(stack.pop());
        onStack[w] = false;
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (let v = 0; v < numNodes; v++) {
    if (indexes[v] < 0) strongConnect(v);
  }

  assert(countComponentGraphNodes(sccs) === numNodes, "We didn't put all the nodes into SCCs");
  return sccs;
}

function buildComponentOfNodeMap(successor: numberArray[], components: numberArray[]): numberArray {
  const numComponents = components.length,
    numNodes = successor.length;
  assert(numNodes === countComponentGraphNodes(components), "Components don't match up with graph");

  const componentOfNode: numberArray = repeated(numNodes, -1);

  for (let c = 0; c < numComponents; c++) {
    for (const n of components[c]) {
      assert(componentOfNode[n] < 0, "We have a node that's in two components");
      componentOfNode[n] = c;
    }
  }
  return componentOfNode;
}

function buildMetaSuccessor(successors: numberArray[], components: numberArray[]): numberArray[] {
  const numComponents = components.length;
  const componentOfNode = buildComponentOfNodeMap(successors, components);
  const componentAdded: boolean[] = repeated(numComponents, false);
  const metaSuccessors: numberArray[] = [];

  for (let c = 0; c < numComponents; c++) {
    const succ: number[] = [];
    for (const n of components[c]) {
      for (const s of successors[n]) {
        const ms = componentOfNode[s];
        if (ms === c || componentAdded[ms]) continue;
        succ.push(ms);
        componentAdded[ms] = true;
      }
    }
    for (const ms of succ) {
      assert(componentAdded[ms]);
      componentAdded[ms] = false;
    }
    metaSuccessors.push(succ);
  }
  return metaSuccessors;
}

function invertEdges(successors: numberArray[]): numberArray[] {
  const numNodes = successors.length;
  const predecessors: numberArray[] = repeatedCall(numNodes, () => []);
  for (let s = 0; s < numNodes; s++) {
    for (const v of successors[s]) {
      predecessors[v].push(s);
    }
  }
  return predecessors;
}

function calculateInDegrees(successors: numberArray[]): numberArray {
  const numNodes = successors.length;
  const inDegrees: numberArray = repeated(numNodes, 0);
  for (const s of successors) {
    for (const v of s) {
      inDegrees[v] += 1;
    }
  }
  return inDegrees;
}

function findRoots(successors: numberArray[]): numberArray {
  const numNodes = successors.length;
  const inDegrees = calculateInDegrees(successors);
  const roots: numberArray = [];

  for (let v = 0; v < numNodes; v++) {
    if (inDegrees[v] === 0) roots.push(v);
  }
  return roots;
}

export class Graph<T> {
  private readonly _nodes: ReadonlyArray<T>;
  private readonly _indexByNode: ReadonlyMap<T, number>;
  private readonly _successors: numberArray[];
  constructor(nodes: Iterable<T>, invertDirection: boolean, edges: numberArray[] | ((node: T) => ReadonlySet<T>)) {
    this._nodes = Array.from(nodes);
    this._indexByNode = new Map(this._nodes.map((n, i): [T, number] => [n, i]));
    let edgesArray: numberArray[];

    if (Array.isArray(edges)) {
      edgesArray = edges;
    } else {
      edgesArray = this._nodes.map((n) => Array.from(edges(n)).map((s) => defined(this._indexByNode.get(s))));
    }
    if (invertDirection) edgesArray = invertEdges(edgesArray);
    this._successors = edgesArray;
  }

  get size(): number {
    return this._nodes.length;
  }
  get nodes(): ReadonlyArray<T> {
    return this._nodes;
  }
  findRoots(): ReadonlySet<T> {
    return new Set(findRoots(this._successors).map((n) => this._nodes[n]));
  }
  dfsTraversal(root: T, preOrder: boolean, process: (node: T) => void): void {
    const visited = repeated(this.size, false);
    const visit = (v: number): void => {
      if (visited[v]) return;
      visited[v] = true;
      if (preOrder) process(this._nodes[v]);
      for (const w of this._successors[v]) visit(w);
      if (preOrder) process(this._nodes[v]);
    };
    visit(defined(this._indexByNode.get(root)));
  }

  stronglyConnectedComponents(): Graph<ReadonlySet<T>> {
    const components = stronglyConnectedComponents(this._successors);
    const componentSuccessors = buildMetaSuccessor(this._successors, components);
    return new Graph(
      components.map((ns) => setMap(ns, (n) => this._nodes[n])),
      false,
      componentSuccessors
    );
  }

  makeDot(includeNode: (n: T) => boolean, nodeLabel: (n: T) => string): string {
    const lines: string[] = ["digraph G {", "    ordering = out;", ""];
    for (let i = 0; i < this.size; i++) {
      const n = this._nodes[i];
      if (!includeNode(n)) continue;
      lines.push(`    node${i} [label="${nodeLabel(n)}"];`);
    }
    for (let i = 0; this.size; i++) {
      if (!includeNode(this._nodes[i])) continue;
      for (const n of this._successors[i]) {
        if (!includeNode(this._nodes[n])) continue;
        lines.push(`    node${i}->node${n}`);
      }
    }
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  }
}
