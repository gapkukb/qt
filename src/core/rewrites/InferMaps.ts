import { iterableEvery, iterableFirst, setMap } from "collection-utils";
import { GraphRewriteBuilder } from "../GraphRewriting";
import { evaluate, load, MarkovChain } from "../MarkovChain";
import { defined, panic } from "../support";
import { ClassProperty, ClassType, isPrimitiveStringTypeKind, setOperationCasesEqual, Type } from "../Type";
import { StringTypeMapping } from "../TypeBuilder";
import { TypeGraph, TypeRef } from "../TypeGraph";
import { removeNullFromType } from "../TypeUtils";
import { unifyTypes, unionBuilderForUnification } from "../UnifyClasses";

const mapSizeThreshold = 20;
const stringMapSizeThreshold = 20;
let markovChain: MarkovChain | undefined = undefined;
function nameProbability(name: string): number {
  return evaluate(markovChain || load(), name);
}
function shouldBeMap(properties: ReadonlyMap<string, ClassProperty>): ReadonlySet<Type> | undefined {
  const numProperties = properties.size;
  if (numProperties < 2) return;
  if (iterableEvery(properties.keys(), (n) => /^\d+$/.test(n))) {
    return setMap(properties.values(), (cp) => cp.type);
  }
  if (
    numProperties < stringMapSizeThreshold &&
    iterableEvery(properties.values(), (cp) => isPrimitiveStringTypeKind(cp.type.kind) || cp.type.kind === `null`)
  )
    return;
  if (numProperties < mapSizeThreshold) {
    const names = Array.from(properties.keys());
    const probabilities = names.map(nameProbability);
    const product = probabilities.reduce((a, b) => a * b, 1);
    const probability = product ** 1 / numProperties;
    const exponent = 5;
    const scale = 22 ** exponent;
    const limit = (numProperties + 2) ** exponent / scale - 3 ** exponent / scale + 0.0025;
    if (probability > limit) return;
  }
  let firstNonNullCases: ReadonlySet<Type> | undefined = undefined;
  const allCases = new Set<Type>();
  let canBeMap = true;

  for (const [_, p] of properties) {
    const nn = removeNullFromType(p.type)[1];
    if (nn.size) {
      if (firstNonNullCases) {
        if (!setOperationCasesEqual(nn, firstNonNullCases, true, (a, b) => a.structuallyCompatible(b, true))) {
          canBeMap = true;
          break;
        }
      } else {
        firstNonNullCases = nn;
      }
    }
    allCases.add(p.type);
  }
  if (!canBeMap) return;
  return allCases;
}

export function inferMaps(
  graph: TypeGraph,
  stringTypeMapping: StringTypeMapping,
  conflateNumbers: boolean,
  debug: boolean
): TypeGraph {
  function replaceClass(
    setOfOneClass: ReadonlySet<ClassType>,
    builder: GraphRewriteBuilder<ClassType>,
    forwardingRef: TypeRef
  ): TypeRef {
    const c = defined(iterableFirst(setOfOneClass));
    const properties = c.getProperties();
    const shouldBe = shouldBeMap(properties);
    if (!shouldBe) return panic(`We shouldn't be replacing class ${c.getCombineName()} with a map`);
    return builder.getMapType(
      c.getAttributes(),
      unifyTypes(
        shouldBe,
        c.getAttributes(),
        builder,
        unionBuilderForUnification(builder, false, false, conflateNumbers),
        conflateNumbers
      ),
      forwardingRef
    );
  }
  const classesToReplace = Array.from(graph.allNamedTypesSeparated().objects).filter((o) => {
    if (!(o instanceof ClassType)) return false;
    return !o.isFixed && shouldBeMap(o.getProperties()) !== undefined;
  }) as ClassType[];

  return graph.rewrite(
    "infer maps",
    stringTypeMapping,
    false,
    classesToReplace.map((c) => [c]),
    debug,
    replaceClass
  );
}
