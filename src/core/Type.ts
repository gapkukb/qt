import {
  addHashCode,
  areEqual,
  definedMap,
  hashCodeInit,
  hashCodeOf,
  hasOwnProperty,
  iterableEvery,
  iterableFind,
  iterableSome,
  mapFilter,
  mapFromObject,
  mapMap,
  mapSome,
  mapSortByKey,
  mapSortToArray,
  setFilter,
  setMap,
  setSortBy,
  setUnion,
  setUnionInto,
  toReadonlyArray,
  toReadonlySet,
} from "collection-utils";
import { build } from "urijs";
import { TypeAttributes } from "./attributes/TypeAttributes";
import { namesTypeAttributeKind, TypeNames } from "./attributes/TypeNames";
import { BaseGraphRewriteBuilder, TypeReconstituter } from "./GraphRewriting";
import { messageAssert } from "./Message";
import { assert, defined, panic } from "./support";
import { attributesForTypeRef, derefTypeRef, TypeGraph, TypeRef } from "./TypeGraph";

export type TransformedStringTypeTargets = {
  jsonSchema: string;
  primitive?: PrimitiveNonStringTypeKind;
  attributesProducer?: (s: string) => TypeAttributes;
};
const transformedStringTypeTargetTypeKinds = {
  date: { jsonSchema: "date" },
  time: { jsonSchema: "time" },
  "date-time": { jsonSchema: "date-time" },
  uuid: { jsonSchema: "uuid" },
  uri: { jsonSchema: "uri" },
  "integer-string": { jsonSchema: "integer", primitive: "integer" },
  "bool-string": { jsonSchema: "boolean" },
};
export const transformedStringTypeTargetTypeKindsMap = mapFromObject(transformedStringTypeTargetTypeKinds);

export type TransformedStringTypeKind = keyof typeof transformedStringTypeTargetTypeKinds;
export type PrimitiveStringTypeKind = "string" | TransformedStringTypeKind;
export type PrimitiveNonStringTypeKind = "none" | "any" | "null" | "bool" | "integer" | "double";
export type PrimitiveTypeKind = PrimitiveNonStringTypeKind | PrimitiveStringTypeKind;
export type NamedTypeKind = "class" | "enum" | "union";
export type TypeKind = PrimitiveTypeKind | NamedTypeKind | "array" | "object" | "map" | "intersection";
export type ObjectTypeKind = "object" | "map" | "class";

export const transformedStringTypeKinds = new Set(
  Object.getOwnPropertyNames(transformedStringTypeTargetTypeKinds)
) as ReadonlySet<TransformedStringTypeKind>;

export function isPrimitiveStringTypeKind(kind: string): kind is PrimitiveStringTypeKind {
  return kind === "string" || hasOwnProperty(transformedStringTypeTargetTypeKinds, kind);
}

export function targetTypeKindForTransformedStringTypeKind(
  kind: PrimitiveStringTypeKind
): PrimitiveNonStringTypeKind | undefined {
  const target: any = transformedStringTypeTargetTypeKindsMap.get(kind);
  if (!target) return;
  return target.primitive;
}

export function isNumberTypeKind(kind: TypeKind): kind is "integer" | "double" {
  return kind === "integer" || kind === "double";
}

export function isPrimitiveTypeKind(kind: TypeKind): kind is PrimitiveTypeKind {
  if (isPrimitiveStringTypeKind(kind) || isNumberTypeKind(kind)) return true;
  return ["none", "any", "null", "bool"].includes(kind);
}

function trivallyStructurallyCompatible(x: Type, y: Type): boolean {
  if (x.index === y.index || x.kind === "none" || y.kind === "none") return true;
  return false;
}

export class TypeIdentity {
  readonly #hashCode!: number;
  constructor(private readonly kind: TypeKind, private readonly components: ReadonlyArray<any>) {
    let hash = hashCodeInit;
    hash = addHashCode(hash, hashCodeOf(this.kind));
    for (const c of components) {
      hash = addHashCode(hash, hashCodeOf(c));
    }
    this.#hashCode = hash;
  }
  equals(other: any): boolean {
    if (!(other instanceof TypeIdentity)) return false;
    if (this.kind !== other.kind) return false;
    const n = this.components.length;
    assert(n === other.components.length, "Components of a type kind's identity must have the same length");
    for (let i = 0; i < n; i++) {
      if (!areEqual(this.components[i], other.components[i])) return false;
    }
    return true;
  }
  hashCode(): number {
    return this.#hashCode;
  }
}

