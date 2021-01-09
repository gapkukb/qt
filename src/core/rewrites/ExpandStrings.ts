import {
  areEqual,
  iterableFirst,
  iterableReduce,
  iterableSome,
  mapFilter,
  setIntersect,
  setIsSuperset,
  setUnion,
} from "collection-utils";
import { build } from "urijs";
import { StringTypes } from "../attributes/StringTypes";
import { emptyTypeAttributes } from "../attributes/TypeAttributes";
import { GraphRemapBuilder, GraphRewriteBuilder } from "../GraphRewriting";
import { RunContext } from "../Run";
import { assert, defined } from "../support";
import { PrimitiveType } from "../Type";
import { TypeGraph, TypeRef } from "../TypeGraph";
import { stringTypesForType } from "../TypeUtils";

const MIN_LENGTH_FOR_ENUM = 10;
const MIN_LENGTH_FOR_OVERLAP = 5;
const REQUIRED_OVERLAP = 3 / 4;
const REGEXP = /^(\-|\+)?[0-9]+(\.[0-9]+)?$/;

export type EnumInference = "none" | "all" | "infer";
type EnumInfo = {
  cases: ReadonlySet<string>;
  numValues: number;
};

function isOwnEnum({ numValues, cases }: EnumInfo): boolean {
  return numValues >= MIN_LENGTH_FOR_ENUM && cases.size < Math.sqrt(numValues);
}

function enumCasesOverlap(
  newCases: ReadonlySet<string>,
  existingCases: ReadonlySet<string>,
  newAreSubordinate: boolean
): boolean {
  const smaller = newAreSubordinate ? newCases.size : Math.min(newCases.size, existingCases.size);
  const overlap = setIntersect(newCases, existingCases).size;
  return overlap >= smaller * REQUIRED_OVERLAP;
}

function isAlwaysEmptyString(cases: string[]): boolean {
  return cases.length === 1 && cases[0] === "";
}

export function expandStrings(ctx: RunContext, graph: TypeGraph, inference: EnumInference): TypeGraph {
  const stringTypeMapping = ctx.stringTypeMapping;
  const allStrings = Array.from(graph.allTypesUnordered()).filter(
    (t) => t.kind === "string" && stringTypesForType(t as PrimitiveType).isRestricted
  ) as PrimitiveType[];

  function makeEnumInfo(t: PrimitiveType): EnumInfo | undefined {
    const stringTypes = stringTypesForType(t);
    const mappedStringTypes = stringTypes.applyStringTypeMapping(stringTypeMapping);
    if (!mappedStringTypes.isRestricted) return;
    const cases = defined(mappedStringTypes.cases);
    if (cases.size === 0) return;
    const numValues = iterableReduce(cases.values(), 0, (a, b) => a + b);
    if (inference !== "all") {
      const keys = Array.from(cases.keys());
      if (isAlwaysEmptyString(keys)) return;
      const someCasesIsNotNumber = iterableSome(keys, (key) => !REGEXP.test(key));
      if (!someCasesIsNotNumber) return;
    }
    return { cases: new Set(cases.keys()), numValues };
  }
  const enumInfos = new Map<PrimitiveType, EnumInfo>();
  const enumSets: ReadonlySet<string>[] = [];
  if (inference !== "none") {
    for (const t of allStrings) {
      const enumInfo = makeEnumInfo(t);
      if (!enumInfo) continue;
      enumInfos.set(t, enumInfo);
    }
    function findOverlap(newCases: ReadonlySet<string>, newAreSubordinate: boolean): number {
      return enumSets.findIndex((s) => enumCasesOverlap(newCases, s, newAreSubordinate));
    }
    for (const t of Array.from(enumInfos.keys())) {
      const enumInfo = defined(enumInfos.get(t));
      const cases = enumInfo.cases;
      if (inference === "all") {
        enumSets.push(cases);
      } else {
        if (!isOwnEnum(enumInfo)) continue;
        const index = findOverlap(cases, false);
        if (index >= 0) {
          enumSets[index] = setUnion(enumSets[index], cases);
        } else {
          enumSets.push(cases);
        }
      }
      enumInfos.delete(t);
    }
    if (inference === "all") assert(enumInfos.size === 0);
    for (const [, enumInfo] of enumInfos.entries()) {
      if (enumInfo.numValues < MIN_LENGTH_FOR_OVERLAP) continue;
      const index = findOverlap(enumInfo.cases, true);
      if (index >= 0) enumSets[index] = setUnion(enumSets[index], enumInfo.cases);
    }
  }
  function replaceString(
    group: ReadonlySet<PrimitiveType>,
    builder: GraphRewriteBuilder<PrimitiveType>,
    forwardingRref: TypeRef
  ): TypeRef {
    assert(group.size === 1);
    const t = defined(iterableFirst(group));
    const stringTypes = stringTypesForType(t);
    const attributes = mapFilter(t.getAttributes(), (a) => a !== stringTypes);
    const mappedStringTypes = stringTypes.applyStringTypeMapping(stringTypeMapping);
    if (!mappedStringTypes.isRestricted)
      return builder.getStringType(attributes, StringTypes.unrestricted, forwardingRref);
    const setMatches = inference === "all" ? areEqual : setIsSuperset;
    const types: TypeRef[] = [];
    const cases = defined(mappedStringTypes.cases);
    if (cases.size > 0) {
      const keys = new Set(cases.keys());
      const fullCases = enumSets.find((s) => setMatches(s, keys));
      if (inference !== "none" && !isAlwaysEmptyString(Array.from(keys)) && fullCases) {
        types.push(builder.getEnumType(emptyTypeAttributes, fullCases));
      } else {
        return builder.getStringType(attributes, StringTypes.unrestricted, forwardingRref);
      }
    }
    const transformations = mappedStringTypes.transformations;
    if (types.length === 0 && transformations.size === 1) {
      const kind = defined(iterableFirst(transformations));
      return builder.getPrimitiveType(kind, attributes, forwardingRref);
    }
    types.push(...Array.from(transformations).map((k) => builder.getPrimitiveType(k)));
    assert(types.length > 0, "We got an empty string type");
    return builder.getUnionType(attributes, new Set(types), forwardingRref);
  }
  return graph.rewrite(
    "expand strings",
    stringTypeMapping,
    false,
    allStrings.map((t) => [t]),
    ctx.debugPrintReconstitution,
    replaceString
  );
}
