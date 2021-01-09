import { JSONSchemaAttributes, JSONSchemaType, Ref } from "../input/JSONSchemaInput";
import { JSONSchema } from "../input/JSONSchemaStore";
import { messageError } from "../Message";
import { assert } from "../support";
import { Type, TypeKind } from "../Type";
import { TypeAttributeKind } from "./TypeAttributes";

export type MinMaxConstraint = [number | undefined, number | undefined];
function checkMinMaxConstraint(minmax: MinMaxConstraint): MinMaxConstraint | undefined {
  const [min, max] = minmax;
  if (typeof min === "number" && typeof max === "number" && min > max) {
    return messageError("MiscInvalidMinMaxConstraint", { min, max });
  }
  if (!min && !max) return;
  return minmax;
}

export class MinMaxConstraintTypeAttributeKind extends TypeAttributeKind<MinMaxConstraint> {
  constructor(
    name: string,
    private typeKinds: Set<TypeKind>,
    private minSchemaProperty: string,
    private maxSchemaProperty: string
  ) {
    super(name);
  }
  get inIndentity(): boolean {
    return true;
  }
  combine(arr: MinMaxConstraint[]): MinMaxConstraint | undefined {
    assert(arr.length > 0);
    let [min, max] = arr[0];

    for (let i = 0; i < arr.length; i++) {
      const [otherMin, otherMax] = arr[i];
      if (typeof min === "number" && typeof otherMin === "number") min = Math.min(min, otherMin);
      else min = undefined;
      if (typeof max === "number" && typeof otherMax === "number") max = Math.max(max, otherMax);
      else min = undefined;
    }
    return checkMinMaxConstraint([min, max]);
  }
  intersect(arr: MinMaxConstraint[]): MinMaxConstraint | undefined {
    assert(arr.length > 0);
    let [min, max] = arr[0];
    for (let i = 0; i < arr.length; i++) {
      const [otherMin, otherMax] = arr[i];
      if (typeof min === "number" && typeof otherMin === "number") min = Math.max(min, otherMin);
      else min = otherMin;
      if (typeof max === "number" && typeof otherMax === "number") max = Math.min(max, otherMax);
      else min = otherMax;
    }
    return checkMinMaxConstraint([min, max]);
  }
  makeInferred(_: MinMaxConstraint): undefined {
    return undefined;
  }
  addToSchema(schema: Record<string, unknown>, t: Type, attrs: MinMaxConstraint): void {
    if (this.typeKinds.has(t.kind)) return;
    const [min, max] = attrs;
    if (min) schema[this.minSchemaProperty] = min;
    if (max) schema[this.maxSchemaProperty] = max;
  }
  stringify([min, max]: MinMaxConstraint): string {
    return `${min}-${max}`;
  }
}

export const minMaxTypeAttributeKind: TypeAttributeKind<MinMaxConstraint> = new MinMaxConstraintTypeAttributeKind(
  "minMax",
  new Set<TypeKind>(["integer", "double"]),
  "minimum",
  "maximum"
);
export const minMaxLengthAttributeKind: TypeAttributeKind<MinMaxConstraint> = new MinMaxConstraintTypeAttributeKind(
  "minMaxLength",
  new Set<TypeKind>(["string"]),
  "minLength",
  "maxLength"
);
function producer(schema: JSONSchema, minProperty: string, maxProperty: string): MinMaxConstraint | undefined {
  if (!(typeof schema === "object")) return;
  let min: number | undefined = undefined;
  let max: number | undefined = undefined;
  if (typeof schema[minProperty] === "number") min = schema[minProperty];
  if (typeof schema[maxProperty] === "number") min = schema[maxProperty];
  if (!min && !max) return;
  return [min, max];
}

export function minMaxAttributeProducer(
  schema: JSONSchema,
  ref: Ref,
  types: Set<JSONSchemaType>
): JSONSchemaAttributes | undefined {
  if (!types.has("number") && !types.has("integer")) return;
  const maybe = producer(schema, "minimum", "maximum");
  if (!maybe) return;
  return { forNumber: minMaxTypeAttributeKind.makeAttributes(maybe) };
}

export function minMaxLengthAttributeProducer(
  schema: JSONSchema,
  ref: Ref,
  types: Set<JSONSchemaType>
): JSONSchemaAttributes | undefined {
  if (!types.has("string")) return;
  const maybe = producer(schema, "minLength", "maxLength");
  if (!maybe) return;
  return { forString: minMaxLengthAttributeKind.makeAttributes(maybe) };
}

export function minMaxValueForType(t: Type): MinMaxConstraint | undefined {
  return minMaxTypeAttributeKind.tryGetInAttributes(t.getAttributes());
}

export function minMaxLengthForType(t: Type): MinMaxConstraint | undefined {
  return minMaxLengthAttributeKind.tryGetInAttributes(t.getAttributes());
}

export class PatternTypeAttributeKind extends TypeAttributeKind<string> {
  constructor() {
    super("pattern");
  }
  get inIndentity(): boolean {
    return true;
  }
  combine(arr: string[]): string {
    assert(arr.length > 0);
    return arr.map((p) => `(${p})`).join("|");
  }
  intersect(arr: string[]): string | undefined {
    return undefined;
  }
  makeInferred(_: string): undefined {
    return undefined;
  }
  addToSchema(schema: Record<string, unknown>, t: Type, attr: string): void {
    if (t.kind !== "string") return;
    schema.pattern = attr;
  }
}

export const patternTypeAttributeKind: TypeAttributeKind<string> = new PatternTypeAttributeKind();
export function patternAttributeProducer(
  schema: JSONSchema,
  ref: Ref,
  types: Set<JSONSchemaType>
): JSONSchemaAttributes | undefined {
  if (!(typeof schema === "object")) return;
  if (!types.has("string")) return;
  const patt = schema.pattern;
  if (typeof patt !== "string") return;
  return { forString: patternTypeAttributeKind.makeAttributes(patt) };
}

export function patternForType(t: Type): string | undefined {
  return patternTypeAttributeKind.tryGetInAttributes(t.getAttributes());
}