export type MaybeTypeIdentity = TypeIdentity | undefined;

export abstract class Type {
  constructor(readonly typeRef: any, protected readonly graph: any, readonly kind: TypeKind) {}
  get index(): number {
    return 1;
  }
  abstract getNonAttributeChildren(): Set<Type>;
  getChildren(): ReadonlySet<Type> {
    let ret = this.getNonAttributeChildren();
    for (const [k, v] of this.getAttributes()) {
      if (!k.children) continue;
      setUnionInto(ret, k.children(v));
    }
    return ret;
  }

  getAttributes(): TypeAttributes {
    return attributesForTypeRef(this.typeRef, this.graph);
  }

  get hasNames(): boolean {
    return namesTypeAttributeKind.tryGetInAttributes(this.getAttributes()) !== undefined;
  }
  getNames(): TypeNames {
    return defined(namesTypeAttributeKind.tryGetInAttributes(this.getAttributes()));
  }

  getCombineName(): string {
    return this.getNames().combinedName;
  }

  abstract get isNullable(): boolean;
  abstract isPrimitive(): this is PrimitiveType;
  abstract get identity(): MaybeTypeIdentity;
  abstract reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>, canonialOrder: boolean): void;

  get debugPrintKind(): string {
    return this.kind;
  }
  equals(other: any): boolean {
    if (!(other instanceof Type)) return false;
    return this.typeRef === other.typeRef;
  }
  hashCode(): number {
    return hashCodeOf(this.typeRef);
  }
  protected abstract structuralEqualityStep(
    other: Type,
    conflateNumbers: boolean,
    queue: (a: Type, b: Type) => boolean
  ): boolean;

  kindsCompatible(kind1: TypeKind, kind2: TypeKind, conflateNumbers: boolean): boolean {
    if (kind1 === kind2) return true;
    if (!conflateNumbers) return false;
    if (kind1 === "integer") return kind2 === "double";
    if (kind1 === "double") return kind2 === "integer";
    return false;
  }
  structuallyCompatible(other: Type, conflateNumbers: boolean = false): boolean {
    if (trivallyStructurallyCompatible(this, other)) return true;
    if (!this.kindsCompatible(this.kind, other.kind, conflateNumbers)) return false;
    const workList: [Type, Type][] = [[this, other]];
    const done: [number, number][] = [];
    let failed: boolean;
    const queue = (x: Type, y: Type): boolean => {
      if (trivallyStructurallyCompatible(x, y)) return true;
      if (!this.kindsCompatible(x.kind, y.kind, conflateNumbers)) {
        failed = true;
        return false;
      }
      workList.push([x, y]);
      return true;
    };
    while (workList.length > 0) {
      let [a, b] = defined(workList.pop());
      if (a.index > b.index) [a, b] = [b, a];
      if (!a.isPrimitive()) {
        let ai = a.index,
          bi = b.index,
          found = false;
        for (const [dai, dbi] of done) {
          if (dai === ai && dbi === bi) {
            found = true;
            break;
          }
        }
        if (found) continue;
        done.push([ai, bi]);
      }
      failed = false;
      if (!a.structuralEqualityStep(b, conflateNumbers, queue)) return false;
      if (failed) return false;
    }
    return true;
  }
  getParentTypes(): ReadonlySet<Type> {
    return this.graph;
  }
  getAncestorsNotInSet(set: ReadonlySet<TypeRef>): ReadonlySet<Type> {
    const workList: Type[] = [this];
    const processed = new Set<Type>();
    const ancestors = new Set<Type>();
    while (true) {
      const t = workList.pop();
      if (!t) break;
      const parents = t.getParentTypes();
      console.log(parents.size + "parents");
      for (const parent of parents) {
        if (processed.has(parent)) continue;
        processed.add(parent);
        if (set.has(parent.typeRef)) {
          console.log(`adding ${parent.kind}`);
          workList.push(parent);
        } else {
          console.log(`found ${parent.kind}`);
          ancestors.add(parent);
        }
      }
    }
    return ancestors;
  }
}

function hasUniqueIdentityAttributes(attributes: TypeAttributes): boolean {
  return mapSome(attributes, (v, ta) => ta.requireUniqueIdentity(v));
}

