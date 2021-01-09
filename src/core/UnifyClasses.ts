import { iterableFirst, setUnionInto } from "collection-utils";
import { combineTypeAttributes, emptyTypeAttributes, TypeAttributes } from "./attributes/TypeAttributes";
import { BaseGraphRewriteBuilder, GraphRewriteBuilder, TypeLookerUp } from "./GraphRewriting";
import { assert, defined, panic } from "./support";
import { ClassProperty, ObjectType, Type, UnionType } from "./Type";
import { TypeBuilder } from "./TypeBuilder";
import { derefTypeRef, TypeRef } from "./TypeGraph";
import { assertIsObject } from "./TypeUtils";
import { TypeRefUnionAccumulator, UnionBuilder } from "./UnionBuilder";

export function getCliqueProperties(
  clique: ObjectType[],
  builder: TypeBuilder,
  makePropertyType: (types: ReadonlySet<Type>) => TypeRef
): [ReadonlyMap<string, ClassProperty>, TypeRef | undefined, boolean] {
  let lostTypeAttributes = false;
  let propertyeNames = new Set<string>();
  for (const o of clique) {
    setUnionInto(propertyeNames, o.getProperties().keys());
  }
  let properties = Array.from(propertyeNames).map((name) => [name, new Set(), false] as [string, Set<Type>, boolean]);
  let additionalProperties: Set<Type> | undefined = undefined;
  for (const o of clique) {
    let additional = o.getAdditionalProperties();
    if (additional) {
      if (additionalProperties) {
        additionalProperties = new Set();
      }
      additionalProperties?.add(additional);
    }
    for (let i = 0; i < properties.length; i++) {
      const item = properties[i];
      let [name, types, isOptional] = properties[i];
      const maybeProperty = o.getProperties().get(name);
      if (!maybeProperty) {
        isOptional = true;
        if (additional && additional.kind !== "any") types.add(additional);
      } else {
        if (maybeProperty.isOptional) isOptional = true;
        types.add(maybeProperty.type);
      }
    }
  }
  const unifiedAdditionalProperties = additionalProperties ? makePropertyType(additionalProperties) : undefined;
  const unifiedPropertiesArray = properties.map(([name, types, isOptional]) => {
    return [name, builder.makeClassProperty(makePropertyType(types), isOptional)] as [string, ClassProperty];
  });
  const unifiedProperties = new Map(unifiedPropertiesArray);
  return [unifiedProperties, unifiedAdditionalProperties, lostTypeAttributes];
}

function countProperties(
  clique: ObjectType[]
): { hasProperties: boolean; hasAdditionalProperties: boolean; hasNonAnyAdditionalProperties: boolean } {
  let hasProperties = false,
    hasAdditionalProperties = false,
    hasNonAnyAdditionalProperties = false;
  for (const o of clique) {
    if (o.getProperties().size > 0) hasProperties = true;
    const additional = o.getAdditionalProperties();
    if (additional) {
      hasAdditionalProperties = true;
      if (additional.kind !== "any") hasNonAnyAdditionalProperties = true;
    }
  }
  return { hasAdditionalProperties, hasNonAnyAdditionalProperties, hasProperties };
}

