import { EqualityMap, mapMap } from "collection-utils";
import {
  combineTypeAttributes,
  emptyTypeAttributes,
  TypeAttributeKind,
  TypeAttributes,
} from "./attributes/TypeAttributes";
import { assert, indentationString, panic } from "./support";
import { ClassProperty, MaybeTypeIdentity, PrimitiveTypeKind, Type } from "./Type";
import { StringTypeMapping, TypeBuilder } from "./TypeBuilder";
import {
  assertTypeRefGraph,
  derefTypeRef,
  isTypeRef,
  typeAndAttributesForTypeRef,
  TypeGraph,
  TypeRef,
  typeRefIndex,
} from "./TypeGraph";
import { combineTypeAttributesOfTypes } from "./TypeUtils";

export interface TypeLookerUp {
  lookupTypeRefs(typeRefs: TypeRef[], forwardingRef?: TypeRef): TypeRef | undefined;
  reconstituteTypeRef(typeRef: TypeRef, attributes?: TypeAttributes, forwardingRef?: TypeRef): TypeRef;
}

export class TypeReconstituter<TBuilder extends BaseGraphRewriteBuilder> {
  #wasUsed: boolean = false;
  #typeRef?: TypeRef;
  constructor(
    private readonly typeBuilder: TBuilder,
    private readonly makeClassUnique: boolean,
    private readonly typeAttributes: TypeAttributes,
    private readonly forwardingRef: TypeRef | undefined,
    private readonly _register: (ref: TypeRef) => void
  ) {}
  private builderForNewType(): TBuilder {
    assert(!this.#wasUsed, "TypeReconstituter used more than once");
    this.#wasUsed = true;
    return this.typeBuilder;
  }
  private builderForSetting(): TBuilder {
    assert(this.#wasUsed && this.#typeRef !== undefined, "Cannot set type members before construction a type");
    return this.typeBuilder;
  }
  getResult(): TypeRef {
    if (!this.#typeRef) return panic("Type was not reconstituted");
    return this.#typeRef;
  }
  private register(ref: TypeRef): void {
    assert(this.#typeRef === undefined, "Cannot register a type twice");
    this.#typeRef = ref;
    this._register(ref);
  }
  private registerAndAddAttributes(ref: TypeRef): void {
    this.typeBuilder.addAttributes(ref, this.typeAttributes);
    this.register(ref);
  }
  lookup(ref: TypeRef): TypeRef | undefined;
  lookup(refs: Iterable<TypeRef>): ReadonlyArray<TypeRef> | undefined;
  lookup(refs: TypeRef | Iterable<TypeRef>): ReadonlyArray<TypeRef> | TypeRef | undefined {
    assert(!this.#wasUsed, "Cannot loopup constituents after building type");
    if (isTypeRef(refs)) return this.typeBuilder.lookupTypeRefs([refs], undefined, false);
    const maybes = Array.from(refs).map((r) => this.typeBuilder.lookupTypeRefs([r], undefined, false));
    if (maybes.some((r) => !r)) return;
    return maybes as ReadonlyArray<TypeRef>;
  }
  lookupMap<K>(refs: ReadonlyMap<K, TypeRef>): ReadonlyMap<K, TypeRef> | undefined {
    const ret = this.lookup(refs.values());
    if (!ret) return;
    assert(ret.length === refs.size, "Didn't get back the correct number of types");
    const res = new Map<K, TypeRef>();
    let i = 0;
    for (const k of refs.keys()) {
      res.set(k, ret[i]);
      i++;
    }
    return res;
  }
  reconstitute(ref: TypeRef): TypeRef;
  reconstitute(refs: Iterable<TypeRef>): ReadonlyArray<TypeRef>;
  reconstitute(refs: TypeRef | Iterable<TypeRef>): TypeRef | ReadonlyArray<TypeRef> {
    assert(this.#wasUsed, "Cannot reconstitute constituents before building type");
    if (isTypeRef(refs)) return this.typeBuilder.reconstituteTypeRef(refs);
    return Array.from(refs).map((r) => this.typeBuilder.reconstituteTypeRef(r));
  }
  reconstituteMap<K>(refs: ReadonlyMap<K, TypeRef>): ReadonlyMap<K, TypeRef> {
    return mapMap(refs, (ref) => this.typeBuilder.reconstituteTypeRef(ref));
  }
  getPrimitiveType(kind: PrimitiveTypeKind): void {
    this.register(this.builderForNewType().getPrimitiveType(kind, this.typeAttributes, this.forwardingRef));
  }
  getEnumType(cases: ReadonlySet<string>): void {
    this.register(this.builderForNewType().getEnumType(this.typeAttributes, cases, this.forwardingRef));
  }
  getUniqueMapType(): void {
    this.registerAndAddAttributes(this.builderForNewType().getUniqueMapType(this.forwardingRef));
  }
  getMapType(values: TypeRef): void {
    this.register(this.builderForNewType().getMapType(this.typeAttributes, values, this.forwardingRef));
  }
  getUniqueArrayType(): void {
    this.registerAndAddAttributes(this.builderForNewType().getUniqueArrayType(this.forwardingRef));
  }
  getArrayType(items: TypeRef): void {
    this.register(this.builderForNewType().getArrayType(this.typeAttributes, items, this.forwardingRef));
  }
  setArrayItems(items: TypeRef): void {
    this.builderForSetting().setArrayItem(this.getResult(), items);
  }
  makeClassProperty(ref: TypeRef, isOptional: boolean): ClassProperty {
    return this.typeBuilder.makeClassProperty(ref, isOptional);
  }
  getObjectType(properties: ReadonlyMap<string, ClassProperty>, additionalProperties: TypeRef | undefined): void {
    this.register(
      this.builderForNewType().getUniqueObjectType(
        this.typeAttributes,
        properties,
        additionalProperties,
        this.forwardingRef
      )
    );
  }
  getUniqueObjectType(
    properties: ReadonlyMap<string, ClassProperty> | undefined,
    additionalProperties: TypeRef | undefined
  ): void {
    this.register(
      this.builderForNewType().getUniqueObjectType(
        this.typeAttributes,
        properties,
        additionalProperties,
        this.forwardingRef
      )
    );
  }
  getClassType(properties: ReadonlyMap<string, ClassProperty>): void {
    if (this.makeClassUnique) return this.getUniqueClassType(false, properties);
  }
  getUniqueClassType(isFixed: boolean, properties: ReadonlyMap<string, ClassProperty> | undefined): void {
    this.register(
      this.builderForNewType().getUniqueClassType(this.typeAttributes, isFixed, properties, this.forwardingRef)
    );
  }
  setObjectProperties(properties: ReadonlyMap<string, ClassProperty>, additionalProperties: TypeRef | undefined): void {
    this.builderForSetting().setObjectProperties(this.getResult(), properties, additionalProperties);
  }
  getUnionType(members: ReadonlySet<TypeRef>): void {
    this.register(this.builderForNewType().getUnionType(this.typeAttributes, members, this.forwardingRef));
  }
  getUniqueUnionType(): void {
    this.register(this.builderForNewType().getUniqueUnionType(this.typeAttributes, undefined, this.forwardingRef));
  }
  getIntersectionType(members: ReadonlySet<TypeRef>): void {
    this.register(this.builderForNewType().getIntersectionType(this.typeAttributes, members, this.forwardingRef));
  }
  getUniqueIntersectionType(members?: ReadonlySet<TypeRef>): void {
    this.register(this.builderForNewType().getUniqueIntersectionType(this.typeAttributes, members, this.forwardingRef));
  }
  setSetOperationMembers(members: ReadonlySet<TypeRef>): void {
    this.builderForSetting().setSetOperationMembers(this.getResult(), members);
  }
}

export abstract class BaseGraphRewriteBuilder extends TypeBuilder implements TypeLookerUp {
  protected readonly reconstitutedTypes: Map<number, TypeRef> = new Map();
  #lostTypeAttributes: boolean = false;
  #printIndent = 0;
  constructor(
    readonly originalGraph: TypeGraph,
    stringTypeMapping: StringTypeMapping,
    alphabetizeProperties: boolean,
    graphHasProvenanceAttribute: boolean,
    protected readonly debugPrint: boolean
  ) {
    super(
      originalGraph.serial + 1,
      stringTypeMapping,
      alphabetizeProperties,
      false,
      false,
      graphHasProvenanceAttribute
    );
  }
  withForwardingRef(maybe: TypeRef | undefined, typeCreator: (forwardingRef: TypeRef) => TypeRef): TypeRef {
    if (maybe) return typeCreator(maybe);
    const forwardingRef = this.reserveTypeRef();
    const actualRef = typeCreator(forwardingRef);
    assert(actualRef === forwardingRef, "Type creator didn't return its forwarding ref");
    return actualRef;
  }
  reconstituteType(t: Type, attributes?: TypeAttributes, forwardingRef?: TypeRef): TypeRef {
    return this.reconstituteTypeRef(t.typeRef, attributes, forwardingRef);
  }
  abstract lookupTypeRefs(typeRefs: TypeRef[], forwardingRef?: TypeRef, replaceSet?: boolean): TypeRef | undefined;
  protected abstract forceReconstituteTypeRef(
    originalRef: TypeRef,
    attributes?: TypeAttributes,
    maybe?: TypeRef
  ): TypeRef;

  reconstituteTypeRef(originalRef: TypeRef, attributes?: TypeAttributes, maybe?: TypeRef): TypeRef {
    const maybeRef = this.lookupTypeRefs([originalRef], maybe);
    if (maybeRef) {
      if (attributes) this.addAttributes(maybeRef, attributes);
      return maybeRef;
    }
    return this.forceReconstituteTypeRef(originalRef, attributes, maybe);
  }
  reconstituteTypeAttributes(attributes: TypeAttributes): TypeAttributes {
    return mapMap(attributes, (v, a) => a.reconstitute(this, v));
  }

  protected assertTypeRefsToReconstitute(typerefs: TypeRef[], forwardingRef?: TypeRef): void {
    assert(typerefs.length > 0, "Must have at leaset one type to reconstitute");
    for (const ref of typerefs) {
      assertTypeRefGraph(ref, this.originalGraph);
    }
    if (forwardingRef) assertTypeRefGraph(forwardingRef, this.typeGraph);
  }
  protected changeDebugPrintIndent(delta: number): void {
    this.#printIndent += delta;
  }
  protected get debugPrintIndentation(): string {
    return indentationString(this.#printIndent);
  }
  finish(): TypeGraph {
    for (const [name, t] of this.originalGraph.topLevels) {
      this.addTopLevel(name, this.reconstituteType(t));
    }
    return super.finish();
  }
  setLostTypeAttributes(): void {
    this.#lostTypeAttributes = true;
  }
  get lostTypeAttributes(): boolean {
    return this.#lostTypeAttributes;
  }
}

export class GraphRemapBuilder extends BaseGraphRewriteBuilder {
  readonly #attributeSources: Map<Type, Type[]> = new Map();
  constructor(
    originalGraph: TypeGraph,
    stringTypeMapping: StringTypeMapping,
    alphabetizeProperties: boolean,
    graphHasProvevanceAttributes: boolean,
    private readonly map: ReadonlyMap<Type, Type>,
    debugPrintRemapping: boolean
  ) {
    super(originalGraph, stringTypeMapping, alphabetizeProperties, graphHasProvevanceAttributes, debugPrintRemapping);
    for (const [source, target] of map) {
      let maybe = this.#attributeSources.get(target);
      if (!maybe) {
        maybe = [target];
        this.#attributeSources.set(target, maybe);
      }
      maybe.push(source);
    }
  }
  protected makeIdentity(maker: () => MaybeTypeIdentity): MaybeTypeIdentity {
    return undefined;
  }
  private getMapTarget(ref: TypeRef): TypeRef {
    const maybe = this.map.get(derefTypeRef(ref, this.originalGraph));
    if (!maybe) return ref;
    assert(!this.map.get(maybe), "We have a type that's remapped to a remapped type");
    return maybe.typeRef;
  }
  protected addForwardingIntersection(forwardingRef: TypeRef, ref: TypeRef): TypeRef {
    return panic("We can't add forwarding instersections when when we're remoing forwarding intersections");
  }
  lookupTypeRefs(typeRefs: TypeRef[], forwardingRef?: TypeRef): TypeRef | undefined {
    assert(!forwardingRef, "We can't have a forwarding ref when we remap");
    this.assertTypeRefsToReconstitute(typeRefs, forwardingRef);
    const first = this.reconstitutedTypes.get(typeRefIndex(this.getMapTarget(typeRefs[0])));
    if (!first) return;
    for (let i = 1; i < typeRefs.length; i++) {
      const other = this.reconstitutedTypes.get(typeRefIndex(this.getMapTarget(typeRefs[i])));
      if (first !== other) return;
    }
    return first;
  }
  protected forceReconstituteTypeRef(originalRef: TypeRef, attributes?: TypeAttributes, maybe?: TypeRef): TypeRef {
    originalRef = this.getMapTarget(originalRef);
    const index = typeRefIndex(originalRef);
    assert(!this.reconstitutedTypes.get(index), "Type has already been recontituted");
    assert(!maybe, "We can't have a forwarding ref when we remap");
    return this.withForwardingRef(undefined, (ref) => {
      this.reconstitutedTypes.set(index, ref);
      if (this.debugPrint) {
        console.log(`${this.debugPrintIndentation} reconstituting ${index} as ${typeRefIndex(ref)}`);
        this.changeDebugPrintIndent(1);
      }
      const [originalType, originalAttributes] = typeAndAttributesForTypeRef(ref, this.originalGraph);
      const attributeSources = this.#attributeSources.get(originalType);
      attributes = combineTypeAttributes(
        "union",
        attributes || emptyTypeAttributes,
        attributeSources
          ? this.reconstituteTypeAttributes(originalAttributes)
          : this.reconstituteTypeAttributes(combineTypeAttributesOfTypes("union", attributeSources!))
      );
      const newAttributes = attributes;
      const reconstituter = new TypeReconstituter(this, this.cannonicalOrder, newAttributes, ref, (r) => {
        assert(r === ref, "Reconstituted type as a different ref");
        if (this.debugPrint) {
          this.changeDebugPrintIndent(-1);
          console.log(`${this.debugPrintIndentation} reconstituted ${index} as ${typeRefIndex(r)}`);
        }
      });
      originalType.reconstitute(reconstituter, this.cannonicalOrder);
      return reconstituter.getResult();
    });
  }
}

export class GraphRewriteBuilder<T extends Type> extends BaseGraphRewriteBuilder {
  readonly #setsToReplaceByMember: Map<number, Set<T>> = new Map();
  readonly #reconstituedUnions: EqualityMap<Set<TypeRef>, TypeRef> = new EqualityMap();
  constructor(
    originalGraph: TypeGraph,
    stringTypeMapping: StringTypeMapping,
    alphabetizeProperties: boolean,
    graphHasProvenanceAttributes: boolean,
    setsToReplace: T[][],
    debugPrintReconstitution: boolean,
    private readonly replacer: (
      typesToReplace: ReadonlySet<T>,
      builder: GraphRewriteBuilder<T>,
      ref: TypeRef
    ) => TypeRef
  ) {
    super(
      originalGraph,
      stringTypeMapping,
      alphabetizeProperties,
      graphHasProvenanceAttributes,
      debugPrintReconstitution
    );
    for (const types of setsToReplace) {
      const set = new Set(types);
      for (const t of set) {
        const i = t.index;
        assert(!this.#setsToReplaceByMember.has(i), "A type is member of more than one set to be replacer");
        this.#setsToReplaceByMember.set(i, set);
      }
    }
  }
  registerUnion(typeRefs: TypeRef[], reconstituted: TypeRef): void {
    const set = new Set(typeRefs);
    assert(!this.#reconstituedUnions.has(set), "Cannot register reconsituted set twice");
    this.#reconstituedUnions.set(set, reconstituted);
  }
  private replaceSet(typeToReplace: ReadonlySet<T>, maybe: TypeRef | undefined): TypeRef {
    return this.withForwardingRef(maybe, (ref) => {
      if (this.debugPrint) {
        console.log(
          `${this.debugPrintIndentation} replaceing set ${Array.from(typeToReplace)
            .map((t) => t.index.toString())
            .join(",")} as ${typeRefIndex(ref)}`
        );
        this.changeDebugPrintIndent(1);
      }
      for (const t of typeToReplace) {
        const originalRef = t.typeRef;
        const index = typeRefIndex(originalRef);
        this.reconstitutedTypes.set(index, ref);
        this.#setsToReplaceByMember.delete(index);
      }
      const ret = this.replacer(typeToReplace, this, ref);
      assert(ret === ref, "The forwarding ref got lost when replacing");
      if (this.debugPrint) {
        this.changeDebugPrintIndent(-1);
        console.log(
          `${this.debugPrintIndentation} replaced set ${Array.from(typeToReplace)
            .map((t) => t.index.toString())
            .join(",")} as ${typeRefIndex(ref)}`
        );
      }
      return ret;
    });
  }

  protected forceReconstituteTypeRef(originalRef: TypeRef, attributes?: TypeAttributes, maybe?: TypeRef): TypeRef {
    const [originalType, originalAttributes] = typeAndAttributesForTypeRef(originalRef, this.originalGraph);
    const index = typeRefIndex(originalRef);
    if (this.debugPrint) {
      console.log(`${this.debugPrintIndentation} reconstitution ${index}`);
      this.changeDebugPrintIndent(1);
    }
    if (!attributes) {
      attributes = this.reconstituteTypeAttributes(originalAttributes);
    } else {
      attributes = combineTypeAttributes("union", attributes, this.reconstituteTypeAttributes(originalAttributes));
    }
    const reconstituter = new TypeReconstituter(this, this.cannonicalOrder, attributes, maybe, (ref) => {
      if (this.debugPrint) {
        this.changeDebugPrintIndent(-1);
        console.log(`${this.debugPrintIndentation} reconstituted ${index} as ${typeRefIndex(ref)}`);
      }
      if (maybe) assert(ref === maybe, "We didn't pass the forwarding ref");
      const alreadyReconstitutedType = this.reconstitutedTypes.get(index);
      if (!alreadyReconstitutedType) {
        this.reconstitutedTypes.set(index, ref);
      } else {
        assert(ref == alreadyReconstitutedType, "We reconstituted a type twice differently");
      }
    });
    originalType.reconstitute(reconstituter, this.cannonicalOrder);
    return reconstituter.getResult();
  }
  lookupTypeRefs(typeRefs: TypeRef[], ref?: TypeRef, replaceSet: boolean = true): TypeRef | undefined {
    this.assertTypeRefsToReconstitute(typeRefs, ref);
    let maybe = this.reconstitutedTypes.get(typeRefIndex(typeRefs[0]));
    if (maybe && maybe !== ref) {
      let allEqual = true;
      for (let i = 0; i < typeRefs.length; i++) {
        if (this.reconstitutedTypes.get(typeRefIndex(typeRefs[i])) !== maybe) {
          allEqual = false;
          break;
        }
      }
      if (allEqual) return this.forwardIfNecessary(ref, maybe);
    }
    maybe = this.#reconstituedUnions.get(new Set(typeRefs));
    if (maybe && maybe !== ref) return this.forwardIfNecessary(ref, maybe);
    const maybeSet = this.#setsToReplaceByMember.get(typeRefIndex(typeRefs[0]));
    if (!maybeSet) return;
    for (let i = 1; i < typeRefs.length; i++) {
      if (this.#setsToReplaceByMember.get(typeRefIndex(typeRefs[i])) !== maybeSet) return;
    }
    if (!replaceSet) return;
    return this.replaceSet(maybeSet, ref);
  }
}