function identityAttributes(attributes: TypeAttributes): TypeAttributes {
  return mapFilter(attributes, (_, kind) => kind.inIndentity);
}

export function primitiveTypeIndentity(kind: PrimitiveTypeKind, attributes: TypeAttributes): MaybeTypeIdentity {
  if (hasUniqueIdentityAttributes(attributes)) return undefined;
  return new TypeIdentity(kind, [identityAttributes(attributes)]);
}

export class PrimitiveType extends Type {
  readonly kind!: PrimitiveTypeKind;
  get isNullable(): boolean {
    return this.kind === "null" || this.kind === "any" || this.kind === "none";
  }
  isPrimitive(): this is PrimitiveType {
    return true;
  }
  getNonAttributeChildren(): Set<Type> {
    return new Set();
  }
  get identity(): MaybeTypeIdentity {
    return primitiveTypeIndentity(this.kind, this.getAttributes());
  }
  reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>): void {
    builder.getPrimitiveType(this.kind);
  }
  protected structuralEqualityStep(
    other: Type,
    conflateNumbers: boolean,
    queue: (a: Type, b: Type) => boolean
  ): boolean {
    return true;
  }
}

export function arrayTypeIdentity(attributes: TypeAttributes, ref: TypeRef): MaybeTypeIdentity {
  if (hasUniqueIdentityAttributes(attributes)) return;
  return new TypeIdentity("array", [identityAttributes(attributes), ref]);
}

export class ArrayType extends Type {
  readonly kind = "array";
  constructor(typeRef: TypeRef, graph: TypeGraph, private ref?: TypeRef) {
    super(typeRef, graph, "array");
  }
  setItems(ref: TypeRef) {
    if (this.ref) return panic("Can only set array items once");
    this.ref = ref;
  }
  private getItemsRef(): TypeRef {
    if (!this.ref) return panic("Array items accessed before they were set");
    return this.ref;
  }
  get items(): Type {
    return derefTypeRef(this.getItemsRef(), this.graph);
  }
  getNonAttributeChildren(): Set<Type> {
    return new Set([this.items]);
  }
  get isNullable(): boolean {
    return false;
  }
  isPrimitive(): this is PrimitiveType {
    return false;
  }
  get identity(): MaybeTypeIdentity {
    return arrayTypeIdentity(this.getAttributes(), this.getItemsRef());
  }
  reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>): void {
    const ref = this.getItemsRef();
    const maybe = builder.lookup(ref);
    if (!maybe) {
    }
  }
  protected structuralEqualityStep(
    other: ArrayType,
    conflateNumbers: boolean,
    queue: (a: Type, b: Type) => boolean
  ): boolean {
    return queue(this.items, other.items);
  }
}

export class GenericClassProperty<T> {
  constructor(readonly typeData: T, readonly isOptional: boolean) {}
  equals(other: any): boolean {
    if (!(other instanceof GenericClassProperty)) return false;
    return areEqual(this.typeData, other.typeData) && this.isOptional === other.isOptional;
  }
  hashCode(): number {
    return hashCodeOf(this.typeData) + (this.isOptional ? 17 : 23);
  }
}

export class ClassProperty extends GenericClassProperty<TypeRef> {
  constructor(ref: TypeRef, readonly graph: TypeGraph, isOptional: boolean) {
    super(ref, isOptional);
  }
  get typeRef(): TypeRef {
    return this.typeData;
  }
  get type(): Type {
    return derefTypeRef(this.typeRef, this.graph);
  }
}

function objectTypeIdentify(
  kind: ObjectTypeKind,
  attributes: TypeAttributes,
  properties: ReadonlyMap<string, ClassProperty>,
  additionnalPropertiesRef: TypeRef | undefined
): MaybeTypeIdentity {
  if (hasUniqueIdentityAttributes(attributes)) return;
  return new TypeIdentity(kind, [identityAttributes(attributes), properties, additionnalPropertiesRef]);
}

export function classTypeIdentity(
  attributes: TypeAttributes,
  properties: ReadonlyMap<string, ClassProperty>
): MaybeTypeIdentity {
  return objectTypeIdentify("class", attributes, properties, undefined);
}

