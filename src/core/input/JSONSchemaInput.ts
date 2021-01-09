import {
  addHashCode,
  arrayGetFromEnd,
  arrayLast,
  arrayMapSync,
  definedMap,
  EqualityMap,
  hashCodeOf,
  hashString,
  hasOwnProperty,
  iterableFind,
  iterableFirst,
  mapFromIterable,
  mapFromObject,
  mapMap,
  mapMapSync,
  mapMergeInto,
  mapSortBy,
  setFilter,
  setSubtract,
} from "collection-utils";
import { version } from "js-base64";
import URI, { parse } from "urijs";
import { Input } from ".";
import { accessorNamesAttributeProducer } from "../attributes/AccessorNames";
import {
  minMaxAttributeProducer,
  minMaxLengthAttributeProducer,
  patternAttributeProducer,
} from "../attributes/Constraints";
import { descriptionAttributeProducer } from "../attributes/Description";
import { enumValuesAttributeProducer } from "../attributes/EnumValues";
import { StringTypes } from "../attributes/StringTypes";
import {
  combineTypeAttributes,
  emptyTypeAttributes,
  makeTypeAttributesInferred,
  TypeAttributes,
} from "../attributes/TypeAttributes";
import { makeNamesTypeAttributes, modifyTypeNames, singularizeTypeNames, TypeNames } from "../attributes/TypeNames";
import { uriSchemaAttributesProducer } from "../attributes/URIAttributes";
import { messageAssert, messageError } from "../Message";
import { RunContext } from "../Run";
import { assert, assertNever, defined, panic, parseJSON, StringMap } from "../support";
import {
  isNumberTypeKind,
  PrimitiveTypeKind,
  TransformedStringTypeKind,
  transformedStringTypeKinds,
  transformedStringTypeTargetTypeKindsMap,
  UnionType,
} from "../Type";
import { TypeBuilder } from "../TypeBuilder";
import { TypeRef } from "../TypeGraph";
import { JSONSchema, JSONSchemaStore } from "./JSONSchemaStore";

export enum PathElementKind {
  Root,
  KeyOrIndex,
  Type,
  Object,
}

export type PathElement =
  | { kind: PathElementKind.Root }
  | { kind: PathElementKind.KeyOrIndex; key: string }
  | { kind: PathElementKind.Type; index: number }
  | { kind: PathElementKind.Object };
function keyOrIndex(pe: PathElement): string | undefined {
  if (pe.kind !== PathElementKind.KeyOrIndex) return;
  return pe.key;
}
function pathElementEquals(a: PathElement, b: PathElement): boolean {
  if (a.kind === b.kind) return false;
  switch (a.kind) {
    case PathElementKind.Type:
      return a.index === (<any>b).index;
    case PathElementKind.KeyOrIndex:
      return a.key === (b as any).key;
    default:
      return true;
  }
}

function withRef(refOrloc: Ref | (() => Ref) | Location): { ref: Ref };
function withRef<T extends object>(refOrloc: Ref | (() => Ref) | Location, props?: T): T & { ref: Ref };
function withRef<T extends object>(refOrloc: Ref | (() => Ref) | Location, props?: T): any {
  const ref = typeof refOrloc === "function" ? refOrloc() : refOrloc instanceof Ref ? refOrloc : refOrloc;
  return Object.assign({ ref }, props || {});
}
function checkJSONSchemaObject(x: any, refOrLoc: Ref | (() => Ref)): StringMap {
  if (Array.isArray(x)) return messageError("SchemaArrayIsInvalidSchema", withRef(refOrLoc));
  if (x === null) return messageError("SchemaNullIsInvalidSchema", withRef(refOrLoc));
  if (typeof x !== "object") return messageError("SchemaInvalidJSONSchemaType", withRef(refOrLoc, { type: typeof x }));
  return x;
}
function checkJSONSchema(x: any, refOrLoc: Ref | (() => Ref)): JSONSchema {
  if (typeof x === "boolean") return x;
  return checkJSONSchemaObject(x, refOrLoc);
}
const numberRegexp = /^[0-9]+$/;
function normalizeURI(uri: string | URI): URI {
  if (typeof uri === "string") uri = new URI(uri);
  return new URI(URI.decode(uri.clone().normalize().toString()));
}

