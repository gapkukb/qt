import { mapMap, mapMerge, mapUpdateInto, setUnionInto } from "collection-utils";
import { StringTypes, stringTypesTypeAttributeKind } from "./attributes/StringTypes";
import {
  combineTypeAttributes,
  emptyTypeAttributes,
  increaseTypeAttributesDistance,
  makeTypeAttributesInferred,
  TypeAttributes,
} from "./attributes/TypeAttributes";
import { assert, assertNever, defined, panic } from "./support";
import {
  isPrimitiveTypeKind,
  MapType,
  PrimitiveStringTypeKind,
  PrimitiveTypeKind,
  Type,
  TypeKind,
  UnionType,
} from "./Type";
import { TypeBuilder } from "./TypeBuilder";
import { TypeRef } from "./TypeGraph";
import { matchTypeExhaustive } from "./TypeUtils";

export interface UnionTypeProvider<TArrayData, TObjectData> {
  readonly arrayData: TArrayData;
  readonly objectData: TObjectData;
  readonly enumCases: ReadonlySet<string>;
  getMemberKinds(): TypeAttributeMap<TypeKind>;
  readonly lostTypeAttributes: boolean;
}

export type TypeAttributeMap<T extends TypeKind> = Map<T, TypeAttributes>;
type TypeAttributeMapBuilder<T extends TypeKind> = Map<T, TypeAttributes[]>;

function addAttributes(
  accumulatorAttributes: TypeAttributes | undefined,
  newAttributes: TypeAttributes
): TypeAttributes {
  if (!accumulatorAttributes) return newAttributes;
  return combineTypeAttributes("union", accumulatorAttributes, newAttributes);
}

function setAttributes<T extends TypeKind>(
  attributeMap: TypeAttributeMap<T>,
  kind: T,
  newAttributes: TypeAttributes
): void {
  attributeMap.set(kind, addAttributes(attributeMap.get(kind), newAttributes));
}

function addAttributesToBuilder<T extends TypeKind>(
  builder: TypeAttributeMapBuilder<T>,
  kind: T,
  newAttributes: TypeAttributes
): void {
  let arr = builder.get(kind);
  if (!arr) {
    arr = [];
    builder.set(kind, arr);
  }
  arr.push(newAttributes);
}

function buildTypeAttributeMap<T extends TypeKind>(builder: TypeAttributeMapBuilder<T>): TypeAttributeMap<T> {
  return mapMap(builder, (arr) => combineTypeAttributes("union", arr));
}

function moveAttributes<T extends TypeKind>(map: TypeAttributeMap<T>, fromKind: T, toKind: T): void {
  const fromAttributes = defined(map.get(fromKind));
  map.delete(fromKind);
  setAttributes(map, toKind, fromAttributes);
}

