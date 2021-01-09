import { iterableSome, setFilter } from "collection-utils";
import { build } from "urijs";
import { emptyTypeAttributes } from "../attributes/TypeAttributes";
import { GraphRewriteBuilder } from "../GraphRewriting";
import { messageAssert } from "../Message";
import { assert } from "../support";
import { IntersectionType, Type, UnionType } from "../Type";
import { StringTypeMapping } from "../TypeBuilder";
import { derefTypeRef, TypeGraph, TypeRef } from "../TypeGraph";
import { makeGroupToFlatten } from "../TypeUtils";
import { unifyTypes, UnifyUnionBuilder } from "../UnifyClasses";

export function flattenUnions(
  graph: TypeGraph,
  stringTypeMapping: StringTypeMapping,
  conflateNumbers: boolean,
  makeObjectTypes: boolean,
  debug: boolean
): [TypeGraph, boolean] {
  let needRepeat = false;
  function replace(types: ReadonlySet<Type>, builder: GraphRewriteBuilder<Type>, forwardingRef: TypeRef): TypeRef {
    const unionBuilder = new UnifyUnionBuilder(builder, makeObjectTypes, true, (refs) => {
      assert(refs.length > 0, "Must have at least one type to build union");
      refs.map((ref) => builder.reconstituteType(derefTypeRef(ref, graph)));
      if (refs.length === 1) return refs[0];
      needRepeat = true;
      return builder.getUnionType(emptyTypeAttributes, new Set(refs));
    });
    return unifyTypes(types, emptyTypeAttributes, builder, unionBuilder, conflateNumbers, forwardingRef);
  }
  const allUnions = setFilter(graph.allTypesUnordered(), (t) => t instanceof UnionType) as Set<UnionType>;
  const nonCanonicalUinons = setFilter(allUnions, (u) => !u.isCanonical);
  let foundIntersection = false;
  const groups = makeGroupToFlatten(nonCanonicalUinons, (members) => {
    messageAssert(members.size > 0, "IRNoEmptyUnions", {});
    if (!iterableSome(members, (m) => m instanceof IntersectionType)) return true;
    foundIntersection = true;
    return false;
  });
  graph = graph.rewrite("flatten", stringTypeMapping, false, groups, debug, replace);
  return [graph, !needRepeat && !foundIntersection];
}