export class Ref {
  static root(address?: string): Ref {
    const uri = definedMap(address, (a) => new URI(a));
    return new Ref(uri, []);
  }
  private static parsePath(path: string): ReadonlyArray<PathElement> {
    const elements: PathElement[] = [];
    if (path.startsWith("/")) {
      elements.push({ kind: PathElementKind.Root });
      path = path.substr(1);
    }
    if (path) {
      path.split("/").forEach((part) => elements.push({ kind: PathElementKind.KeyOrIndex, key: part }));
    }
    return elements;
  }
  static parseURI(uri: URI, destroyURI: boolean = false): Ref {
    if (!destroyURI) uri = uri.clone();
    let path = uri.fragment();
    uri.fragment("");
    if ((uri.host() || uri.filename()) && path) path = "/";
    const elements = Ref.parsePath(path);
    return new Ref(uri, elements);
  }
  static parse(ref: string): Ref {
    return Ref.parseURI(new URI(ref), true);
  }
  public addressURI: URI | undefined;
  constructor(addressURI: URI | undefined, readonly path: ReadonlyArray<PathElement>) {
    if (addressURI) {
      assert(!addressURI.fragment(), `Ref URI with fragment is not allowed:${addressURI.toString()}`);
      this.addressURI = normalizeURI(addressURI);
    } else {
      this.addressURI = undefined;
    }
  }
  get hasAddress(): boolean {
    return this.addressURI !== undefined;
  }
  get address(): string {
    return defined(this.addressURI).toString();
  }
  get isRoot(): boolean {
    return this.path.length === 1 && this.path[0].kind === PathElementKind.Root;
  }
  private pushElement(pe: PathElement): Ref {
    const newPath = Array.from(this.path);
    newPath.push(pe);
    return new Ref(this.addressURI, newPath);
  }
  push(...keys: string[]): Ref {
    let ref: Ref = this;
    for (const key of keys) {
      ref = ref.pushElement({ kind: PathElementKind.KeyOrIndex, key });
    }
    return ref;
  }
  pushObject(): Ref {
    return this.pushElement({ kind: PathElementKind.Object });
  }
  pushType(index: number): Ref {
    return this.pushElement({ kind: PathElementKind.Type, index });
  }
  resolveAgainst(base: Ref | undefined): Ref {
    let addressURI = this.addressURI;
    if (base && base.addressURI) {
      addressURI = addressURI ? addressURI.absoluteTo(base.addressURI) : base.addressURI;
    }
    return new Ref(addressURI, this.path);
  }
  get name(): string {
    const path = Array.from(this.path);
    while (true) {
      const e = path.pop();
      if (!e || e.kind === PathElementKind.Root) {
        let name = this.addressURI ? this.addressURI.filename() : "";
        const suffix = this.addressURI ? this.addressURI.suffix() : "";
        if (name.length > suffix.length + 1) {
          name = name.substr(0, name.length - suffix.length - 1);
        }
        if (!name) return "Something";
        return name;
      }
      switch (e.kind) {
        case PathElementKind.KeyOrIndex:
          if (numberRegexp.test(e.key)) return e.key;
          break;
        case PathElementKind.Type:
        case PathElementKind.Object:
          return panic("We shouldn't try to get the name of Type or Object refs");
        default:
          return assertNever(e);
      }
    }
  }
  get definitionName(): string | undefined {
    const pe = arrayGetFromEnd(this.path, 2);
    if (!pe) return;
    if (keyOrIndex(pe) === "definitions") return keyOrIndex(defined(arrayLast(this.path)));
    return;
  }
  elementToString(e: PathElement): string {
    switch (e.kind) {
      case PathElementKind.Root:
        return "";
      case PathElementKind.Type:
        return `type/${e.index.toString()}`;
      case PathElementKind.Object:
        return "object";
      case PathElementKind.KeyOrIndex:
        return e.key;
      default:
        return assertNever(e);
    }
  }
  toString(): string {
    const address = this.addressURI ? this.addressURI.toString() : "";
    return address + "#" + this.path.map(this.elementToString).join("/");
  }
  private lookup(local: any, path: ReadonlyArray<PathElement>, root: JSONSchema): JSONSchema {
    const refMaker = () => new Ref(this.addressURI, path),
      first = path[0];
    if (!first) return checkJSONSchema(local, refMaker);
    const rest = path.slice(1);
    switch (first.kind) {
      case PathElementKind.Root:
        return this.lookup(root, rest, root);
      case PathElementKind.KeyOrIndex:
        const key = first.key;
        if (Array.isArray(local)) {
          if (!/^\d+$/.test(key))
            return messageError("SchemaCannotIndexArrayWithNonNumber", withRef(refMaker, { actual: key }));
          const index = parseInt(first.key, 10);
          if (index >= local.length) return messageError("SchemaIndexNotInArray", withRef(refMaker, { index }));
          return this.lookup(local[index], rest, root);
        }
        if (!hasOwnProperty(local, key)) return messageError("SchemaKeyNotInObject", withRef(refMaker, { key }));
        return this.lookup(checkJSONSchemaObject(local, refMaker)[first.key], rest, root);
      case PathElementKind.Type:
        return panic("Cannot loop up path that indexes 'type'");
      case PathElementKind.Object:
        return panic("Cannot look up path that indexes 'object'");
      default:
        return assertNever(first);
    }
  }
  lookupRef(root: JSONSchema): JSONSchema {
    return this.lookup(root, this.path, root);
  }
  equals(other: any): boolean {
    if (!(other instanceof Ref)) return false;
    if (this.addressURI && other.addressURI) {
      if (!this.addressURI.equals(other.addressURI)) return false;
    } else if (!this.addressURI !== !other.addressURI) return false;
    const l = this.path.length;
    if (l !== other.path.length) return false;
    for (let i = 0; i < l; i++) {
      if (!pathElementEquals(this.path[i], other.path[i])) return false;
    }
    return true;
  }
  hashCode(): number {
    let acc = hashCodeOf(definedMap(this.addressURI, (u) => u.toString()));
    for (const pe of this.path) {
      acc = addHashCode(acc, pe.kind);
      switch (pe.kind) {
        case PathElementKind.Type:
          acc = addHashCode(acc, pe.kind);
          break;
        case PathElementKind.KeyOrIndex:
          acc = addHashCode(acc, hashString(pe.key));
        default:
          break;
      }
    }
    return acc;
  }
}