export class UnifyUnionBuilder extends UnionBuilder<BaseGraphRewriteBuilder, TypeRef[], TypeRef[]> {
  constructor(
    typeBuilder: BaseGraphRewriteBuilder,
    private readonly makeObjectTypes: boolean,
    private readonly makeClassesFixed: boolean,
    private readonly unifiyTypes: (typesToUnify: TypeRef[]) => TypeRef
  ) {
    super(typeBuilder);
  }
  protected makeObject(
    objectsRefs: TypeRef[],
    typeAttributes: TypeAttributes,
    forwardingRef: TypeRef | undefined
  ): TypeRef {
    const maybeTypeRef = this.typeBuilder.lookupTypeRefs(objectsRefs, forwardingRef);
    if (maybeTypeRef) {
      assert(!forwardingRef || maybeTypeRef === forwardingRef, "The forwarding ref must be consumed");
      this.typeBuilder.addAttributes(maybeTypeRef, typeAttributes);
      return maybeTypeRef;
    }
    if (objectsRefs.length === 1)
      return this.typeBuilder.reconstituteTypeRef(objectsRefs[0], typeAttributes, forwardingRef);
    const objectsTypes = objectsRefs.map((r) => assertIsObject(derefTypeRef(r, this.typeBuilder)));
    const { hasAdditionalProperties, hasNonAnyAdditionalProperties, hasProperties } = countProperties(objectsTypes);
    if (!(this.makeObjectTypes && (hasNonAnyAdditionalProperties || !(hasProperties || hasAdditionalProperties)))) {
      const propertyTypes = new Set<TypeRef>();
      for (const o of objectsTypes) {
        setUnionInto(
          propertyTypes,
          Array.from(o.getProperties().values()).map((cp) => cp.typeRef)
        );
      }
      const additionalPropertyTypes = new Set(
        objectsTypes.filter((o) => o.getAdditionalProperties()).map((o) => defined(o.getAdditionalProperties()).typeRef)
      );
      setUnionInto(propertyTypes, additionalPropertyTypes);
      return this.typeBuilder.getMapType(typeAttributes, this.unifiyTypes(Array.from(propertyTypes)));
    } else {
      const [propertis, additionalProperties, lostTypeAttributes] = getCliqueProperties(
        objectsTypes,
        this.typeBuilder,
        (types) => {
          assert(types.size > 0, "Property has no type");
          return this.unifiyTypes(Array.from(types).map((t) => t.typeRef));
        }
      );
      if (lostTypeAttributes) this.typeBuilder.setLostTypeAttributes();
      if (this.makeObjectTypes)
        return this.typeBuilder.getUniqueObjectType(typeAttributes, propertis, additionalProperties, forwardingRef);
      assert(!additionalProperties, "We have addtional properties but want to make a class");
      return this.typeBuilder.getUniqueClassType(typeAttributes, this.makeClassesFixed, propertis, forwardingRef);
    }
  }
  protected makeArray(arrays: TypeRef[], typeAttributes: TypeAttributes, forwardingRef: TypeRef | undefined): TypeRef {
    return this.typeBuilder.getArrayType(typeAttributes, this.unifiyTypes(arrays), forwardingRef);
  }
}

export function unionBuilderForUnification<T extends Type>(
  typeBuilder: GraphRewriteBuilder<T>,
  makeObjectTypes: boolean,
  makeClassesFixed: boolean,
  conflateNumbers: boolean
): UnionBuilder<TypeBuilder & TypeLookerUp, TypeRef[], TypeRef[]> {
  return new UnifyUnionBuilder(typeBuilder, makeObjectTypes, makeClassesFixed, (refs) =>
    unifyTypes(
      new Set(refs.map((ref) => derefTypeRef(ref, typeBuilder))),
      emptyTypeAttributes,
      typeBuilder,
      unionBuilderForUnification(typeBuilder, makeObjectTypes, makeClassesFixed, conflateNumbers),
      conflateNumbers
    )
  );
}

export function unifyTypes<T extends Type>(
  types: ReadonlySet<Type>,
  typeAttributes: TypeAttributes,
  typeBuilder: GraphRewriteBuilder<T>,
  unionBuilder: UnionBuilder<TypeBuilder & TypeLookerUp, TypeRef[], TypeRef[]>,
  conflateNumbers: boolean,
  maybeForwardingRef?: TypeRef
): TypeRef {
  typeAttributes = typeBuilder.reconstituteTypeAttributes(typeAttributes);
  if (types.size === 0) return panic("Cannot unify empty set of types");
  else if (types.size === 1) {
    const first = defined(iterableFirst(types));
    if (!(first instanceof UnionType))
      return typeBuilder.reconstituteTypeRef(first.typeRef, typeAttributes, maybeForwardingRef);
  }
  const typeRefs = Array.from(types).map((t) => t.typeRef);
  const maybeTypeRef = typeBuilder.lookupTypeRefs(typeRefs, maybeForwardingRef);
  if (maybeTypeRef) {
    typeBuilder.addAttributes(maybeTypeRef, typeAttributes);
    return maybeTypeRef;
  }
  const accumulator = new TypeRefUnionAccumulator(conflateNumbers);
  const nestedAttributes = typeBuilder.reconstituteTypeAttributes(accumulator.addTypes(types));
  typeAttributes = combineTypeAttributes("union", typeAttributes, nestedAttributes);
  return typeBuilder.withForwardingRef(maybeForwardingRef, (ref) => {
    typeBuilder.registerUnion(typeRefs, ref);
    return unionBuilder.buildUnion(accumulator, false, typeAttributes, ref);
  });
}
