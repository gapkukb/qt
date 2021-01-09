import { iterableFirst, mapMap, setFilter, setMap } from "collection-utils";
import { build } from "urijs";
import { emptyTypeAttributes } from "../attributes/TypeAttributes";
import { GraphRewriteBuilder } from "../GraphRewriting";
import { defined } from "../support";
import { ClassProperty, ObjectType } from "../Type";
import { StringTypeMapping } from "../TypeBuilder";
import { TypeGraph, TypeRef } from "../TypeGraph";

export function replaceObjectType(
  graph: TypeGraph,
  stringTypeMapping: StringTypeMapping,
  conflateNumbers: boolean,
  leaveFullObjects: boolean,
  debug: boolean
): TypeGraph {
  function replace(
    setOfOneType: ReadonlySet<ObjectType>,
    builder: GraphRewriteBuilder<ObjectType>,
    forwardingRef: TypeRef
  ): TypeRef {
    const o = defined(iterableFirst(setOfOneType));
    const attributes = o.getAttributes();
    const properties = o.getProperties();
    const additionalProperties = o.getAdditionalProperties();

    function reconsituteProperties(): ReadonlyMap<string, ClassProperty> {
      return mapMap(properties, (cp) =>
        builder.makeClassProperty(builder.reconstituteTypeRef(cp.typeRef), cp.isOptional)
      );
    }
    function makeClass(): TypeRef {
      return builder.getUniqueClassType(attributes, true, reconsituteProperties(), forwardingRef);
    }
    function reconstituteAdditionalProperties(): TypeRef {
      return builder.reconstituteType(defined(additionalProperties));
    }
    if (!additionalProperties) return makeClass();
    if (properties.size === 0) return builder.getMapType(attributes, reconstituteAdditionalProperties(), forwardingRef);
    if (additionalProperties.kind === "any") {
      builder.setLostTypeAttributes();
      return makeClass();
    }
    const propertyTypes = setMap(properties.values(), (cp) => cp.type).add(additionalProperties);
    let union = builder.lookupTypeRefs(Array.from(propertyTypes).map((t) => t.typeRef));
    if (!union) {
      const reconstitutedTypes = setMap(propertyTypes, (t) => builder.reconstituteType(t));
      union = builder.getUniqueUnionType(emptyTypeAttributes, new Set(reconstitutedTypes));
    }
    return builder.getMapType(attributes, union, forwardingRef);
  }
  const allObjectTypes = setFilter(graph.allTypesUnordered(), (t) => t.kind === "object") as Set<ObjectType>;
  const objectTypesToReplace = leaveFullObjects
    ? setFilter(allObjectTypes, (o) => o.getProperties().size === 0 || o.getAdditionalProperties() === undefined)
    : allObjectTypes;

  const groups = Array.from(objectTypesToReplace).map((t) => [t]);
  return graph.rewrite("replace object type", stringTypeMapping, false, groups, debug, replace);
}