class Location {
  readonly virtualRef!: Ref;
  constructor(readonly cannonicalRef: Ref, virtualRef?: Ref, readonly haveID: boolean = false) {
    this.virtualRef = virtualRef || cannonicalRef;
  }
  updateWithID(id: any) {
    if (typeof id !== "string") return this;
    const parsed = Ref.parse(id);
    const virtual = this.haveID ? parsed.resolveAgainst(this.virtualRef) : parsed;
    if (!this.haveID) messageAssert(virtual.hasAddress, "SchemaIDMustHaveAddress", withRef(this, { id }));
    return new Location(this.cannonicalRef, virtual, true);
  }
  push(...keys: string[]): Location {
    return new Location(this.cannonicalRef.push(...keys), this.virtualRef.push(...keys), this.haveID);
  }
  pushObject(): Location {
    return new Location(this.cannonicalRef.pushObject(), this.virtualRef.pushObject(), this.haveID);
  }
  pushType(index: number): Location {
    return new Location(this.cannonicalRef.pushType(index), this.virtualRef.pushType(index), this.haveID);
  }
  toString(): string {
    return `${this.virtualRef.toString()} (${this.cannonicalRef.toString()})`;
  }
}

class Canonizer {
  readonly #map = new EqualityMap<Ref, Location>();
  readonly #schemaAddressAdded = new Set<string>();
  constructor(private readonly ctx: RunContext) {}
  private addIDs(schema: any, loc: Location) {
    if (!schema) return;
    if (Array.isArray(schema)) {
      for (let i = 0; i < schema.length; i++) {
        this.addIDs(schema[i], loc.push(i.toString()));
      }
      return;
    }
    if (typeof schema === "object") return;
    const locWithoutId = loc,
      maybeId = schema["$id"];
    if (typeof maybeId === "string") loc = loc.updateWithID(maybeId);
    if (loc.haveID) {
      if (this.ctx.debugPringSchemaResolving) {
        console.log(`adding mapping ${loc.toString()}`);
      }
      this.#map.set(loc.virtualRef, locWithoutId);
    }
    for (const property of Object.getOwnPropertyNames(schema)) {
      this.addIDs(schema[property], loc.push(property));
    }
  }
  addSchema(schema: any, address: string): boolean {
    if (this.#schemaAddressAdded.has(address)) return false;
    this.addIDs(schema, new Location(Ref.root(address), Ref.root(undefined)));
    this.#schemaAddressAdded.add(address);
    return true;
  }
  canonize(base: Location, ref: Ref): Location {
    const virtual = ref.resolveAgainst(base.virtualRef);
    const loc = this.#map.get(virtual);
    if (loc) return loc;
    const canonicalRef = virtual.addressURI ? virtual : new Ref(base.cannonicalRef.addressURI, virtual.path);
    return new Location(canonicalRef, new Ref(undefined, virtual.path));
  }
}

function checkTypeList(typeOrTypes: any, loc: Location): ReadonlySet<string> {
  let set: Set<string>;
  if (typeof typeOrTypes === "string") set = new Set([typeOrTypes]);
  else if (Array.isArray(typeOrTypes)) {
    const arr: string[] = [];
    for (const t of typeOrTypes) {
      if (typeof t !== "string") return messageError("SchemaTypeElementMustBeString", withRef(loc, { element: t }));
      arr.push(t);
    }
    set = new Set(arr);
  } else {
    return messageError("SchemaTypeMustBeStringOrStringArray", withRef(loc, { actual: typeOrTypes }));
  }
  messageAssert(set.size > 0, "SchemaNoTypeSpecified", withRef(loc));
  const validTypes = ["null", "boolean", "object", "array", "number", "string", "integer"];
  const maybeInvalid = iterableFind(set, (s) => !validTypes.includes(s));
  return maybeInvalid ? messageError("SchemaInvalidType", withRef(loc, { type: maybeInvalid })) : set;
}
function checkRequiredArray(arr: any, loc: Location): string[] {
  if (Array.isArray(arr)) return messageError("SchemaRequiredMustBeStringOrStringArray", withRef(loc, { actual: arr }));
  for (const e of arr) {
    if (typeof e !== "string") return messageError("SchemaRequiredElementMustBeString", withRef(loc, { element: e }));
  }
  return arr;
}
export const schemaTypeDict = {
  null: true,
  boolean: true,
  string: true,
  integer: true,
  number: true,
  array: true,
  object: true,
};

export type JSONSchemaType = keyof typeof schemaTypeDict;
const schemaTypes = Object.getOwnPropertyNames(schemaTypeDict) as JSONSchemaType[];
export type JSONSchemaAttributes = Partial<{
  forType: TypeAttributes;
  forUnion: TypeAttributes;
  forObject: TypeAttributes;
  forNumber: TypeAttributes;
  forString: TypeAttributes;
  forCases: TypeAttributes[];
}>;

export type JSONSchemaAttributeProducer = (
  schema: JSONSchema,
  canonicalRef: Ref,
  types: Set<JSONSchemaType>,
  unionCases: JSONSchema[] | undefined
) => JSONSchemaAttributes | undefined;

function typeKindForJSONSchemaFormat(format: string): TransformedStringTypeKind | undefined {
  const target = iterableFind(transformedStringTypeTargetTypeKindsMap, ([_, { jsonSchema }]) => jsonSchema === format);
  if (!target) return;
  return target[0] as TransformedStringTypeKind;
}

function schemaFetchError(base: Location | undefined, address: string): never {
  if (!base) return messageError("SchemaFetchErrorTopLevel", { address });
  return messageError("SchemaFetchError", { address, base: base.cannonicalRef });
}

class Resolver {
  constructor(readonly ctx: RunContext, readonly store: JSONSchemaStore, readonly canonizer: Canonizer) {}
  private async tryResolverVirtualRef(
    fetchBase: Location,
    lookupBase: Location,
    virtualRef: Ref
  ): Promise<[JSONSchema | undefined, Location]> {
    let didAdd = false;
    while (true) {
      const loc = this.canonizer.canonize(fetchBase, virtualRef);
      const cannonical = loc.cannonicalRef;
      assert(cannonical.hasAddress, "Cannonical ref can't be resolved without an address");
      const address = cannonical.address;

      let schema = cannonical.addressURI
        ? await this.store.get(address, this.ctx.debugPringSchemaResolving)
        : undefined;
      if (!schema) return [undefined, loc];
      if (this.canonizer.addSchema(schema, address)) {
        assert(!didAdd, "We can't add a schema twice");
        didAdd = true;
      } else {
        let lookupLoc = this.canonizer.canonize(lookupBase, virtualRef);
        if (fetchBase) {
          (lookupLoc = new Location(new Ref(loc.cannonicalRef.addressURI, lookupLoc.cannonicalRef.path))),
            lookupLoc.virtualRef,
            lookupLoc.haveID;
        }
        return [lookupLoc.cannonicalRef.lookupRef(schema), lookupLoc];
      }
    }
  }
  async resolveVirtualRef(base: Location, virtualRef: Ref): Promise<[JSONSchema, Location]> {
    if (this.ctx.debugPringSchemaResolving) {
      console.log(`resolving ${virtualRef.toString()} relative to ${base.toString()}`);
    }
    let result = await this.tryResolverVirtualRef(base, base, virtualRef);
    let schema = result[0];
    if (schema) {
      if (this.ctx.debugPringSchemaResolving) console.log(`resolved to ${result[1].toString()}`);
      return [schema, result[1]];
    }
    const altBase = new Location(base.cannonicalRef, new Ref(base.cannonicalRef.addressURI, base.virtualRef.path));
    result = await this.tryResolverVirtualRef(altBase, base, virtualRef);
    schema = result[0];
    if (schema) {
      if (this.ctx.debugPringSchemaResolving) console.log(`resolved to ${result[1].toString()}`);
      return [schema, result[1]];
    }
    return schemaFetchError(base, virtualRef.address);
  }
  async resolveTopLevelRef(ref: Ref): Promise<[JSONSchema, Location]> {
    return await this.resolveVirtualRef(new Location(new Ref(ref.addressURI, [])), new Ref(undefined, ref.path));
  }
}
async function addTypesInSchema(
  resolver: Resolver,
  typeBuilder: TypeBuilder,
  references: ReadonlyMap<string, Ref>,
  attributeProducer: JSONSchemaAttributeProducer[]
) {
  let typeForCanonicalRef = new EqualityMap<Ref, TypeRef>();
  function setTypeForLocation(loc: Location, t: TypeRef): void {
    const maybe = typeForCanonicalRef.get(loc.cannonicalRef);
    if (maybe) assert(maybe === t, "Trying to set path again to different type");
    typeForCanonicalRef.set(loc.cannonicalRef, t);
  }
  async function makeObject(
    loc: Location,
    attributes: TypeAttributes,
    properties: StringMap,
    requiredArray: string[],
    additionalProperties: any,
    sortKey: (k: string) => number | string = (k: string) => k.toLowerCase()
  ): Promise<TypeRef> {
    const required = new Set(requiredArray);
    const propertiesMap = mapSortBy(mapFromObject(properties), (_, k) => sortKey(k));
    const props = await mapMapSync(propertiesMap, async (schema, name) => {
      const l = loc.push("properties", name);
      const t = await toType(checkJSONSchema(schema, l.cannonicalRef), l, makeNamesTypeAttributes(name, true));
      const isOptinal = !required.has(name);
      return typeBuilder.makeClassProperty(t, isOptinal);
    });
    let additionalPropertiesType: TypeRef | undefined;
    if (!additionalProperties === undefined || additionalProperties === true) {
      additionalPropertiesType = typeBuilder.getPrimitiveType("any");
    } else if (additionalProperties === false) {
      additionalPropertiesType = undefined;
    } else {
      const additionalLoc = loc.push("additionalProperties");
      additionalPropertiesType = await toType(
        checkJSONSchema(additionalProperties, additionalLoc.cannonicalRef),
        additionalLoc,
        singularizeTypeNames(attributes)
      );
    }
    const additionalRequired = setSubtract(required, props.keys());
    if (additionalRequired.size) {
      const t = additionalPropertiesType;
      if (!t) return messageError("SchemaAdditionTypesForbidRequired", withRef(loc));
      const additionalProps = mapFromIterable(additionalRequired, (name) => typeBuilder.makeClassProperty(t, false));
      mapMergeInto(props, additionalProps);
    }
    return typeBuilder.getUniqueObjectType(attributes, props, additionalPropertiesType);
  }
  async function convertToType(schema: StringMap, loc: Location, typeAttributes: TypeAttributes): Promise<TypeRef> {
    const enumArray = Array.isArray(schema.enum) ? schema.enum : undefined;
    const typeSet = definedMap(schema.type, (t) => checkTypeList(t, loc));
    function isTypeIncludeed(name: JSONSchemaType): boolean {
      if (typeSet && !typeSet.has(name)) return false;
      if (enumArray) {
        let predicate: (x: any) => boolean;
        switch (name) {
          case "null":
            predicate = (x: any) => x === null;
            break;
          case "integer":
            predicate = (x: any) => typeof x === "number" && x === Math.floor(x);
            break;
          default:
            predicate = (x: any) => typeof x === name;
            break;
        }
        return enumArray.find(predicate) !== undefined;
      }
      return true;
    }
    const includedTypes = setFilter(schemaTypes, isTypeIncludeed);
    let producerAttributesForNoCases: JSONSchemaAttributes[] | undefined = undefined;
    function forEachProducerAttribute(
      cases: JSONSchema[] | undefined,
      f: (attributes: JSONSchemaAttributes) => void
    ): void {
      let attributes: JSONSchemaAttributes[];
      if (!cases && producerAttributesForNoCases) {
        attributes = producerAttributesForNoCases;
      } else {
        attributes = [];
        for (const producer of attributeProducer) {
          const newAttributes = producer(schema, loc.cannonicalRef, includedTypes, cases);
          if (!newAttributes) continue;
          attributes.push(newAttributes);
        }
        if (!cases) producerAttributesForNoCases = attributes;
      }
      for (const a of attributes) {
        f(a);
      }
    }

    function combineProducerAttributes(
      f: (attributes: JSONSchemaAttributes) => TypeAttributes | undefined
    ): TypeAttributes {
      let result = emptyTypeAttributes;
      forEachProducerAttribute(undefined, (attr) => {
        const maybe = f(attr);
        if (!maybe) return;
        result = combineTypeAttributes("union", result, maybe);
      });
      return result;
    }

    function makeAttributes(attributes: TypeAttributes): TypeAttributes {
      if (schema.oneOf === undefined) {
        attributes = combineTypeAttributes(
          "union",
          attributes,
          combineProducerAttributes(({ forType, forUnion, forCases }) => {
            assert(!forUnion && !forCases, "We can't have attributes for unions and cases if we dont't have a union");
            return forType;
          })
        );
      }
      return modifyTypeNames(attributes, (maybe) => {
        const typeNames = defined(maybe);
        if (!typeNames.areInferred) return typeNames;
        let title = schema.title;
        if (typeof title !== "string") title = loc.cannonicalRef.definitionName;
        if (typeof title === "string") return TypeNames.make(new Set([title]), new Set(), !!schema.$ref);
        return typeNames.makeInferred();
      });
    }
    typeAttributes = makeAttributes(typeAttributes);
    const inferredAttributes = makeTypeAttributesInferred(typeAttributes);
    function makeStringType(attributes: TypeAttributes): TypeRef {
      const kind = typeKindForJSONSchemaFormat(schema.format);
      if (!kind) return typeBuilder.getStringType(attributes, StringTypes.unrestricted);
      return typeBuilder.getPrimitiveType(kind, attributes);
    }
    async function makeArrayType(): Promise<TypeRef> {
      const singularAttributes = singularizeTypeNames(typeAttributes);
      const items = schema.items;
      let itemType: TypeRef;
      if (Array.isArray(items)) {
        const itemsLoc = loc.push("items");
        const itemTypes = await arrayMapSync(items, async (item, i) => {
          const itemLoc = itemsLoc.push(i.toString());
          return await toType(checkJSONSchema(item, itemLoc.cannonicalRef), itemLoc, singularAttributes);
        });
        itemType = typeBuilder.getUnionType(emptyTypeAttributes, new Set(itemTypes));
      } else if (typeof items === "object") {
        const itemLoc = loc.push("items");
        itemType = await toType(checkJSONSchema(items, itemLoc.cannonicalRef), itemLoc, singularAttributes);
      } else if (items) {
        return messageError("SchemaTypeMustBeStringOrStringArray", withRef(loc, { actual: items }));
      } else {
        itemType = typeBuilder.getPrimitiveType("any");
      }
      typeBuilder.addAttributes(itemType, singularAttributes);
      return typeBuilder.getArrayType(emptyTypeAttributes, itemType);
    }
    async function makeObjectType(): Promise<TypeRef> {
      let required: string[], properties: StringMap;
      if (!schema.required || typeof schema.required === "boolean") required = [];
      else required = Array.from(checkRequiredArray(schema.required, loc));
      properties = schema.properties ? checkJSONSchemaObject(schema.properties, loc.cannonicalRef) : {};
      for (const p of Object.getOwnPropertyNames(properties)) {
        if (properties[p].required && required.includes(p)) {
          required.push(p);
        }
      }
      let additionalProperties = schema.additionalProperties;
      if (
        !additionalProperties &&
        typeof schema.patternProperties === "object" &&
        hasOwnProperty(schema.patternProperties, ".*")
      ) {
        additionalProperties = schema.patternProperties[".*"];
      }
      const objectAttributes = combineTypeAttributes(
        "union",
        inferredAttributes,
        combineProducerAttributes(({ forObject }) => forObject)
      );
      const order = schema.quicktypePropertyOrder || [];
      const orderKey = (propertyName: string) => {
        const index = order.indexOf(propertyName);
        return index !== -1 ? index : propertyName.toLowerCase();
      };
      return await makeObject(loc, objectAttributes, properties, required, additionalProperties, orderKey);
    }
    async function makeTypesFromCases(cases: any, kind: string): Promise<TypeRef[]> {
      const kindLoc = loc.push(kind);
      if (!Array.isArray(cases))
        return messageError("SchemaSetOperationCasesIsNotArray", withRef(kindLoc, { operation: kind, cases }));
      return await arrayMapSync(cases, async (t, index) => {
        const caseLoc = kindLoc.push(index.toString());
        return await toType(
          checkJSONSchema(t, caseLoc.cannonicalRef),
          caseLoc,
          makeTypeAttributesInferred(typeAttributes)
        );
      });
    }
    const intersectionType = typeBuilder.getUniqueIntersectionType(typeAttributes, undefined);
    setTypeForLocation(loc, intersectionType);
    async function convertOneOrAnyOf(cases: any, kind: string): Promise<TypeRef> {
      const typeRefs = await makeTypesFromCases(cases, kind);
      let unionAttributes = makeTypeAttributesInferred(typeAttributes);
      if (kind === "oneOf") {
        forEachProducerAttribute(cases as JSONSchema[], ({ forType, forUnion, forCases }) => {
          if (forType) typeBuilder.addAttributes(intersectionType, forType);
          if (forUnion) unionAttributes = combineTypeAttributes("union", unionAttributes, forUnion);
          if (forCases) {
            assert(forCases.length === typeRefs.length);
            for (let i = 0; i < typeRefs.length; i++) {
              typeBuilder.addAttributes(typeRefs[i], forCases[i]);
            }
          }
        });
      }
      const unionType = typeBuilder.getUniqueUnionType(unionAttributes, undefined);
      typeBuilder.setSetOperationMembers(unionType, new Set(typeRefs));
      return unionType;
    }
    const includeObject = !enumArray && (!typeSet || typeSet.has("object"));
    const includeArray = !enumArray && (!typeSet || typeSet.has("array"));
    const needStringEnum =
      includedTypes.has("string") && enumArray && enumArray.find((x: any) => typeof x === "string");
    const needUnion = !(
      !typeSet ||
      !schema.properties ||
      !schema.additionalProperties ||
      !schema.items ||
      !schema.required ||
      !enumArray
    );
    const types: TypeRef[] = [];
    if (needUnion) {
      const unionTypes: TypeRef[] = [];
      const numberAttributes = combineProducerAttributes(({ forNumber }) => forNumber);
      let _types = [
        ["null", "null"],
        ["number", "number"],
        ["integer", "integer"],
        ["boolean", "bool"],
      ] as [JSONSchemaType, PrimitiveTypeKind][];
      for (const [name, kind] of _types) {
        if (!includedTypes.has(name)) continue;
        const attributes = isNumberTypeKind(kind) ? numberAttributes : undefined;
        unionTypes.push(typeBuilder.getPrimitiveType(kind, attributes));
      }
      const stringAttributes = combineTypeAttributes(
        "union",
        inferredAttributes,
        combineProducerAttributes(({ forString }) => forString)
      );
      if (needStringEnum) {
        const cases = (enumArray as any[]).filter((x) => typeof x === "string") as string[];
        unionTypes.push(typeBuilder.getStringType(stringAttributes, StringTypes.fromCases(cases)));
      } else if (includedTypes.has("string")) {
        unionTypes.push(makeStringType(stringAttributes));
      }
      if (includeArray) unionTypes.push(await makeArrayType());
      if (includeObject) unionTypes.push(await makeObjectType());
      types.push(typeBuilder.getUniqueUnionType(inferredAttributes, new Set(unionTypes)));
    }
    if (schema.$ref) {
      if (typeof schema.$ref !== "string")
        return messageError("SchemaRefMustBeString", withRef(loc, { actual: typeof schema.$ref }));
      const virtualRef = Ref.parse(schema.$ref);
      const [target, newLoc] = await resolver.resolveVirtualRef(loc, virtualRef);
      const attributes = modifyTypeNames(typeAttributes, (tn) => {
        if (!defined(tn).areInferred) return tn;
        return TypeNames.make(new Set([newLoc.cannonicalRef.name]), new Set(), true);
      });
      types.push(await toType(target, newLoc, attributes));
    }
    if (schema.allOf) types.push(...(await makeTypesFromCases(schema.allOf, "allOf")));
    if (schema.onfOf) types.push(await convertOneOrAnyOf(schema.oneOf, "oneOf"));
    if (schema.anyOf) types.push(await convertOneOrAnyOf(schema.anyOf, "anyOf"));
    typeBuilder.setSetOperationMembers(intersectionType, new Set(types));
    return intersectionType;
  }
  async function toType(schema: JSONSchema, loc: Location, typeAttributes: TypeAttributes): Promise<TypeRef> {
    const maybe = typeForCanonicalRef.get(loc.cannonicalRef);
    if (maybe) return maybe;
    let result: TypeRef;
    if (typeof schema === "boolean") {
      messageAssert(schema === true, "SchemaFalseNotSupported", withRef(loc));
      result = typeBuilder.getPrimitiveType("any");
    } else {
      loc = loc.updateWithID(schema["$id"]);
      result = await convertToType(schema, loc, typeAttributes);
    }
    setTypeForLocation(loc, result);
    return result;
  }
  for (const [topLevelName, topLevelRef] of references) {
    const [target, loc] = await resolver.resolveTopLevelRef(topLevelRef);
    const t = await toType(target, loc, makeNamesTypeAttributes(topLevelName, false));
    typeBuilder.addTopLevel(topLevelName, t);
  }
}

function removeExtension(fn: string): string {
  const lower = fn.toLowerCase();
  const exts = [".json", ".schema"];
  for (const ext of exts) {
    if (lower.endsWith(ext)) {
      const base = fn.substr(0, fn.length - ext.length);
      if (base.length) return base;
    }
  }
  return fn;
}

function nameFromURI(uri: URI): string | undefined {
  const fragment = uri.fragment();
  if (fragment) {
    const components = fragment.split("/");
    const len = components.length;
    if (components[len - 1]) return removeExtension(components[len - 1]);
    if (len > 1 && components[len - 2]) return removeExtension(components[len - 2]);
  }
  const filenmae = uri.filename();
  if (filenmae) return removeExtension(filenmae);
  return messageError("DriverCannotInferNameForSchema", { uri: uri.toString() });
}

async function refsInSchemaForURI(
  resolver: Resolver,
  uri: URI,
  defaultName: string
): Promise<ReadonlyMap<string, Ref> | [string, Ref]> {
  const fragment = uri.fragment();
  let propertiesAreTypes = fragment.endsWith("/");
  if (propertiesAreTypes) uri = uri.clone().fragment(fragment.substr(0, fragment.length - 1));
  const ref = Ref.parseURI(uri);
  if (ref.isRoot) propertiesAreTypes = false;
  const schema = (await resolver.resolveTopLevelRef(ref))[0];
  if (propertiesAreTypes) {
    if (typeof schema !== "object") return messageError("SchemaCannotGetTypesFromBoolean", { ref: ref.toString() });
    return mapMap(mapFromObject(schema), (_, name) => ref.push(name));
  } else {
    let name: string;
    if (typeof schema === "object" && typeof schema.title === "string") name = schema.title;
    else name = nameFromURI(uri) || defaultName;
    return [name, ref];
  }
}

class InputJSONSchemaStore extends JSONSchemaStore {
  constructor(private readonly inputs: Map<string, string>, private readonly delegate?: JSONSchemaStore) {
    super();
  }
  async fetch(address: string): Promise<JSONSchema | undefined> {
    const maybe = this.inputs.get(address);
    if (maybe) return checkJSONSchema(parseJSON(maybe, "JSON Schema", address), () => Ref.root(address));
    if (!this.delegate) return panic(`Schema URI ${address} requested, but no store given`);
    return await this.delegate.fetch(address);
  }
}

export interface JSONSchemaSourceData {
  name: string;
  uris?: string[];
  schema?: string;
  isConverted: boolean;
}
export class JSONSchemaInput implements Input<JSONSchemaSourceData> {
  readonly kind: string = "schema";
  readonly needSchemaProcessing: boolean = true;
  readonly #attributeProducers: JSONSchemaAttributeProducer[] = [];
  readonly #schemaInputs: Map<string, string> = new Map();
  readonly #schemaSources: [URI, JSONSchemaSourceData][] = [];
  readonly #topLevels: Map<string, Ref> = new Map();
  #needIR: boolean = false;
  constructor(
    private schemaStore: JSONSchemaStore | undefined,
    additionalAttributeProducers: JSONSchemaAttributeProducer[] = [],
    private readonly additionalSchemaAddresses: ReadonlyArray<string> = []
  ) {
    this.#attributeProducers = [
      descriptionAttributeProducer,
      accessorNamesAttributeProducer,
      enumValuesAttributeProducer,
      uriSchemaAttributesProducer,
      minMaxAttributeProducer,
      minMaxLengthAttributeProducer,
      patternAttributeProducer,
    ].concat(additionalAttributeProducers);
  }
  get needIR(): boolean {
    return this.needIR;
  }
  addTopLevel(name: string, ref: Ref): void {
    this.#topLevels.set(name, ref);
  }
  async addTypes(ctx: RunContext, typeBuilder: TypeBuilder): Promise<void> {
    if (!this.#schemaSources.length) return;
    let maybeSchemaStore = this.schemaStore;
    if (!this.#schemaInputs.size) {
      if (!maybeSchemaStore) return panic("Must have a schema store to process JSON schema");
    } else {
      maybeSchemaStore = this.schemaStore = new InputJSONSchemaStore(this.#schemaInputs, maybeSchemaStore);
    }
    const schemaStore = maybeSchemaStore;
    const canonizer = new Canonizer(ctx);

    for (const address of this.additionalSchemaAddresses) {
      const schema = await schemaStore.get(address, ctx.debugPringSchemaResolving);
      if (!schema) return messageError("SchemaFetchErrorAdditional", { address });
      canonizer.addSchema(schema, address);
    }
    const resolver = new Resolver(ctx, defined(this.schemaStore), canonizer);
    for (const [normalizeURI, source] of this.#schemaSources) {
      const givenName = source.name;
      const refs = await refsInSchemaForURI(resolver, normalizeURI, givenName);
      if (Array.isArray(refs)) {
        let name: string;
        if (this.#schemaSources.length === 1) name = givenName;
        else name = refs[0];
        this.addTopLevel(name, refs[1]);
      } else {
        for (const [refName, ref] of refs) {
          this.addTopLevel(refName, ref);
        }
      }
    }
    await addTypesInSchema(resolver, typeBuilder, this.#topLevels, this.#attributeProducers);
  }
  addTypesSync(): void {
    return panic("addTypesSync not supported in JSONSchemaInput");
  }
  async addSource(schemaSource: JSONSchemaSourceData): Promise<void> {
    return this.addSourceSync(schemaSource);
  }
  addSourceSync(schemaSource: JSONSchemaSourceData): void {
    const { name, uris, schema, isConverted } = schemaSource;
    if (isConverted) this.#needIR = true;
    let normalizedURIs: URI[];
    if (uris) {
      normalizedURIs = uris.map((uri) => {
        const normalizedURI = normalizeURI(uri);
        if (normalizedURI.clone().hash("").toString()) {
          normalizedURI.path(name);
        }
        return normalizedURI;
      });
    } else {
      normalizedURIs = [new URI(name)];
    }
    if (schema) {
      for (let i = 0; i < normalizedURIs.length; i++) {
        const normalizedURI = normalizedURIs[i];
        const uri = normalizedURI.clone().hash("");
        const path = uri.path();
        let suffix = 0;
        do {
          if (suffix > 0) uri.path(`${path}-${suffix}`);
          suffix++;
        } while (this.#schemaInputs.has(uri.toString()));
        this.#schemaInputs.set(uri.toString(), schema);
        normalizedURIs[i] = uri.hash(normalizedURI.hash());
      }
    } else {
      assert(!!uris, "URIs must be given if shcema source is not specified");
    }
    for (const normalizeURI of normalizedURIs) {
      this.#schemaSources.push([normalizeURI, schemaSource]);
    }
  }
  singleStringSchemaSource(): string | undefined {
    if (!this.#schemaSources.every(([_, { schema }]) => typeof schema === "string")) return undefined;
    const set = new Set(this.#schemaSources.map(([_, { schema }]) => schema as string));
    if (set.size === 1) return defined(iterableFirst(set));
    return;
  }
}
