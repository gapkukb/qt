import {
  iterableEvery,
  iterableFind,
  iterableFirst,
  mapMap,
  mapMapEntries,
  mapMergeWithInto,
  mapUpdateInto,
  setFilter,
  setIntersect,
  setMap,
  setUnionInto,
} from "collection-utils";
import { build } from "urijs";
import {
  combineTypeAttributes,
  emptyTypeAttributes,
  makeTypeAttributesInferred,
  TypeAttributes,
} from "../attributes/TypeAttributes";
import { GraphRewriteBuilder, TypeLookerUp } from "../GraphRewriting";
import { assert, defined, mustNotHappen, panic } from "../support";
import {
  ArrayType,
  GenericClassProperty,
  IntersectionType,
  isNumberTypeKind,
  isPrimitiveTypeKind,
  ObjectType,
  PrimitiveTypeKind,
  Type,
  TypeKind,
  UnionType,
} from "../Type";
import { StringTypeMapping, TypeBuilder } from "../TypeBuilder";
import { TypeGraph, TypeRef } from "../TypeGraph";
import { makeGroupToFlatten, matchTypeExhaustive, setOperationMembersRecursively } from "../TypeUtils";
import { TypeAttributeMap, UnionBuilder } from "../UnionBuilder";

function canResolve(t: IntersectionType): boolean {
  const members = setOperationMembersRecursively(t, undefined)[0];
  if (members.size <= 1) return true;
  return iterableEvery(members, (m) => !(m instanceof UnionType) || m.isCanonical);
}

function attributesForTypes<T extends TypeKind>(types: ReadonlySet<Type>): TypeAttributeMap<T> {
  return mapMapEntries(types.entries(), (t) => [t.kind, t.getAttributes()] as [T, TypeAttributes]);
}

type PropertyMap = Map<string, GenericClassProperty<Set<Type>>>;

class IntersectionAccumulator {
  #arrayItemTypes: Set<Type> | undefined | false;
  #arrayAttributes: TypeAttributes = emptyTypeAttributes;
  #primitiveTypes: Set<PrimitiveTypeKind> | undefined;
  #primitiveAttributes: TypeAttributeMap<PrimitiveTypeKind> = new Map();
  #objectProperties: PropertyMap | undefined = new Map();
  #objectAttributes: TypeAttributes = emptyTypeAttributes;
  #addtionalPropertyTypes: Set<Type> | undefined = new Set();
  #lostTypeAttributes: boolean = false;

