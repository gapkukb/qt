import { mapMap } from "collection-utils";
import { JSONSchemaAttributes, JSONSchemaType, Ref } from "../input/JSONSchemaInput";
import { JSONSchema } from "../input/JSONSchemaStore";
import { EnumType } from "../Type";
import { AccessorNames, lookupKey, makeAccessorNames } from "./AccessorNames";
import { TypeAttributeKind } from "./TypeAttributes";

class EnumValuesTypeAttributeKind extends TypeAttributeKind<AccessorNames> {
  constructor() {
    super("enumValues");
  }
  makeInferred(_: AccessorNames) {
    return undefined;
  }
}

export const enumValuesTypeAttributeKind: TypeAttributeKind<AccessorNames> = new EnumValuesTypeAttributeKind();
export function enumCaseValues(e: EnumType, language: string): Map<string, [string, boolean] | undefined> {
  const enumValues = enumValuesTypeAttributeKind.tryGetInAttributes(e.getAttributes());
  if (!enumValues) return mapMap(e.cases.entries(), () => undefined);
  return mapMap(e.cases.entries(), (c) => lookupKey(enumValues, c, language));
}

export function enumValuesAttributeProducer(
  schema: JSONSchema,
  canonicalRef: Ref | undefined,
  types: Set<JSONSchemaType>
): JSONSchemaAttributes | undefined {
  if (typeof schema !== "object") return;
  const maybe = schema["qt-enum-values"];
  if (!maybe) return;
  return { forType: enumValuesTypeAttributeKind.makeAttributes(makeAccessorNames(maybe)) };
}
