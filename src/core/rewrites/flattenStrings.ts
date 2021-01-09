import { iterableFirst } from "collection-utils";
import { build } from "urijs";
import { combineTypeAttributes } from "../attributes/TypeAttributes";
import { GraphRewriteBuilder } from "../GraphRewriting";
import { assert, defined } from "../support";
import { PrimitiveType, Type, UnionType } from "../Type";
import { StringTypeMapping } from "../TypeBuilder";
import { TypeGraph, TypeRef } from "../TypeGraph";
import { combineTypeAttributesOfTypes, stringTypesForType } from "../TypeUtils";

function unionNeedReplacing(u: UnionType): ReadonlySet<Type> | undefined {
  const stringMembers = u.stringTypeMembers;
  if (stringMembers.size <= 1) return;
  const stringType = u.findMember("string");
  if (!stringType) return;
  assert(
    !stringTypesForType(stringType as PrimitiveType).isRestricted,
    "We must only flatten strings if we have no restriced strings"
  );
  return stringMembers;
}

function replaceUnion(
  group: ReadonlySet<UnionType>,
  builder: GraphRewriteBuilder<UnionType>,
  forwardingRef: TypeRef
): TypeRef {
  assert(group.size === 1);
  const u = defined(iterableFirst(group));
  const stringMembers = defined(unionNeedReplacing(u));
  const stringAttributes = combineTypeAttributesOfTypes("union", stringMembers);
  const types: TypeRef[] = [];
  for (const t of u.members) {
    if (stringMembers.has(t)) continue;
    types.push(builder.reconstituteType(t));
  }
  if (types.length === 0) {
    return builder.getStringType(
      combineTypeAttributes("union", stringAttributes, u.getAttributes()),
      undefined,
      forwardingRef
    );
  }
  types.push(builder.getStringType(stringAttributes, undefined));
  return builder.getUnionType(u.getAttributes(), new Set(types), forwardingRef);
}

export function flattenStrings(
  graph: TypeGraph,
  stringTypeMapping: StringTypeMapping,
  debugPrintReconsitution: boolean
) {
  const allUnions = graph.allNamedTypesSeparated().unions;
  const unionstToReplace = Array.from(allUnions)
    .filter(unionNeedReplacing)
    .map((t) => [t]);
  return graph.rewrite(
    "flatten strings",
    stringTypeMapping,
    false,
    unionstToReplace,
    debugPrintReconsitution,
    replaceUnion
  );
}