  private updatePrimitiveTypes(members: Iterable<Type>): void {
    const types = setFilter(members, (t) => isPrimitiveTypeKind(t.kind));
    const attributes = attributesForTypes<PrimitiveTypeKind>(types);

    mapMergeWithInto(this.#primitiveAttributes, (a, b) => combineTypeAttributes("intersect", a, b), attributes);

    const kinds = setMap(types, (t) => t.kind) as ReadonlySet<PrimitiveTypeKind>;

    if (!this.#primitiveTypes) {
      this.#primitiveTypes = new Set(kinds);
      return;
    }

    const haveNumber =
      iterableFind(this.#primitiveTypes, isNumberTypeKind) !== undefined &&
      iterableFind(kinds, isNumberTypeKind) !== undefined;
    this.#primitiveTypes = setIntersect(this.#primitiveTypes, kinds);

    if (haveNumber && iterableFind(this.#primitiveTypes, isNumberTypeKind) === undefined) {
      this.#primitiveTypes = this.#primitiveTypes.add("integer");
    }
  }

  private updateArrayItemTypes(members: Iterable<Type>): void {
    const maybeArray = iterableFind(members, (t) => t instanceof ArrayType) as ArrayType | undefined;
    if (!maybeArray) {
      this.#arrayItemTypes = false;
      return;
    }
    this.#arrayAttributes = combineTypeAttributes("intersect", this.#arrayAttributes, maybeArray.getAttributes());
    if (!this.#arrayItemTypes) {
      this.#arrayItemTypes = new Set();
    } else if (this.#arrayItemTypes) {
      this.#arrayItemTypes.add(maybeArray.items);
    }
  }
  private updateObjectProperies(members: Iterable<Type>): void {
    const maybeObject = iterableFind(members, (t) => t instanceof ObjectType) as ObjectType | undefined;
    if (!maybeObject) {
      this.#objectProperties = undefined;
      this.#addtionalPropertyTypes = undefined;
      return;
    }
    this.#objectAttributes = combineTypeAttributes("intersect", this.#objectAttributes, maybeObject.getAttributes());
    const objectAdditionalPropeites = maybeObject.getAdditionalProperties();

    if (!this.#objectProperties) {
      return assert(!this.#addtionalPropertyTypes);
    }

    const allPropertyNames = setUnionInto(new Set(this.#objectProperties.keys()), maybeObject.getProperties().keys());
    for (const name of allPropertyNames) {
      const existing = defined(this.#objectProperties).get(name);
      const newProperty = maybeObject.getProperties().get(name);

      if (existing && newProperty) {
        const cp = new GenericClassProperty(
          existing.typeData.add(newProperty.type),
          existing.isOptional && newProperty.isOptional
        );
        defined(this.#objectProperties).set(name, cp);
      } else if (existing && objectAdditionalPropeites) {
        const cp = new GenericClassProperty(existing.typeData.add(objectAdditionalPropeites), existing.isOptional);
        defined(this.#objectProperties).set(name, cp);
      } else if (existing) {
        defined(this.#objectProperties).delete(name);
      } else if (newProperty && this.#addtionalPropertyTypes) {
        const types = new Set(this.#addtionalPropertyTypes).add(newProperty.type);
        defined(this.#objectProperties).set(name, new GenericClassProperty(types, newProperty.isOptional));
      } else if (newProperty) {
        defined(this.#objectProperties).delete(name);
      } else {
        return mustNotHappen();
      }
    }
    if (this.#addtionalPropertyTypes && objectAdditionalPropeites) {
      this.#addtionalPropertyTypes.add(objectAdditionalPropeites);
    } else if (this.#addtionalPropertyTypes || objectAdditionalPropeites) {
      this.#addtionalPropertyTypes = undefined;
      this.#lostTypeAttributes = true;
    }
  }
  private addUnionSet(members: Iterable<Type>): void {
    this.updatePrimitiveTypes(members);
    this.updateArrayItemTypes(members);
    this.updateObjectProperies(members);
  }
  addType(t: Type): TypeAttributes {
    let attributes = t.getAttributes();
    matchTypeExhaustive<void>(
      t,
      (noneType) => panic(`There shouldn't be a non type`),
      (anyType) => panic(`The any type should have been filtered out in setOperationMembersRecursively`),
      (nullType) => this.addUnionSet([nullType]),
      (boolType) => this.addUnionSet([boolType]),
      (integerType) => this.addUnionSet([integerType]),
      (doubleType) => this.addUnionSet([doubleType]),
      (stringType) => this.addUnionSet([stringType]),
      (arrayType) => this.addUnionSet([arrayType]),
      (classType) => panic("We should never see class types in intersections"),
      (mapType) => panic("We should never see map types in intersections"),
      (objectType) => this.addUnionSet([objectType]),
      (enumType) => panic("We should never see enum types in intersections"),
      (unionType) => {
        attributes = combineTypeAttributes(
          "intersect",
          [attributes].concat(Array.from(unionType.members).map((m) => m.getAttributes()))
        );
        this.addUnionSet(unionType.members);
      },
      (transformedStringType) => this.addUnionSet([transformedStringType])
    );
    return makeTypeAttributesInferred(attributes);
  }

  get arrayData(): ReadonlySet<Type> {
    if (this.#arrayItemTypes === undefined || this.#arrayItemTypes === false) {
      return panic(`The should not be called if the type can't be an array`);
    }
    return this.#arrayItemTypes;
  }

  get objectData(): [PropertyMap, ReadonlySet<Type> | undefined] | undefined {
    if (this.#objectProperties === undefined) {
      assert(this.#addtionalPropertyTypes === undefined);
      return undefined;
    }
    return [this.#objectProperties, this.#addtionalPropertyTypes];
  }
  get enumCases(): ReadonlySet<string> {
    return panic("We don't support enums in intersections");
  }
  getMembersKinds(): TypeAttributeMap<TypeKind> {
    const kinds: TypeAttributeMap<TypeKind> = mapMap(defined(this.#primitiveTypes).entries(), (k) =>
      defined(this.#primitiveAttributes.get(k))
    );
    const maybeDoubleAttributes = this.#primitiveAttributes.get("double");
    if (maybeDoubleAttributes && !kinds.has("double") && kinds.has("integer")) {
      mapUpdateInto(kinds, "integer", (a) => combineTypeAttributes("intersect", defined(a), maybeDoubleAttributes));
    }
    if (this.#arrayItemTypes !== undefined && this.#arrayItemTypes !== false) {
      kinds.set("array", this.#arrayAttributes);
    } else if (this.#arrayAttributes.size > 0) {
      this.#lostTypeAttributes = true;
    }

    if (this.#objectProperties) {
      kinds.set("object", this.#objectAttributes);
    } else if (this.#objectAttributes.size > 0) {
      this.#lostTypeAttributes = true;
    }

    return kinds;
  }
  get lostTypeAttributes(): boolean {
    return this.#lostTypeAttributes;
  }
}

class IntersectionUnionBuilder extends UnionBuilder<
  TypeBuilder & TypeLookerUp,
  ReadonlySet<Type>,
  [PropertyMap, ReadonlySet<Type> | undefined] | undefined
> {
  #createdNewIntersections: boolean = false;
  private makeIntersection(members: ReadonlySet<Type>, attributes: TypeAttributes): TypeRef {
    const reconstituedMembers = setMap(members, (t) => this.typeBuilder.reconstituteTypeRef(t.typeRef));
    const first = defined(iterableFirst(reconstituedMembers));
    if (reconstituedMembers.size === 1) {
      this.typeBuilder.addAttributes(first, attributes);
      return first;
    }
    this.#createdNewIntersections = true;
    return this.typeBuilder.getUniqueIntersectionType(attributes, reconstituedMembers);
  }

  get cteatedNewIntersections(): boolean {
    return this.#createdNewIntersections;
  }
  protected makeObject(
    maybeData: [PropertyMap, ReadonlySet<Type> | undefined] | undefined,
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef {
    if (maybeData === undefined)
      return panic(`Either properties or additinal properties must be given to make an object type`);
    const [propertyTypes, maybeAdditionalProperties] = maybeData;
    const properties = mapMap(propertyTypes, (cp) =>
      this.typeBuilder.makeClassProperty(this.makeIntersection(cp.typeData, emptyTypeAttributes), cp.isOptional)
    );
    const additionalProperties =
      maybeAdditionalProperties === undefined
        ? undefined
        : this.makeIntersection(maybeAdditionalProperties, emptyTypeAttributes);
    return this.typeBuilder.getUniqueObjectType(typeAttributes, properties, additionalProperties, forwardingRef);
  }

  protected makeArray(
    arrays: ReadonlySet<Type>,
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef {
    const itemsType = this.makeIntersection(arrays, emptyTypeAttributes);
    const ref = this.typeBuilder.getArrayType(typeAttributes, itemsType, forwardingRef);
    return ref;
  }
}

export function resolveIntersections(
  graph: TypeGraph,
  stringTypeMapping: StringTypeMapping,
  debug: boolean
): [TypeGraph, boolean] {
  let needRepeat = false;
  function replace(types: ReadonlySet<Type>, builder: GraphRewriteBuilder<Type>, forwardingRef: TypeRef): TypeRef {
    const intersections = setFilter(types, (t) => t instanceof IntersectionType) as Set<IntersectionType>;
    const [members, intersectionAttributes] = setOperationMembersRecursively(Array.from(intersections), "intersect");

    if (members.size === 0) return builder.getPrimitiveType("any", intersectionAttributes, forwardingRef);
    if (members.size === 1)
      return builder.reconstituteType(defined(iterableFirst(members)), intersectionAttributes, forwardingRef);

    const accumulator = new IntersectionAccumulator();
    const extraAttributes = makeTypeAttributesInferred(
      combineTypeAttributes(
        "intersect",
        Array.from(members).map((t) => accumulator.addType(t))
      )
    );

    const attributes = combineTypeAttributes("intersect", intersectionAttributes, extraAttributes);
    const unionBuilder = new IntersectionUnionBuilder(builder);
    const ref = unionBuilder.buildUnion(accumulator as any, true, attributes, forwardingRef);
    if (unionBuilder.cteatedNewIntersections) needRepeat = true;
    return ref;
  }
  const allIntersections = setFilter(
    graph.allTypesUnordered(),
    (t) => t instanceof IntersectionType
  ) as Set<IntersectionType>;
  const resolvableIntersections = setFilter(allIntersections, canResolve);
  const groups = makeGroupToFlatten(resolvableIntersections, undefined);
  graph = graph.rewrite("resolve intersections", stringTypeMapping, false, groups, debug, replace);

  return [graph, !needRepeat && allIntersections.size === resolvableIntersections.size];
}
