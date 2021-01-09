import { inferTransformedStringTypeKindForString, StringTypes } from "../attributes/StringTypes";
import { emptyTypeAttributes, TypeAttributes } from "../attributes/TypeAttributes";
import { messageError } from "../Message";
import { assert, assertNever, defined, panic } from "../support";
import {
  ArrayType,
  ClassProperty,
  ClassType,
  MapType,
  transformedStringTypeKinds,
  transformedStringTypeTargetTypeKindsMap,
  UnionType,
} from "../Type";
import { TypeBuilder } from "../TypeBuilder";
import { derefTypeRef, TypeRef } from "../TypeGraph";
import { nullableFromUnion } from "../TypeUtils";
import { UnionAccumulator, UnionBuilder } from "../UnionBuilder";
import { CompressedJSON, Tag, Value, valueTag } from "./CompressedJSON";

export type NestedValueArray = any;

function forEachArrayInNestedValueArray(va: NestedValueArray, f: (va: Value[]) => void): void {
  if (!va.length) return;
  if (Array.isArray(va[0]))
    for (const x of va) {
      forEachArrayInNestedValueArray(x, f);
    }
  else f(va);
}
function forEachValueInNestedValueArray(va: NestedValueArray, f: (v: Value) => void): void {
  forEachArrayInNestedValueArray(va, (a) => {
    for (const x of a) {
      f(x);
    }
  });
}

