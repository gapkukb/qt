import {
  areEqual,
  definedMap,
  EqualityMap,
  hashCodeOf,
  iterableEvery,
  mapFilter,
  mapMap,
  mapSortByKey,
  setMap,
  setUnionManyInto,
  withDefault,
} from "collection-utils";
import { StringTypes, stringTypesTypeAttributeKind } from "./attributes/StringTypes";
import {
  combineTypeAttributes,
  emptyTypeAttributes,
  TypeAttributeKind,
  TypeAttributes,
} from "./attributes/TypeAttributes";
import { assert, defined, panic } from "./support";
import {
  MaybeTypeIdentity,
  PrimitiveNonStringTypeKind,
  PrimitiveStringTypeKind,
  PrimitiveType,
  TransformedStringTypeKind,
  transformedStringTypeKinds,
  Type,
  TypeKind,
  IntersectionType,
  TypeIdentity,
  PrimitiveTypeKind,
  isPrimitiveTypeKind,
  primitiveTypeIndentity,
  enumTypeIdentity,
  EnumType,
  ClassProperty,
  ObjectType,
  MapType,
  mapTypeIdentify,
  ArrayType,
  arrayTypeIdentity,
  classTypeIdentity,
  ClassType,
  uninTypeIdentity,
  UnionType,
  intersectionTypeIdentity,
} from "./Type";
import { assertTypeRefGraph, derefTypeRef, makeTypeRef, TypeGraph, TypeRef, typeRefIndex } from "./TypeGraph";

class ProvenanceTypeAttributeKind extends TypeAttributeKind<Set<number>> {
  constructor() {
    super("provenance");
  }
  appliesToTypeKind(kind: TypeKind): boolean {
    return true;
  }
  combine(attrs: Set<number>[]): Set<number> {
    return setUnionManyInto(new Set(), attrs);
  }
  makeInferred(p: Set<number>): Set<number> {
    return p;
  }
  stringify(p: Set<number>): string {
    return Array.from(p)
      .sort()
      .map((i) => i.toString())
      .join(",");
  }
}
export const provenanceTypeAttributeKind: TypeAttributeKind<Set<number>> = new ProvenanceTypeAttributeKind();
export type StringTypeMapping = ReadonlyMap<TransformedStringTypeKind, PrimitiveStringTypeKind>;
export function stringTypeMappingGet(stm: StringTypeMapping, kind: TransformedStringTypeKind): PrimitiveStringTypeKind {
  const mapped = stm.get(kind);
  if (!mapped) return "string" as any;
  return mapped as any;
}
let noStringTypeMapping: StringTypeMapping | undefined;

export function getNonStringTypeMapping(): StringTypeMapping {
  if (!noStringTypeMapping) noStringTypeMapping = new Map(Array.from(transformedStringTypeKinds).map((k) => [k, k]));
  return noStringTypeMapping;
}
export class TypeBuilder {
  readonly typeGraph!: TypeGraph;
  protected readonly topLevels: Map<string, TypeRef> = new Map();
  protected readonly types: (Type | undefined)[] = [];
  readonly #typeAttributes: TypeAttributes[] = [];
  #addedForwardingIntersection: boolean = false;
  constructor(
    typeGraphSerial: number,
    private readonly stringTypeMapping: StringTypeMapping,
    readonly cannonicalOrder: boolean,
    private readonly allPropertiesOptional: boolean,
    private readonly addProvenanceAttributes: boolean,
    inheritsProvevanceAttributes: boolean
  ) {
    assert(
      !addProvenanceAttributes || !inheritsProvevanceAttributes,
      "We cannot both inherit as well as add provenance"
    );
    this.typeGraph = new TypeGraph(this, typeGraphSerial, addProvenanceAttributes || inheritsProvevanceAttributes);
  }

  addTopLevel(name: string, ref: TypeRef): void {
    assert(!this.topLevels.has(name), "Trying to add top-level with existing name");
    assert(this.types[typeRefIndex(ref)] !== undefined, "Trying to add a top-level type that doesn't exist(yet?)");
    this.topLevels.set(name, ref);
  }

