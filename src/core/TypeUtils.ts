import { EqualityMap, iterableFirst, setFilter, setSortBy, setUnion } from "collection-utils";
import { StringTypes, stringTypesTypeAttributeKind } from "./attributes/StringTypes";
import {
  CombinationKind,
  combineTypeAttributes,
  emptyTypeAttributes,
  TypeAttributes,
} from "./attributes/TypeAttributes";
import { assert, assertNever, defined, panic } from "./support";
import {
  ArrayType,
  ClassProperty,
  ClassType,
  EnumType,
  isPrimitiveStringTypeKind,
  MapType,
  ObjectType,
  PrimitiveType,
  SetOperationType,
  Type,
  UnionType,
} from "./Type";

export function assertIsObject(t: Type): ObjectType {
  if (t instanceof ObjectType) return t;
  return panic("Support object type is not an object type");
}

export function assetIsClass(t: Type): ClassType {
  if (!(t instanceof ClassType)) return panic("Support class type is not a class type");
  return t;
}

export function setOperationMembersRecursively<T extends SetOperationType>(
  oneOrMany: T | T[],
  combinationKind: CombinationKind | undefined
): [ReadonlySet<Type>, TypeAttributes] {
  const setOperation: T[] = Array.isArray(oneOrMany) ? oneOrMany : [oneOrMany];
  const kind = setOperation[0].kind;
  const includeAny = kind !== "intersection";
  const processedSetOperation = new Set<T>();
  const members = new Set<Type>();
  let attributes = emptyTypeAttributes;

  function process(t: Type): void {
    if (t.kind === kind) {
      const so = t as T;
      if (processedSetOperation.has(so)) return;
      processedSetOperation.add(so);
      if (combinationKind) attributes = combineTypeAttributes(combinationKind, attributes, t.getAttributes());
      for (const m of so.members) {
        process(m);
      }
    } else if (includeAny || t.kind !== "any") {
      members.add(t);
    } else if (combinationKind) {
      attributes = combineTypeAttributes(combinationKind, attributes, t.getAttributes());
    }
  }
  for (const so of setOperation) {
    process(so);
  }
  return [members, attributes];
}

export function makeGroupToFlatten<T extends SetOperationType>(
  setOperations: Iterable<T>,
  include: ((members: ReadonlySet<Type>) => boolean) | undefined
): Type[][] {
  const typeGroups = new EqualityMap<Set<Type>, Set<Type>>();
  for (const u of setOperations) {
    const members = new Set(setOperationMembersRecursively(u, undefined)[0]);
    if (include && !include(members)) continue;
    let maybe = typeGroups.get(members);
    if (!maybe) {
      maybe = new Set();
      if (members.size === 1) {
        maybe.add(defined(iterableFirst(members)));
      }
    }
    maybe.add(u);
    typeGroups.set(members, maybe);
  }
  return Array.from(typeGroups.values()).map((ts) => Array.from(ts));
}

export function combineTypeAttributesOfTypes(combinationKind: CombinationKind, types: Iterable<Type>): TypeAttributes {
  return combineTypeAttributes(
    combinationKind,
    Array.from(types).map((t) => t.getAttributes())
  );
}

export function isAnyOrNull(t: Type): boolean {
  return t.kind === "any" || t.kind === "null";
}

export function removeNullFromUnion(
  t: UnionType,
  sortBy: boolean | ((t: Type) => any) = false
): [PrimitiveType | null, ReadonlySet<Type>] {
  function sort(s: ReadonlySet<Type>): ReadonlySet<Type> {
    if (sortBy === false) return s;
    if (sortBy === true) return setSortBy(s, (m) => m.kind);
    return setSortBy(s, sortBy);
  }
  const nullType = t.findMember("null");
  if (!nullType) return [null, sort(t.members)];
  return [nullType as PrimitiveType, sort(setFilter(t.members, (m) => m.kind !== "null"))];
}

export function removeNullFromType(t: Type): [PrimitiveType | null, ReadonlySet<Type>] {
  if (t.kind === "null") return [t as PrimitiveType, new Set()];
  if (!(t instanceof UnionType)) return [null, new Set([t])];
  return removeNullFromUnion(t);
}

export function nullableFromUnion(t: UnionType): Type | null {
  const [hasNull, nonNulls] = removeNullFromUnion(t);
  if (!hasNull) return null;
  if (nonNulls.size !== 1) return null;
  return defined(iterableFirst(nonNulls));
}

export function nonNullTypeCases(t: Type): ReadonlySet<Type> {
  return removeNullFromType(t)[1];
}

export function getNullAsOptional(cp: ClassProperty): [boolean, ReadonlySet<Type>] {
  const [maybeNull, nonNulls] = removeNullFromType(cp.type);
  if (cp.isOptional) return [true, nonNulls];
  return [maybeNull !== null, nonNulls];
}

export function isNamedType(t: Type): boolean {
  return ["class", "union", "enum", "object"].includes(t.kind);
}

export type SeparatedNamedTypes = {
  objects: ReadonlySet<ObjectType>;
  enums: ReadonlySet<EnumType>;
  unions: ReadonlySet<UnionType>;
};