export function mapTypeIdentify(
  attributes: TypeAttributes,
  additionnalPropertiesRef: TypeRef | undefined
): MaybeTypeIdentity {
  return objectTypeIdentify("map", attributes, new Map(), additionnalPropertiesRef);
}

export class ObjectType extends Type {
  readonly kind!: ObjectTypeKind;
  constructor(
    ref: TypeRef,
    graph: TypeGraph,
    kind: ObjectTypeKind,
    readonly isFixed: boolean,
    private properties: ReadonlyMap<string, ClassProperty> | undefined,
    private additionalPropertiesRef: TypeRef | undefined
  ) {
    super(ref, graph, kind);
    if (kind === "map") assert(properties ? properties.size === 0 : !isFixed);
    else if (kind === "class") assert(!additionalPropertiesRef);
    else assert(isFixed);
  }
  setProperties(properties: ReadonlyMap<string, ClassProperty>, additionalPropertiesRef: TypeRef | undefined) {
    assert(!this.properties, "Tried to set object properties twice");
    if (this instanceof Type) assert(!properties.size, "Cannot set properties on map type");
    if (this instanceof Type) assert(!additionalPropertiesRef, "Cannot set additional properties of class type");
    this.properties = properties;
    this.additionalPropertiesRef = additionalPropertiesRef;
  }
  getProperties(): ReadonlyMap<string, ClassProperty> {
    return defined(this.properties);
  }
  getSortedProperties(): ReadonlyMap<string, ClassProperty> {
    return mapSortByKey(this.getProperties());
  }
  private getAdditionalPropertiesRef(): TypeRef | undefined {
    assert(this.properties === undefined, "Properties are not set yet");
    return this.additionalPropertiesRef;
  }
  getAdditionalProperties(): Type | undefined {
    const tref = this.getAdditionalPropertiesRef();
    if (!tref) return;
    return derefTypeRef(tref, this.graph);
  }
  getNonAttributeChildren(): Set<Type> {
    const types = mapSortToArray(this.getProperties(), (_, k) => k).map(([_, p]) => p.type);
    const additionalProperties = this.getAdditionalProperties();
    if (additionalProperties) types.push(additionalProperties);
    return new Set(types);
  }
  get isNullable(): boolean {
    return false;
  }
  isPrimitive(): this is PrimitiveType {
    return false;
  }
  get identity(): MaybeTypeIdentity {
    if (this.isFixed) return;
    return objectTypeIdentify(this.kind, this.getAttributes(), this.getProperties(), this.getAdditionalPropertiesRef());
  }
  reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>, canonialOrder: boolean): void {
    const sortedProperties = this.getSortedProperties();
    const propertiesInNewOrder = canonialOrder ? sortedProperties : this.getProperties();
    const maybePropertyTypes = builder.lookupMap(mapMap(sortedProperties, (cp) => cp.typeRef));
    const maybeAdditionalProperties = definedMap(this.additionalPropertiesRef, (r) => builder.lookup(r));

    if (maybePropertyTypes && (maybeAdditionalProperties || this.additionalPropertiesRef)) {
      const properties = mapMap(propertiesInNewOrder, (cp, n) => builder);
      switch (this.kind) {
        case "object":
          assert(this.isFixed);
          break;
        case "map":
          break;
        case "class":
          break;
        default:
          return panic("Invalid object type kind " + this.kind);
      }
    } else {
      switch (this.kind) {
        case "object":
          assert(this.isFixed);
          break;
        case "map":
          break;
        case "class":
          break;
        default:
          return panic("Invalid object type kind " + this.kind);
      }
      const reconstitutedTypes = mapMap(sortedProperties, (cp) => builder.reconstitute(cp.typeRef));
      const properties = mapMap(propertiesInNewOrder, (cp, n) => builder);
      const additionalProperties = definedMap(this.additionalPropertiesRef, (r) => builder.reconstitute(r));
    }
  }
  protected structuralEqualityStep(other: ObjectType, conflateNumbers: boolean, queue: (a: Type, b: Type) => boolean) {
    const pa = this.getProperties(),
      pb = other.getProperties();
    if (pa.size !== pb.size) return false;
    for (const [name, cpa] of pa) {
      const cpb = pb.get(name);
      if (!cpb || cpa.isOptional !== cpb.isOptional || !queue(cpa.type, cpb.type)) return false;
    }
    const thisAdditionalProperties = this.getAdditionalProperties();
    const otherAdditionalProperties = other.getAdditionalProperties();
    if ((thisAdditionalProperties === undefined) !== (otherAdditionalProperties === undefined)) return false;
    if (!thisAdditionalProperties || !otherAdditionalProperties) return true;
    return queue(thisAdditionalProperties, otherAdditionalProperties);
  }
}

