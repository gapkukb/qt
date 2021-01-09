import {
  iterableFirst,
  mapFilterMap,
  mapFromObject,
  mapMergeWithInto,
  setSubtract,
  setUnion,
  setUnionManyInto,
} from "collection-utils";
import { JSONSchemaAttributes, JSONSchemaType, PathElement, PathElementKind, Ref } from "../input/JSONSchemaInput";
import { JSONSchema } from "../input/JSONSchemaStore";
import { Type, TypeKind } from "../Type";
import { emptyTypeAttributes, TypeAttributeKind } from "./TypeAttributes";

export function addDescriptionToSchema(
  schema: Record<string, unknown>,
  description: Iterable<string> | undefined
): void {
  if (!description) return;
  schema.description = Array.from(description).join("\n");
}

class DescriptionTypeAttributeKind extends TypeAttributeKind<ReadonlySet<string>> {
  constructor() {
    super("description");
  }
  combine(attrs: ReadonlySet<string>[]): ReadonlySet<string> {
    return setUnionManyInto(new Set(), attrs);
  }
  makeInferred(_: any): undefined {
    return undefined;
  }
  addToSchema(schema: Record<string, unknown>, t: Type, attrs: ReadonlySet<string>): void {
    addDescriptionToSchema(schema, attrs);
  }
  stringify(description: ReadonlySet<string>): string | undefined {
    let result = iterableFirst(description);
    if (!result) return;
    if (result.length > 5 + 3) result = `${result.substr(0, 5)}...`;
    if (description.size > 1) result = `${result},...`;
    return result;
  }
}

export const descriptionTypeAttributeKind: TypeAttributeKind<ReadonlySet<string>> = new DescriptionTypeAttributeKind();
class PropertyDescriptionTypeAttributeKind extends TypeAttributeKind<Map<string, ReadonlySet<string>>> {
  constructor() {
    super("propertyDescription");
  }
  combine(attrs: Map<string, ReadonlySet<string>>[]): Map<string, ReadonlySet<string>> {
    const result = new Map<string, ReadonlySet<string>>();
    for (const attr of attrs) {
      mapMergeWithInto(result, (sa, sb) => setUnion(sa, sb), attr);
    }
    return result;
  }
  makeInferred(_: any): undefined {
    return undefined;
  }
  stringify(propertyDescription: Map<string, ReadonlySet<string>>): string | undefined {
    if (!propertyDescription.size) return;
    return `prop descs:${propertyDescription.size}`;
  }
}

export const propertyDescriptionTypeAttributeKind: TypeAttributeKind<
  Map<string, ReadonlySet<string>>
> = new PropertyDescriptionTypeAttributeKind();

function isPropertiesKey(el: PathElement): boolean {
  return el.kind === PathElementKind.KeyOrIndex && el.key === "properties";
}

export function descriptionAttributeProducer(
  schema: JSONSchema,
  ref: Ref,
  types: Set<JSONSchemaType>
): JSONSchemaAttributes | undefined {
  if (!(typeof schema === "object")) return;
  let description = emptyTypeAttributes,
    propertyDescription = emptyTypeAttributes;
  const pathLength = ref.path.length;
  if (
    types.has("object") ||
    setSubtract(types, ["null"]).size > 1 ||
    schema.enum ||
    pathLength < 2 ||
    !isPropertiesKey(ref.path[pathLength - 2])
  ) {
    const maybe = schema.description;
    if (typeof maybe === "string") description = descriptionTypeAttributeKind.makeAttributes(new Set([maybe]));
  }
  if (types.has("object") && typeof schema.properties === "object") {
    const propertyDescriptions = mapFilterMap(mapFromObject<any>(schema.properties), (propSchema) => {
      if (typeof propSchema === "object") {
        const desc = propSchema.description;
        if (typeof desc === "string") return new Set([desc]);
      }
      return;
    });
    if (propertyDescriptions.size > 0)
      propertyDescription = propertyDescriptionTypeAttributeKind.makeAttributes(propertyDescriptions);
  }
  return { forType: description, forObject: propertyDescription };
}