export class UnionAccumulator<TArray, TObject> implements UnionTypeProvider<TArray[], TObject[]> {
  readonly #nonStringTypeAttributes: TypeAttributeMapBuilder<TypeKind> = new Map();
  readonly #stringTypeAttributes: TypeAttributeMapBuilder<PrimitiveStringTypeKind> = new Map();
  readonly arrayData: TArray[] = [];
  readonly objectData: TObject[] = [];
  readonly #enumCases: Set<string> = new Set();
  #lostTypeAttributes: boolean = false;
  constructor(private readonly conflateNumbers: boolean) {}
  private have(kind: TypeKind): boolean {
    return this.#nonStringTypeAttributes.has(kind) || this.#stringTypeAttributes.has(kind as PrimitiveStringTypeKind);
  }
  addNone(attributes: TypeAttributes): void {
    this.#lostTypeAttributes = true;
  }
  addAny(attributes: TypeAttributes): void {
    addAttributesToBuilder(this.#nonStringTypeAttributes, "any", attributes);
    this.#lostTypeAttributes = true;
  }
  addPrimitive(kind: PrimitiveTypeKind, attributes: TypeAttributes): void {
    assert(kind !== "any", "any must be added with addany");
    addAttributesToBuilder(this.#nonStringTypeAttributes, kind, attributes);
  }
  protected addFullStringType(attributes: TypeAttributes, stringTypes: StringTypes | undefined): void {
    let stringTypesAttributes: TypeAttributes | undefined = undefined;
    if (!stringTypes) {
      stringTypes = stringTypesTypeAttributeKind.tryGetInAttributes(attributes);
    } else {
      stringTypesAttributes = stringTypesTypeAttributeKind.makeAttributes(stringTypes);
    }
    if (!stringTypes) {
      stringTypes = StringTypes.unrestricted;
      stringTypesAttributes = stringTypesTypeAttributeKind.makeAttributes(stringTypes);
    }
    const maybeEnumAttributes = this.#nonStringTypeAttributes.get("enum");
    if (stringTypes.isRestricted)
      assert(!maybeEnumAttributes, "We can't add both an enum as well as a restricted string type to a union builder");

    addAttributesToBuilder(this.#stringTypeAttributes, "string", attributes);
    if (stringTypesAttributes) addAttributesToBuilder(this.#stringTypeAttributes, "string", stringTypesAttributes);
  }
  addStringType(kind: PrimitiveStringTypeKind, attributes: TypeAttributes, stringTypes?: StringTypes): void {
    if (kind === "string") return this.addFullStringType(attributes, stringTypes);
    addAttributesToBuilder(this.#stringTypeAttributes, kind, attributes);
    if (stringTypes)
      addAttributesToBuilder(
        this.#stringTypeAttributes,
        kind,
        stringTypesTypeAttributeKind.makeAttributes(stringTypes)
      );
  }
  addArray(t: TArray, attributes: TypeAttributes): void {
    this.arrayData.push(t);
    addAttributesToBuilder(this.#nonStringTypeAttributes, "array", attributes);
  }
  addObject(t: TObject, attributes: TypeAttributes): void {
    this.objectData.push(t);
    addAttributesToBuilder(this.#nonStringTypeAttributes, "object", attributes);
  }
  addEnum(cases: ReadonlySet<string>, attributes: TypeAttributes): void {
    const maybeStringAttributes = this.#stringTypeAttributes.get("string");
    if (maybeStringAttributes) return addAttributesToBuilder(this.#stringTypeAttributes, "string", attributes);
    addAttributesToBuilder(this.#nonStringTypeAttributes, "enum", attributes);
    setUnionInto(this.#enumCases, cases);
  }
  addStringCases(cases: string[], attributes: TypeAttributes): void {
    this.addFullStringType(attributes, StringTypes.fromCases(cases));
  }
  addStringCase(s: string, count: number, attributes: TypeAttributes): void {
    this.addFullStringType(attributes, StringTypes.fromCase(s, count));
  }
  get enumCases(): ReadonlySet<string> {
    return this.#enumCases;
  }
  getMemberKinds(): TypeAttributeMap<TypeKind> {
    assert(!(this.have("enum") && this.have("string")), "We can't have both strings and enums in the same union");
    let merged = mapMerge(
      buildTypeAttributeMap(this.#nonStringTypeAttributes),
      buildTypeAttributeMap(this.#stringTypeAttributes)
    );
    if (merged.size === 0) return new Map([["none", emptyTypeAttributes] as [TypeKind, TypeAttributes]]);
    if (this.#nonStringTypeAttributes.has("any")) {
      assert(this.#lostTypeAttributes, "This had to be set when we added 'any'");
      const allAttributes = combineTypeAttributes("union", Array.from(merged.values()));
      return new Map([["any", allAttributes] as [TypeKind, TypeAttributes]]);
    }
    if (this.conflateNumbers && this.have("integer") && this.have("double")) {
      moveAttributes(merged, "integer", "double");
    }
    if (this.have("map")) moveAttributes(merged, "map", "class");
    return merged;
  }
  get lostTypeAttributes(): boolean {
    return this.#lostTypeAttributes;
  }
}

class FauxUnion {
  getAttributes(): TypeAttributes {
    return emptyTypeAttributes;
  }
}

type UnionOrFaux = UnionType | FauxUnion;

function attributesForTypes(types: Iterable<Type>): [ReadonlyMap<Type, TypeAttributes>, TypeAttributes] {
  const unionsForType = new Map<Type, Set<UnionOrFaux>>();
  const typesForType = new Map<UnionOrFaux, Set<Type>>();
  const unions = new Set<UnionType>();
  let unionsEquivalentToRoot: Set<UnionType> = new Set();
  function traverse(t: Type, path: UnionOrFaux[], isEquivalentToRoot: boolean): void {
    if (t instanceof UnionType) {
      unions.add(t);
      if (isEquivalentToRoot) unionsEquivalentToRoot = unionsEquivalentToRoot.add(t);
      isEquivalentToRoot = isEquivalentToRoot && t.members.size === 1;
      path.push(t);
      for (const m of t.members) {
        traverse(m, path, isEquivalentToRoot);
      }
      path.pop();
    } else {
      mapUpdateInto(unionsForType, t, (s) => (s ? setUnionInto(s, path) : new Set(path)));
      for (const u of path) {
        mapUpdateInto(typesForType, u, (s) => (s ? s.add(t) : new Set([t])));
      }
    }
  }
  const rootPath = [new FauxUnion()];
  const typesArray = Array.from(types);

  for (const t of typesArray) {
    traverse(t, rootPath, typesArray.length === 1);
  }

  const resultAttributes = mapMap(unionsForType, (unionForType, t) => {
    const singleAncestors = Array.from(unionForType).filter((u) => defined(typesForType.get(u)).size === 1);
    assert(
      singleAncestors.every((u) => defined(typesForType.get(u)).has(t)),
      "We messed up bookkeeping"
    );
    const inheritedAttributes = singleAncestors.map((u) => u.getAttributes());
    return combineTypeAttributes("union", [t.getAttributes()].concat(inheritedAttributes));
  });

  const unionAttibutes = Array.from(unions).map((u) => {
    const t = typesForType.get(u);
    if (t && t.size === 1) return emptyTypeAttributes;
    const attributes = u.getAttributes();
    if (unionsEquivalentToRoot.has(u)) return attributes;
    return makeTypeAttributesInferred(attributes);
  });

  return [resultAttributes, combineTypeAttributes("union", unionAttibutes)];
}

export class TypeRefUnionAccumulator extends UnionAccumulator<TypeRef, TypeRef> {
  private addType(t: Type, attributes: TypeAttributes): void {
    matchTypeExhaustive(
      t,
      (noneType) => this.addNone(attributes),
      (anyType) => this.addAny(attributes),
      (nullType) => this.addPrimitive("null", attributes),
      (boolType) => this.addPrimitive("bool", attributes),
      (integerType) => this.addPrimitive("integer", attributes),
      (doubleType) => this.addPrimitive("double", attributes),
      (stringType) => this.addPrimitive("string", attributes),
      (arrayType) => this.addArray(arrayType.items.typeRef, attributes),
      (classType) => this.addObject(classType.typeRef, attributes),
      (mapType) => this.addObject(mapType.typeRef, attributes),
      (objectType) => this.addObject(objectType.typeRef, attributes),
      (enumType) => this.addEnum(enumType.cases, attributes),
      (unionType) => {
        return panic("The unions should have been eliminated in attributesForTypesUnion");
      },
      (transformedStringType) => this.addStringType(transformedStringType.kind as PrimitiveStringTypeKind, attributes)
    );
  }
  addTypes(types: Iterable<Type>): TypeAttributes {
    const [attributesMap, unionAttibutes] = attributesForTypes(types);
    for (const [t, attributes] of attributesMap) {
      this.addType(t, attributes);
    }
    return unionAttibutes;
  }
}
type MakeType<T> = (objects: T, typeAttributes: TypeAttributes, forwardingRef: TypeRef | undefined) => TypeRef;
export abstract class UnionBuilder<TBuilder extends TypeBuilder, TArrayData, TObjectData> {
  constructor(protected readonly typeBuilder: TBuilder) {}
  protected abstract makeObject(
    objects: TObjectData,
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef;
  protected abstract makeArray(
    objects: TArrayData,
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef;
  private makeTypeOfKind(
    typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
    kind: TypeKind,
    typeAttributes: TypeAttributes,
    forwardngRef: TypeRef | undefined
  ): TypeRef {
    switch (kind) {
      case "string":
        return this.typeBuilder.getStringType(typeAttributes, undefined, forwardngRef);
      case "enum":
        return this.typeBuilder.getEnumType(typeAttributes, typeProvider.enumCases, forwardngRef);
      case "object":
        return this.makeObject(typeProvider.objectData, typeAttributes, forwardngRef);
      case "array":
        return this.makeArray(typeProvider.arrayData, typeAttributes, forwardngRef);
      default:
        if (isPrimitiveTypeKind(kind)) return this.typeBuilder.getPrimitiveType(kind, typeAttributes, forwardngRef);
        if (kind === "union" || kind === "class" || kind === "map" || kind === "intersection") {
          return panic("getMemberKinds() shouldn't return " + kind);
        }
        return assertNever(kind);
    }
  }
  buildUnion(
    typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
    unique: boolean,
    typeAttributes: TypeAttributes,
    forwardingRef?: TypeRef
  ): TypeRef {
    const kinds = typeProvider.getMemberKinds();
    if (typeProvider.lostTypeAttributes) {
      this.typeBuilder.setLostTypeAttributes();
    }
    if (kinds.size === 1) {
      const [[kind, memberAttributes]] = Array.from(kinds);
      const allAttributes = combineTypeAttributes(
        "union",
        typeAttributes,
        increaseTypeAttributesDistance(memberAttributes)
      );
      const t = this.makeTypeOfKind(typeProvider, kind, allAttributes, forwardingRef);
      return t;
    }
    const union = unique ? this.typeBuilder.getUniqueUnionType(typeAttributes, undefined, forwardingRef) : undefined;
    let types: TypeRef[] = [];
    for (const [kind, memberAttributes] of kinds) {
      types.push(this.makeTypeOfKind(typeProvider, kind, memberAttributes, undefined));
    }
    const typeSet = new Set(types);
    if (union) {
      this.typeBuilder.setSetOperationMembers(union, typeSet);
      return union;
    } else {
      return this.typeBuilder.getUnionType(typeAttributes, typeSet, forwardingRef);
    }
  }
}