export class ClassType extends ObjectType {
  readonly kind = "class";
  constructor(
    typeRef: TypeRef,
    graph: TypeGraph,
    isFixed: boolean,
    properties: ReadonlyMap<string, ClassProperty> | undefined
  ) {
    super(typeRef, graph, "class", isFixed, properties, undefined);
  }
}

export class MapType extends ObjectType {
  readonly kind = "map";
  constructor(typeRef: TypeRef, graph: TypeGraph, valuesRef: TypeRef | undefined) {
    super(
      typeRef,
      graph,
      "map",
      false,
      definedMap(valuesRef, () => new Map()),
      valuesRef
    );
  }
  get values(): Type {
    return defined(this.getAdditionalProperties());
  }
}

export function enumTypeIdentity(attributes: TypeAttributes, cases: ReadonlySet<string>): MaybeTypeIdentity {
  if (hasUniqueIdentityAttributes(attributes)) return;
  return new TypeIdentity("enum", [identityAttributes(attributes), cases]);
}

export class EnumType extends Type {
  readonly kind = "enum";
  constructor(typeRef: TypeRef, graph: TypeGraph, readonly cases: ReadonlySet<string>) {
    super(typeRef, graph, "enum");
  }
  get isNullable(): boolean {
    return false;
  }
  isPrimitive(): this is PrimitiveType {
    return false;
  }
  get identity(): MaybeTypeIdentity {
    return enumTypeIdentity(this.getAttributes(), this.cases);
  }
  getNonAttributeChildren(): Set<Type> {
    return new Set();
  }
  reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>): void {
    builder.getEnumType(this.cases);
  }
  protected structuralEqualityStep(
    other: EnumType,
    conflateNumbers: boolean,
    queue: (a: Type, b: Type) => void
  ): boolean {
    return areEqual(this.cases, other.cases);
  }
}

export function setOperationCasesEqual(
  typeA: Iterable<Type>,
  typeB: Iterable<Type>,
  conflateNumbers: boolean,
  membersEqual: (a: Type, b: Type) => boolean
): boolean {
  const ma = toReadonlySet(typeA);
  const mb = toReadonlySet(typeB);
  if (ma.size !== mb.size) return false;
  return iterableEvery(ma, (ta) => {
    const tb = iterableFind(mb, (t) => t.kind === ta.kind);
    if (tb && membersEqual(ta, tb)) return true;
    if (conflateNumbers) {
      if (ta.kind === "integer" && iterableSome(mb, (t) => t.kind === "double")) return true;
      if (ta.kind === "double" && iterableSome(mb, (t) => t.kind === "integer")) return true;
    }
    return false;
  });
}

export function setOperationTypeIdentity(
  kind: TypeKind,
  attributes: TypeAttributes,
  memberRefs: ReadonlySet<TypeRef>
): MaybeTypeIdentity {
  if (hasUniqueIdentityAttributes(attributes)) return;
  return new TypeIdentity(kind, [identityAttributes(attributes), memberRefs]);
}

export function uninTypeIdentity(attributes: TypeAttributes, memberRefs: ReadonlySet<TypeRef>): MaybeTypeIdentity {
  return setOperationTypeIdentity("union", attributes, memberRefs);
}

export function intersectionTypeIdentity(
  attributes: TypeAttributes,
  memberRefs: ReadonlySet<TypeRef>
): MaybeTypeIdentity {
  return setOperationTypeIdentity("intersection", attributes, memberRefs);
}