  reserveTypeRef(): TypeRef {
    const index = this.types.length;
    this.types.push(undefined);
    const ref = makeTypeRef(this.typeGraph, index);
    const attributes: TypeAttributes = this.addProvenanceAttributes
      ? provenanceTypeAttributeKind.makeAttributes(new Set([index]))
      : emptyTypeAttributes;
    this.#typeAttributes.push(attributes);
    return ref;
  }
  private assertTypeRefGraph(ref?: TypeRef): void {
    if (!ref) return;
    assertTypeRefGraph(ref, this.typeGraph);
  }
  private assertTypeRefSetGraph(refs?: ReadonlySet<TypeRef>): void {
    if (!refs) return;
    refs.forEach((ref) => this.assertTypeRefGraph(ref));
  }
  private filterTypeAttributes(t: Type, attributes: TypeAttributes): TypeAttributes {
    const filtered = mapFilter(attributes, (_, k) => k.appliesToTypeKind(t.kind));
    if (attributes.size !== filtered.size) this.setLostTypeAttributes();
    return filtered;
  }
  private commitType(ref: TypeRef, t: Type): void {
    this.assertTypeRefGraph(ref);
    const index = typeRefIndex(ref);
    assert(this.types[index] === undefined, "A type index was commited twice");
    this.types[index] = t;
    this.#typeAttributes[index] = this.filterTypeAttributes(t, this.#typeAttributes[index]);
  }
  protected addType<T extends Type>(
    forwardingRef: TypeRef | undefined,
    creator: (ref: TypeRef) => T,
    attributes: TypeAttributes | undefined
  ): TypeRef {
    if (forwardingRef) {
      this.assertTypeRefGraph(forwardingRef);
      assert(!this.types[typeRefIndex(forwardingRef)]);
    }
    const ref = forwardingRef ? forwardingRef : this.reserveTypeRef();
    if (attributes) {
      const index = typeRefIndex(ref);
      this.#typeAttributes[index] = combineTypeAttributes("union", this.#typeAttributes[index], attributes);
    }
    const t = creator(ref);
    this.commitType(ref, t);
    return ref;
  }
  typeAtIndex(index: number): Type {
    const maybeType = this.types[index];
    if (!maybeType) return panic("Trying to deref an undefined type in a type builder");
    return maybeType;
  }
  atIndex(index: number): [Type, TypeAttributes] {
    const t = this.typeAtIndex(index),
      attrs = this.#typeAttributes[index];
    return [t, attrs];
  }
  addAttributes(ref: TypeRef, attributes: TypeAttributes): void {
    this.assertTypeRefGraph(ref);
    const index = typeRefIndex(ref);
    const existingAttributes = this.#typeAttributes[index];
    assert(
      iterableEvery(attributes, ([k, v]) => {
        if (!k.inIndentity) return true;
        const existing = existingAttributes.get(k);
        if (!existing) return false;
        return areEqual(existing, v);
      }),
      "Can't add different identity type attributes to an existing type"
    );
    const maybe = this.types[index];
    if (maybe) attributes = this.filterTypeAttributes(maybe, attributes);
    const nonIndentityAttributes = mapFilter(attributes, (_, k) => !k.inIndentity);
    this.#typeAttributes[index] = combineTypeAttributes("union", existingAttributes, nonIndentityAttributes);
  }
  finish(): TypeGraph {
    this.typeGraph.freeze(this.topLevels, this.types.map(defined), this.#typeAttributes);
    return this.typeGraph;
  }
  protected addForwardingIntersection(forwardingRef: TypeRef, ref: TypeRef): TypeRef {
    this.assertTypeRefGraph(ref);
    this.#addedForwardingIntersection = true;
    return this.addType(forwardingRef, (tr) => new IntersectionType(tr, this.typeGraph, new Set([ref])), undefined);
  }
  protected forwardIfNecessary(forwardRef: TypeRef | undefined, ref: undefined): undefined;
  protected forwardIfNecessary(forwardRef: TypeRef | undefined, ref: TypeRef): TypeRef;
  protected forwardIfNecessary(forwardRef: TypeRef | undefined, ref: undefined | TypeRef): undefined | TypeRef;
  protected forwardIfNecessary(forwardRef: TypeRef | undefined, ref: undefined | TypeRef): undefined | TypeRef {
    if (!ref) return undefined;
    if (!forwardRef) return ref;
    return this.addForwardingIntersection(forwardRef, ref);
  }
  get didAddForwardingIntersection(): boolean {
    return this.#addedForwardingIntersection;
  }
  readonly #typeForIdentity: EqualityMap<TypeIdentity, TypeRef> = new EqualityMap();
  private registerTypeForIdentity(identity: MaybeTypeIdentity, ref: TypeRef): void {
    if (!identity) return;
    this.#typeForIdentity.set(identity, ref);
  }
  protected makeIdentity(maker: () => MaybeTypeIdentity): MaybeTypeIdentity {
    return maker();
  }
  private getOrAddType(
    identityMaker: () => MaybeTypeIdentity,
    creator: (tr: TypeRef) => Type,
    attributes: TypeAttributes | undefined,
    forwardingRef: TypeRef | undefined
  ): TypeRef {
    const identity = this.makeIdentity(identityMaker);
    let maybe: TypeRef | undefined;
    if (!identity) maybe = undefined;
    else maybe = this.#typeForIdentity.get(identity);
    if (maybe) {
      let ret = this.forwardIfNecessary(forwardingRef, maybe);
      if (attributes)
        this.addAttributes(
          ret,
          mapFilter(attributes, (_, k) => !k.inIndentity)
        );
      return ret;
    }
    const ref = this.addType(forwardingRef, creator, attributes);
    this.registerTypeForIdentity(identity, ref);
    return ref;
  }
  private registerType(t: Type): void {
    this.registerTypeForIdentity(t.identity, t.typeRef);
  }
  getPrimitiveType(kind: PrimitiveTypeKind, maybeAttributes?: TypeAttributes, ref?: TypeRef): TypeRef {
    const attributes = withDefault(maybeAttributes, emptyTypeAttributes);
    let strintTypes = kind === "string" ? undefined : StringTypes.unrestricted;
    if (isPrimitiveTypeKind(kind) && kind !== "string") {
      kind = stringTypeMappingGet(this.stringTypeMapping, kind as any);
    }
    if (kind === "string") return this.getStringType(attributes, strintTypes, ref);
    return this.getOrAddType(
      () => primitiveTypeIndentity(kind, attributes),
      (tr) => new PrimitiveType(tr, this.typeGraph, kind),
      attributes,
      ref
    );
  }
  getStringType(attributes: TypeAttributes, stringTypes?: StringTypes, ref?: TypeRef): TypeRef {
    const exist = mapFilter(attributes, (_, k) => k === stringTypesTypeAttributeKind);
    assert(!stringTypes !== !exist, "Must instantiate string type with one enum case attribute");
    if (!exist) {
      attributes = combineTypeAttributes(
        "union",
        attributes,
        stringTypesTypeAttributeKind.makeAttributes(defined(stringTypes))
      );
    }
    return this.getOrAddType(
      () => primitiveTypeIndentity("string", attributes),
      (tr) => new PrimitiveType(tr, this.typeGraph, "string"),
      attributes,
      ref
    );
  }
  getEnumType(attributes: TypeAttributes, cases: ReadonlySet<string>, ref?: TypeRef): TypeRef {
    return this.getOrAddType(
      () => enumTypeIdentity(attributes, cases),
      (tr) => new EnumType(tr, this.typeGraph, cases),
      attributes,
      ref
    );
  }
  makeClassProperty(ref: TypeRef, isOptional: boolean): ClassProperty {
    return new ClassProperty(ref, this.typeGraph, isOptional);
  }
  getUniqueObjectType(
    attributes: TypeAttributes,
    properties: ReadonlyMap<string, ClassProperty> | undefined,
    additionalProperties: TypeRef | undefined,
    ref?: TypeRef
  ): TypeRef {
    this.assertTypeRefGraph(additionalProperties);
    //TODO:
    properties = definedMap(properties, (p) => this as any);
    return this.addType(
      ref,
      (tref) => new ObjectType(tref, this.typeGraph, "object", true, properties, additionalProperties),
      undefined
    );
  }
  getUniqueMapType(ref?: TypeRef): TypeRef {
    return this.addType(ref, (tr) => new MapType(tr, this.typeGraph, undefined), undefined);
  }
  getMapType(attributes: TypeAttributes, values: TypeRef, ref?: TypeRef): TypeRef {
    this.assertTypeRefGraph(values);
    return this.getOrAddType(
      () => mapTypeIdentify(attributes, values),
      (tr) => new MapType(tr, this.typeGraph, values),
      attributes,
      ref
    );
  }
  setObjectProperties(
    ref: TypeRef,
    properties: ReadonlyMap<string, ClassProperty>,
    additionalProperties: TypeRef | undefined
  ) {
    this.assertTypeRefGraph(additionalProperties);
    const type = derefTypeRef(ref, this.typeGraph);
    if (!(type instanceof ObjectType)) return panic("Tried to set properties of non-object type");
    //TODO:
    // type.setProperties(, additionalPropertiesRef)
  }
  getUniqueArrayType(ref?: TypeRef): TypeRef {
    return this.addType(ref, (tr) => new ArrayType(tr, this.typeGraph, undefined), undefined);
  }
  getArrayType(attributes: TypeAttributes, items: TypeRef, ref?: TypeRef): TypeRef {
    this.assertTypeRefGraph(items);
    return this.getOrAddType(
      () => arrayTypeIdentity(attributes, items),
      (tr) => new ArrayType(tr, this.typeGraph, items),
      attributes,
      ref
    );
  }
  setArrayItem(ref: TypeRef, items: TypeRef): void {
    this.assertTypeRefGraph(items);
    const type = derefTypeRef(ref, this.typeGraph);
    if (!(type instanceof ArrayType)) return panic("Tried to set items of non-array type");
    type.setItems(items);
    this.registerType(type);
  }
  modifyPropertiesIfNecessary(properties: ReadonlyMap<string, ClassProperty>): ReadonlyMap<string, ClassProperty> {
    properties.forEach((p) => this.assertTypeRefGraph(p.typeRef));
    if (this.cannonicalOrder) properties = mapSortByKey(properties);
    if (this.allPropertiesOptional) properties = mapMap(properties, (cp) => this.makeClassProperty(cp.typeRef, true));
    return properties;
  }
  getClassType(attributes: TypeAttributes, properties: ReadonlyMap<string, ClassProperty>, ref?: TypeRef): TypeRef {
    properties = this.modifyPropertiesIfNecessary(properties);
    return this.getOrAddType(
      () => classTypeIdentity(attributes, properties),
      (tr) => new ClassType(tr, this.typeGraph, false, properties),
      attributes,
      ref
    );
  }
  getUniqueClassType(
    attributes: TypeAttributes,
    isFixed: boolean,
    properties: ReadonlyMap<string, ClassProperty> | undefined,
    ref?: TypeRef
  ): TypeRef {
    properties = definedMap(properties, (p) => this.modifyPropertiesIfNecessary(p));
    return this.addType(ref, (tref) => new ClassType(tref, this.typeGraph, isFixed, properties), attributes);
  }
  getUnionType(attributes: TypeAttributes, members: ReadonlySet<TypeRef>, ref?: TypeRef): TypeRef {
    this.assertTypeRefSetGraph(members);
    return this.getOrAddType(
      () => uninTypeIdentity(attributes, members),
      (tr) => new UnionType(tr, this.typeGraph, members),
      attributes,
      ref
    );
  }
  getUniqueUnionType(attributes: TypeAttributes, members: ReadonlySet<TypeRef> | undefined, ref?: TypeRef): TypeRef {
    this.assertTypeRefSetGraph(members);
    return this.addType(ref, (tref) => new UnionType(tref, this.typeGraph, members), attributes);
  }
  getIntersectionType(attributes: TypeAttributes, members: ReadonlySet<TypeRef>, ref?: TypeRef): TypeRef {
    this.assertTypeRefSetGraph(members);
    return this.getOrAddType(
      () => intersectionTypeIdentity(attributes, members),
      (tr) => new IntersectionType(tr, this.typeGraph, members),
      attributes,
      ref
    );
  }
  getUniqueIntersectionType(
    attributes: TypeAttributes,
    members: ReadonlySet<TypeRef> | undefined,
    ref?: TypeRef
  ): TypeRef {
    this.assertTypeRefSetGraph(members);
    return this.addType(ref, (tref) => new IntersectionType(tref, this.typeGraph, members), attributes);
  }
  setSetOperationMembers(ref: TypeRef, members: ReadonlySet<TypeRef>): void {
    this.assertTypeRefSetGraph(members);
    const type = derefTypeRef(ref, this.typeGraph);
    if (!(type instanceof UnionType || type instanceof IntersectionType))
      return panic("Tried to set members of non-set-operation type");

    type.setMembers(members);
    this.registerType(type);
  }
  setLostTypeAttributes() {
    return;
  }
}