export function separatedNamedTypes(types: Iterable<Type>): SeparatedNamedTypes {
  const objects = (setFilter(
    types,
    (t) => t.kind === "object" || t.kind === "class"
  ) as Set<ObjectType>) as ReadonlySet<ObjectType>;
  const enums = (setFilter(types, (t) => t instanceof EnumType) as Set<EnumType>) as ReadonlySet<EnumType>;
  const unions = (setFilter(types, (t) => t instanceof UnionType) as Set<UnionType>) as ReadonlySet<UnionType>;
  return { objects, enums, unions };
}

export function directlyReachableTypes<T>(t: Type, setForType: (t: Type) => ReadonlySet<T> | null): ReadonlySet<T> {
  return (
    setForType(t) ||
    setUnion(...Array.from(t.getNonAttributeChildren()).map((c) => directlyReachableTypes(c, setForType)))
  );
}

export function directlyReachableSingleNamedType(type: Type): Type | undefined {
  const definedTypes = directlyReachableTypes(type, (t) => {
    let f1 = !(t instanceof UnionType) && isNamedType(t);
    let f2 = t instanceof UnionType && !nullableFromUnion(t);

    if (f1 || f2) return new Set([t]);
    return null;
  });
  assert(definedTypes.size <= 1, "Can't have more than one defined type per top-level");
  return iterableFirst(definedTypes);
}

export function stringTypesForType(t: PrimitiveType): StringTypes {
  assert(t.kind === "string", "Only strings can have string types");
  const stringTypes = stringTypesTypeAttributeKind.tryGetInAttributes(t.getAttributes());
  if (!stringTypes) return panic("All strings must have a string type attribute");
  return stringTypes;
}

export type StringTypeMatchers<U> = Partial<{
  dateType: (dateType: PrimitiveType) => U;
  timeType: (timeType: PrimitiveType) => U;
  dateTimeType: (dateTimeType: PrimitiveType) => U;
}>;

export function matchTypeExhaustive<U>(
  t: Type,
  noneType: (noneType: PrimitiveType) => U,
  anyType: (anyType: PrimitiveType) => U,
  nullType: (nullType: PrimitiveType) => U,
  boolType: (boolType: PrimitiveType) => U,
  integerType: (integerType: PrimitiveType) => U,
  doubleType: (doubleType: PrimitiveType) => U,
  stringType: (stringType: PrimitiveType) => U,
  arrayType: (arrayType: ArrayType) => U,
  classType: (classType: ClassType) => U,
  mapType: (mapType: MapType) => U,
  objectType: (objectType: ObjectType) => U,
  enumType: (enumType: EnumType) => U,
  unionType: (unionType: UnionType) => U,
  transformedStringType: (transformedStringType: PrimitiveType) => U
): U {
  if (t.isPrimitive()) {
    if (isPrimitiveStringTypeKind(t.kind)) {
      return t.kind === "string" ? stringType(t) : transformedStringType(t);
    }
    const kind = t.kind;
    const f = {
      none: noneType,
      any: anyType,
      null: nullType,
      bool: boolType,
      integer: integerType,
      double: doubleType,
    }[kind];
    if (f) return f(t);
    return assertNever(f);
  } else if (t instanceof ArrayType) return arrayType(t);
  else if (t instanceof ClassType) return classType(t);
  else if (t instanceof MapType) return mapType(t);
  else if (t instanceof ObjectType) return objectType(t);
  else if (t instanceof EnumType) return enumType(t);
  else if (t instanceof UnionType) return unionType(t);
  return panic(`Unknown type ${t.kind}`);
}
export function matchType<U>(
  t: Type,
  noneType: (noneType: PrimitiveType) => U,
  anyType: (anyType: PrimitiveType) => U,
  nullType: (nullType: PrimitiveType) => U,
  boolType: (boolType: PrimitiveType) => U,
  integerType: (integerType: PrimitiveType) => U,
  doubleType: (doubleType: PrimitiveType) => U,
  stringType: (stringType: PrimitiveType) => U,
  arrayType: (arrayType: ArrayType) => U,
  classType: (classType: ClassType) => U,
  mapType: (mapType: MapType) => U,
  objectType: (objectType: ObjectType) => U,
  enumType: (enumType: EnumType) => U,
  unionType: (unionType: UnionType) => U,
  transformedStringType: (transformedStringType: PrimitiveType) => U
): U {
  function typeNotSupported(t: Type) {
    return panic(`Unsupported type ${t.kind} in non-exhaustive match`);
  }
  return matchTypeExhaustive(
    t,
    noneType,
    anyType,
    nullType,
    boolType,
    integerType,
    doubleType,
    stringType,
    arrayType,
    classType,
    mapType,
    objectType,
    enumType,
    unionType,
    transformedStringType || typeNotSupported
  );
}

export function matchcompoundType(
  t: Type,
  arrayType: (arrayType: ArrayType) => void,
  classType: (classType: ClassType) => void,
  mapType: (mapType: MapType) => void,
  objectType: (objectType: ObjectType) => void,
  unionType: (unionType: UnionType) => void
) {
  function ignore<T extends Type>(_: T): void {
    return;
  }
  return matchTypeExhaustive(
    t,
    ignore,
    ignore,
    ignore,
    ignore,
    ignore,
    ignore,
    ignore,
    arrayType,
    classType,
    mapType,
    objectType,
    enumType,
    unionType,
    ignore
  );
}
