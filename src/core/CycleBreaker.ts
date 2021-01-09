import { assert, panic } from "./support";

export type numberArray = number[];
export function breakCycles<T>(
  outEdges: numberArray[],
  chooseBreaker: (cycle: numberArray) => [number, T]
): [number, T][] {
  const numNodes = outEdges.length,
    inEdges: numberArray[] = [],
    inDegree: numberArray = [],
    outDegree: numberArray = [],
    done: boolean[] = [],
    ret: [number, T][] = [];

  for (let i = 0; i < numNodes; i++) {
    inEdges.push([]);
    inDegree.push(0);
    outDegree.push(outEdges[i].length);
    done.push(false);
  }
  for (let i = 0; i < numNodes; i++) {
    for (const n of outEdges[i]) {
      inEdges[n].push(i);
      inDegree[n] += 1;
    }
  }
  let workList: numberArray = [];
  for (let i = 0; i < numNodes; i++) if (inDegree[i] === 0 || outDegree[i] === 0) workList.push(i);

  function removeNode(node: number): void {
    for (const n of outEdges[node]) {
      assert(inDegree[n] > 0);
      inDegree[n] -= 1;
      if (inDegree[n] === 0) workList.push(n);
    }
    for (const n of inEdges[node]) {
      assert(outDegree[n] > 0);
      outDegree[n] -= 1;
      if (outDegree[n] === 0) workList.push(n);
    }
    done[node] = true;
  }
  for (;;) {
    const i = workList.pop();
    if (i) {
      if (done[i] || (inDegree[i] === 0 && outDegree[i] === 0)) {
        done[i] = true;
        continue;
      }
      assert(inDegree[i] === 0 || outDegree[i] === 0, "Cannot have nodes in the worklist with in and out edges");
      removeNode(i);
      continue;
    }
    let n = done.indexOf(false);
    if (n < 0) break;
    const path: numberArray = [n];
    for (;;) {
      const maybeEdge = outEdges[n].find((x) => !done[x]);
      if (!maybeEdge) return panic("Presumed cycle is not a cycle");
      const maybeFirst = path.indexOf(maybeEdge);
      if (!maybeFirst) {
        n = maybeEdge;
        path.push(n);
        continue;
      }
      const cycle = path.slice(maybeFirst);
      const [breakNode, info] = chooseBreaker(cycle);
      assert(cycle.indexOf(breakNode) >= 0, "Breaker chose an invalid node");
      removeNode(breakNode);
      ret.push([breakNode, info]);
      break;
    }
    continue;
  }
  return ret;
}