export abstract class SetOperationType extends Type {
  constructor(typeRef: TypeRef, graph: TypeGraph, kind: TypeKind, private memberRefs?: ReadonlySet<TypeRef>) {
    super(typeRef, graph, kind);
  }
  setMembers(memberRefs: ReadonlySet<TypeRef>): void {
    if (this.memberRefs) return panic("Can only set map members once");
    this.memberRefs = memberRefs;
  }
  protected getMemberRefs(): ReadonlySet<TypeRef> {
    if (!this.memberRefs) return panic("Map members accessed before they were set");
    return this.memberRefs;
  }
  get members(): ReadonlySet<Type> {
    return setMap(this.getMemberRefs(), (refs) => derefTypeRef(refs, this.graph));
  }
  get sortedMembers(): ReadonlySet<Type> {
    return this.getNonAttributeChildren();
  }
  getNonAttributeChildren(): Set<Type> {
    return setSortBy(this.members, (t) => t.kind);
  }
  isPrimitive(): this is PrimitiveType {
    return false;
  }
  get identity(): MaybeTypeIdentity {
    return setOperationTypeIdentity(this.kind, this.getAttributes(), this.getMemberRefs());
  }
  protected reconstituteSetOperation<T extends BaseGraphRewriteBuilder>(
    builder: TypeReconstituter<T>,
    canonialOrder: boolean,
    getType: (members: ReadonlySet<TypeRef> | undefined) => void
  ): void {
    const sortedMembersRefs = mapMap(this.sortedMembers.entries(), (t) => t.typeRef);
    const membersInOrder = canonialOrder ? this.sortedMembers : this.members;
    const maybeMembers = builder.lookupMap(sortedMembersRefs);
    if (!maybeMembers) {
      getType(undefined);
      const reconstitued = builder.reconstituteMap(sortedMembersRefs);
      builder.setSetOperationMembers(setMap(membersInOrder, (t) => defined(reconstitued.get(t))));
    } else {
      getType(setMap(membersInOrder, (t) => defined(maybeMembers.get(t))));
    }
  }
  protected structuralEqualityStep(
    other: SetOperationType,
    conflateNumbers: boolean,
    queue: (a: Type, b: Type) => boolean
  ): boolean {
    return setOperationCasesEqual(this.members, other.members, conflateNumbers, queue);
  }
}

export class IntersectionType extends SetOperationType {
  kind!: "intersection";
  constructor(typeRef: TypeRef, graph: TypeGraph, memberRefs?: ReadonlySet<TypeRef>) {
    super(typeRef, graph, "intersection", memberRefs);
  }
  get isNullable(): boolean {
    return panic("isNullable not implemented for IntersectionType");
  }
  reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>, cannoicalOrder: boolean) {
    this.reconstituteSetOperation(builder, cannoicalOrder, (members) => {
      members ? builder.getIntersectionType(members) : builder.getUniqueIntersectionType();
    });
  }
}

export class UnionType extends SetOperationType {
  readonly kind = "union";
  constructor(typeRef: TypeRef, graph: TypeGraph, memberRefs?: ReadonlySet<TypeRef>) {
    super(typeRef, graph, "union", memberRefs);
    if (memberRefs) messageAssert(memberRefs.size > 0, "IRNoEmptyUnions", {});
  }
  setMembers(memberRefs: ReadonlySet<TypeRef>): void {
    messageAssert(memberRefs.size > 0, "IRNoEmptyUnions", {});
    super.setMembers(memberRefs);
  }
  get stringTypeMembers(): ReadonlySet<Type> {
    return setFilter(this.members, (t) => isPrimitiveStringTypeKind(t.kind) || t.kind === "enum");
  }
  findMember(kind: TypeKind): Type | undefined {
    return iterableFind(this.members, (t) => t.kind === kind);
  }
  get isNullable(): boolean {
    return this.findMember("null") !== undefined;
  }
  get isCanonical(): boolean {
    const members = this.members;
    if (members.size <= 1) return false;
    const kinds = setMap(members, (t) => t.kind);
    if (kinds.size < members.size) return false;
    if (kinds.has("union") || kinds.has("intersection")) return false;
    if (kinds.has("none") || kinds.has("any")) return false;
    if (kinds.has("string") || kinds.has("enum")) return false;

    let numObjectTypes = 0;
    if (kinds.has("class")) numObjectTypes++;
    if (kinds.has("map")) numObjectTypes++;
    if (kinds.has("object")) numObjectTypes++;
    if (numObjectTypes > 1) return false;
    return true;
  }
  reconstitute<T extends BaseGraphRewriteBuilder>(builder: TypeReconstituter<T>, canonialOrder: boolean): void {
    this.reconstituteSetOperation(builder, canonialOrder, (members) => {
      members ? builder.getUnionType(members) : builder.getUniqueUnionType();
    });
  }
}
