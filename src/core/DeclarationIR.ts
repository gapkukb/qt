import { iterableFirst, setFilter, setIntersect, setSubtract, setUnionInto } from "collection-utils";
import { Graph } from "./Graph";
import { messageError } from "./Message";
import { assert, defined, panic } from "./support";
import { Type } from "./Type";
import { TypeGraph } from "./TypeGraph";

export type DeclarationKind = "forward" | "define";

export interface Declaration {
  readonly kind: DeclarationKind;
  readonly type: Type;
}
export class DeclarationIR {
  readonly declarations!: ReadonlyArray<Declaration>;
  constructor(declarations: Iterable<Declaration>, readonly forwardedTypes: Set<Type>) {
    this.declarations = Array.from(declarations);
  }
}

function findBreaker(
  t: Type,
  path: ReadonlyArray<Type>,
  canBreak: ((t: Type) => boolean) | undefined
): Type | undefined {
  const index = path.indexOf(t);
  if (index < 0) return;
  if (!canBreak) return path[index];
  const potentialBreakers = path.slice(0, index + 1).reverse();
  const maybeBreaker = potentialBreakers.find(canBreak);
  if (!maybeBreaker) return panic(`Found a cycle that cannot be broken`);
  return maybeBreaker;
}

export function cycleBreakerTypesForGraph(
  graph: TypeGraph,
  isImplicitCycleBreaker: (t: Type) => boolean,
  canBreakCycles: (t: Type) => boolean
): Set<Type> {
  const visitedTypes = new Set<Type>();
  const cycleBreakerTypes = new Set<Type>();
  const queue: Type[] = Array.from(graph.topLevels.values());
  function visit(t: Type, path: Type[]): void {
    if (visitedTypes.has(t)) return;
    if (isImplicitCycleBreaker(t)) {
      for (const c of t.getChildren()) {
        queue.push(c);
      }
    } else {
      const maybeBreaker = findBreaker(t, path, canBreakCycles);
      if (maybeBreaker) {
        cycleBreakerTypes.add(maybeBreaker);
        return;
      }
      for (const c of t.getChildren()) {
        path.unshift(t);
        visit(c, path);
        path.shift();
      }
    }
    visitedTypes.add(t);
  }
  while (true) {
    const maybeType = queue.pop();
    if (!maybeType) break;
    const path: Type[] = [];
    visit(maybeType, path);
    assert(!path.length);
  }
  return cycleBreakerTypes;
}

export function declarationsForGraph(
  typeGraph: TypeGraph,
  canBeForwardDeclared: ((t: Type) => boolean) | undefined,
  childrenOfType: (t: Type) => ReadonlySet<Type>,
  needsDeclaration: (t: Type) => boolean
): DeclarationIR {
  const topDown = canBeForwardDeclared === undefined;
  const declarations: Declaration[] = [];
  const forwardedTypes = new Set<Type>();
  const visitedComponents = new Set<ReadonlySet<Type>>();

  function processGraph(graph: Graph<Type>, writeComponents: boolean): void {
    const componentGraph = graph.stronglyConnectedComponents();
    function visitComponent(component: ReadonlySet<Type>): any {
      if (visitedComponents.has(component)) return;
      visitedComponents.add(component);
      const declarationNeeded = setFilter(component, needsDeclaration);
      if (declarationNeeded.size === 1)
        return declarations.push({ kind: "define", type: defined(iterableFirst(declarationNeeded)) });
      if (declarationNeeded.size === 0 && component.size === 1) return;
      if (declarationNeeded.size === 0)
        return declarations.push({ kind: "define", type: defined(iterableFirst(component)) });
      if (!canBeForwardDeclared) {
        for (const t of declarationNeeded) {
          declarations.push({ kind: "define", type: t });
        }
        return;
      }
      const forwardDeclarable = setFilter(component, canBeForwardDeclared);
      if (forwardDeclarable.size === 0) return messageError("IRNoForwardDeclarableTypeInCycle", {});
      for (const t of forwardDeclarable) {
        declarations.push({ kind: "forward", type: t });
      }
      setUnionInto(forwardedTypes, forwardDeclarable);
      const rest = setSubtract(component, forwardDeclarable);
      const restGraph = new Graph(rest, true, (t) => setIntersect(childrenOfType(t), rest));
      processGraph(restGraph, false);
      for (const t of forwardDeclarable) {
        declarations.push({ kind: "define", type: t });
      }
      return;
    }
    const rootsUnordered = componentGraph.findRoots();
    const roots = rootsUnordered;
    for (const component of roots) {
      componentGraph.dfsTraversal(component, topDown, visitComponent);
    }
  }
  const fullGraph = typeGraph.makeGraph(false, childrenOfType);
  processGraph(fullGraph, true);
  return new DeclarationIR(declarations, forwardedTypes);
}