class InferenceUnionBuilder extends UnionBuilder<TypeBuilder, NestedValueArray, NestedValueArray> {
  constructor(
    typeBuilder: TypeBuilder,
    private readonly typeInference: TypeInference,
    private readonly fixed: boolean
  ) {
    super(typeBuilder);
  }
  protected makeObject(
    objects: NestedValueArray,
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef {
    return this.typeInference.inferClassType(typeAttributes, objects, this.fixed);
  }
  protected makeArray(
    arrays: NestedValueArray,
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef {
    return this.typeBuilder.getArrayType(
      typeAttributes,
      this.typeInference.inferType(emptyTypeAttributes, arrays, this.fixed, forwardingRef)
    );
  }
}

function canBeEnumCase(s: string): boolean {
  return true;
}

export type Accumulator = UnionAccumulator<NestedValueArray, NestedValueArray>;

export class TypeInference {
  #refIntersection: [TypeRef, string[]][] | undefined;
  constructor(
    private readonly cjson: CompressedJSON<unknown>,
    private readonly typeBuilder: TypeBuilder,
    private readonly inferMaps: boolean,
    private readonly inferEnums: boolean
  ) {}

  addValuesToAccumulator(valueArray: NestedValueArray, accumulator: Accumulator): void {
    forEachValueInNestedValueArray(valueArray, (value) => {
      const t = valueTag(value);
      switch (t) {
        case Tag.Null:
          accumulator.addPrimitive("null", emptyTypeAttributes);
          break;
        case Tag.False:
        case Tag.True:
          accumulator.addPrimitive("bool", emptyTypeAttributes);
          break;
        case Tag.Integer:
          accumulator.addPrimitive("integer", emptyTypeAttributes);
          break;
        case Tag.Double:
          accumulator.addPrimitive("double", emptyTypeAttributes);
          break;
        case Tag.InternedString:
          if (this.inferEnums) {
            const s = this.cjson.getStringForValue(value);
            if (canBeEnumCase(s)) accumulator.addStringCase(s, 1, emptyTypeAttributes);
            else accumulator.addStringType("string", emptyTypeAttributes);
          } else {
            accumulator.addStringType("string", emptyTypeAttributes);
          }
          break;
        case Tag.UninternedString:
          accumulator.addStringType("string", emptyTypeAttributes);
          break;
        case Tag.Object:
          accumulator.addObject(this.cjson.getObjectForValue(value), emptyTypeAttributes);
          break;
        case Tag.Array:
          accumulator.addArray(this.cjson.getArrayForValue(value), emptyTypeAttributes);
        case Tag.StringFormat: {
          const kind = this.cjson.getStringFormatTypeKind(value);
          accumulator.addStringType("string", emptyTypeAttributes, new StringTypes(new Map(), new Set([kind])));
          break;
        }
        case Tag.TransformedString: {
          const s = this.cjson.getStringForValue(value);
          const kind = inferTransformedStringTypeKindForString(s, this.cjson.dateTimeRecognizer);
          if (!kind) return panic("TransformedString does not have a kind");
          const producer = (<any>defined(transformedStringTypeTargetTypeKindsMap.get(kind))).attributesProducer;
          if (!producer) return panic("TransformedString does not have attribute producer");
          accumulator.addStringType("string", producer(s), new StringTypes(new Map(), new Set([kind])));
          break;
        }
        default:
          return assertNever(t);
      }
    });
  }
  inferType(
    typeAttributes: TypeAttributes,
    valueArray: NestedValueArray,
    fixed: boolean,
    forwardingRef?: TypeRef
  ): TypeRef {
    const accumulator = this.accumulatorForArray(valueArray);
    return this.makeTypeFromAccumulator(accumulator, typeAttributes, fixed, forwardingRef);
  }

  private resolveRef(ref: string, topLevel: TypeRef): TypeRef {
    if (!ref.startsWith("#/")) return messageError("InferenceJSONReferenceNotRooted", { reference: ref });
    const parts = ref.split("/").slice(1);
    const graph = this.typeBuilder.typeGraph;
    let $ref = topLevel;
    for (const part of parts) {
      let t = derefTypeRef($ref, graph);
      if (t instanceof UnionType) {
        const nullable = nullableFromUnion(t);
        if (!nullable) return messageError("InferenceJSONReferenceToUnion", { reference: ref });
        t = nullable;
      }
      if (t instanceof ClassType) {
        const cp = t.getProperties().get(part);
        if (!cp) return messageError("InferenceJSONReferenceWrongProperty", { reference: ref });
        $ref = cp.typeRef;
      } else if (t instanceof MapType) {
        $ref = t.values.typeRef;
      } else if (t instanceof ArrayType) {
        if (part.match("^[0-9]+$") === null)
          return messageError("InferenceJSONReferenceInvalidArrayIndex", { reference: ref });
        $ref = t.items.typeRef;
      } else {
        return messageError("InferenceJSONReferenceWrongProperty", { reference: ref });
      }
    }
    return $ref;
  }
  inferTopLevelType(typeAttributes: TypeAttributes, valueArray: NestedValueArray, fixed: boolean): TypeRef {
    assert(!this.#refIntersection, "Didn't reset ref intersection - nested invocations?");
    if (this.cjson.handleRefs) this.#refIntersection = [];
    const topLevel = this.inferType(typeAttributes, valueArray, fixed);
    if (this.cjson.handleRefs) {
      for (const [tref, refs] of defined(this.#refIntersection)) {
        const resolved = refs.map((r) => this.resolveRef(r, topLevel));
        this.typeBuilder.setSetOperationMembers(tref, new Set(resolved));
      }
    }
    return topLevel;
  }
  accumulatorForArray(valueArray: NestedValueArray): Accumulator {
    const accumulator = new UnionAccumulator<NestedValueArray, NestedValueArray>(true);
    this.addValuesToAccumulator(valueArray, accumulator);
    return accumulator;
  }
  makeTypeFromAccumulator(
    accumulator: Accumulator,
    typeAttibutes: TypeAttributes,
    fixed: boolean,
    forwardingRef?: TypeRef
  ): TypeRef {
    const unionBuilder = new InferenceUnionBuilder(this.typeBuilder, this, fixed);
    return unionBuilder.buildUnion(accumulator, false, typeAttibutes, forwardingRef);
  }
  inferClassType(
    typeAttributes: TypeAttributes,
    objects: NestedValueArray,
    fixed: boolean,
    forwardingRef?: TypeRef
  ): TypeRef {
    const propertyNames: string[] = [];
    const propertyValus: Record<string, Value[]> = {};
    forEachArrayInNestedValueArray(objects, (arr) => {
      for (let i = 0; i < arr.length; i++) {
        const key = this.cjson.getStringForValue(arr[i]);
        const value = arr[i + 1];
        if (!Object.prototype.hasOwnProperty.call(propertyValus, key)) {
          propertyNames.push(key);
          propertyValus[key] = [];
        }
        propertyValus[key].push(value);
      }
    });
    if (this.cjson.handleRefs && propertyNames.length === 1 && propertyNames[0] === "$ref") {
      const values = propertyValus["$ref"];
      if (values.every((v) => valueTag(v) === Tag.InternedString)) {
        const allRefs = values.map((v) => this.cjson.getStringForValue(v));
        const ref = this.typeBuilder.getUniqueIntersectionType(typeAttributes, undefined);
        defined(this.#refIntersection).push([ref, allRefs]);
        return ref;
      }
    }

    if (this.inferMaps && propertyNames.length > 500) {
      const accumulator = new UnionAccumulator<NestedValueArray, NestedValueArray>(true);
      for (const key of propertyNames) {
        this.addValuesToAccumulator(propertyValus[key], accumulator);
      }
      const values = this.makeTypeFromAccumulator(accumulator, typeAttributes, fixed);
      return this.typeBuilder.getMapType(typeAttributes, values, forwardingRef);
    }
    const properties = new Map<string, ClassProperty>();
    for (const key of propertyNames) {
      const values = propertyValus[key];
      const t = this.inferType(emptyTypeAttributes, values, false);
      const isOptional = values.length < objects.length;
      properties.set(key, this.typeBuilder.makeClassProperty(t, isOptional));
    }
    if (fixed) return this.typeBuilder.getUniqueClassType(typeAttributes, true, properties, forwardingRef);
    return this.typeBuilder.getClassType(typeAttributes, properties, forwardingRef);
  }
}
