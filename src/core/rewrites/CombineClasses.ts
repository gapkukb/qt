import { GraphRemapBuilder, GraphRewriteBuilder } from "../GraphRewriting";
import { RunContext } from "../Run";
import { assert, panic } from "../support";
import { ClassProperty, ClassType, setOperationCasesEqual, Type } from "../Type";
import { TypeGraph, TypeRef } from "../TypeGraph";
import { combineTypeAttributesOfTypes, nonNullTypeCases } from "../TypeUtils";
import { unifyTypes, unionBuilderForUnification } from "../UnifyClasses";

const REQUIRED_OVERLAP = 3 / 4;
type Clique = {
  members: ClassType[];
  prototypes: ClassType[];
};
function typeSetsCanBeCombined(s1: Iterable<Type>, s2: Iterable<Type>): boolean {
  return setOperationCasesEqual(s1, s2, true, (a, b) => a.structuallyCompatible(b, true));
}
function canBeCombined(c1: ClassType, c2: ClassType, onlyWithSameProperties: boolean): boolean {
  const p1 = c1.getProperties(),
    p2 = c2.getProperties();

  if (onlyWithSameProperties) {
    if (p1.size !== p2.size) return false;
  } else {
    if (p1.size < p2.size * REQUIRED_OVERLAP || p2.size < p1.size * REQUIRED_OVERLAP) return false;
  }
  type Temp = ReadonlyMap<string, ClassProperty>;
  let larger: Temp, smaller: Temp;
  if (p1.size > p2.size) {
    larger = p1;
    smaller = p2;
  } else {
    larger = p2;
    smaller = p1;
  }
  let maxFaults: number;
  if (onlyWithSameProperties) maxFaults = 0;
  else maxFaults = smaller.size - Math.ceil(larger.size * REQUIRED_OVERLAP);
  assert(maxFaults >= 0, "Max faults negative");
  const commonProperties: string[] = [];
  let faults = 0;
  for (const [name] of smaller) {
    if (larger.has(name)) {
      commonProperties.push(name);
    } else {
      faults++;
      if (faults > maxFaults) break;
    }
  }
  if (faults > maxFaults) return false;
  for (const name of commonProperties) {
    let ts = smaller.get(name),
      tl = larger.get(name);
    if (!ts || !tl) return panic("Both classes should have property " + name);
    // TODO:
    const tsCases = nonNullTypeCases(ts.type),
      tlCases = nonNullTypeCases(tl.type);

    if (tsCases.size > 0 && tlCases.size > 0 && !typeSetsCanBeCombined(tsCases, tlCases)) {
      return false;
    }
  }
  return true;
}

function tryAddToClique(c: ClassType, clique: Clique, onlyWithSameProperties: boolean): boolean {
  for (const prototype of clique.prototypes) {
    if (prototype.structuallyCompatible(c)) {
      clique.members.push(c);
      return true;
    }
    for (const prototype of clique.prototypes) {
      if (canBeCombined(prototype, c, onlyWithSameProperties)) {
        clique.prototypes.push(c);
        clique.members.push(c);
        return true;
      }
    }
  }
  return false;
}

function findSimilarityClique(
  graph: TypeGraph,
  onlyWithSameProperties: boolean,
  includeFixedClasses: boolean
): ClassType[][] {
  const classCandidates = Array.from(graph.allNamedTypesSeparated().objects).filter(
    (o) => o instanceof ClassType && (includeFixedClasses || !o.isFixed)
  ) as ClassType[];
  const cliques: Clique[] = [];
  for (const c of classCandidates) {
    let cliqueIndex: number | undefined = undefined;
    for (let i = 0; i < cliques.length; i++) {
      if (tryAddToClique(c, cliques[i], onlyWithSameProperties)) {
        cliqueIndex = i;
        break;
      }
    }
    if (!cliqueIndex) {
      cliqueIndex = cliques.length;
      cliques.push({ members: [c], prototypes: [c] });
    }
    const tmp = cliques[0];
    cliques[0] = cliques[cliqueIndex];
    cliques[cliqueIndex] = tmp;
  }
  return cliques.map((clique) => clique.members).filter((cl) => cl.length > 1);
}

export function comblieClasses(
  ctx: RunContext,
  graph: TypeGraph,
  alphabetizeProperties: boolean,
  conflateNumbers: boolean,
  onlyWithSameProperties: boolean,
  debugPrintReconstitutions: boolean
): TypeGraph {
  const cliques = ctx.time(" find similarity clques", () => findSimilarityClique(graph, onlyWithSameProperties, false));
  function makeCliqueClass(
    clique: ReadonlySet<ClassType>,
    builder: GraphRewriteBuilder<ClassType>,
    forwardingRef: TypeRef
  ): TypeRef {
    assert(clique.size > 0, "Clique can't be empty");
    const attributes = combineTypeAttributesOfTypes("union", clique);
    return unifyTypes(
      clique,
      attributes,
      builder,
      unionBuilderForUnification(builder, false, false, conflateNumbers),
      conflateNumbers,
      forwardingRef
    );
  }
  return graph.rewrite(
    "combine classes",
    ctx.stringTypeMapping,
    alphabetizeProperties,
    cliques,
    debugPrintReconstitutions,
    makeCliqueClass
  );
}
