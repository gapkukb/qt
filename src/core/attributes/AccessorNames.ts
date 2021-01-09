import {
  iterableFirst,
  mapFromIterable,
  mapFromObject,
  mapMap,
  mapMergeInto,
  setUnionManyInto,
} from "collection-utils";
import { JSONSchemaAttributes, JSONSchemaType, Ref } from "../input/JSONSchemaInput";
import { JSONSchema } from "../input/JSONSchemaStore";
import { messageAssert } from "../Message";
import { checkArray, checkStringMap, defined, isStringMap } from "../support";
import { EnumType, ObjectType, Type, UnionType } from "../Type";
import { TypeAttributeKind, TypeAttributes } from "./TypeAttributes";

export type AccessorEntry = string | Map<string, string>;
export type AccessorNames = Map<string, AccessorEntry>;
class AccessorNamesTypeAttributeKind extends TypeAttributeKind<AccessorNames> {
  constructor() {
    super("accessorNames");
  }
  makeInferred(_: AccessorNames) {
    return undefined;
  }
}
export const accessorNamesTypeAttributeKind: TypeAttributeKind<AccessorNames> = new AccessorNamesTypeAttributeKind();
function getFromEntry(entry: AccessorEntry, language: string): [string, boolean] | undefined {
  if (typeof entry === "string") return [entry, false];
  let maybe = entry.get(language);
  if (maybe) return [maybe, true];
  maybe = entry.get("*");
  if (maybe) return [maybe, false];
}

export function lookupKey(accessors: AccessorNames, key: string, language: string): [string, boolean] | undefined {
  const entry = accessors.get(key);
  if (!entry) return;
  return getFromEntry(entry, language);
}

export function objectPropertyNames(o: ObjectType, language: string): Map<string, [string, boolean] | undefined> {
  const accessors = accessorNamesTypeAttributeKind.tryGetInAttributes(o.getAttributes());
  const map = o.getProperties();
  if (accessors === undefined) return mapMap(map, (_) => undefined) as any;
  return mapMap(map, (cp, n) => lookupKey(accessors, n, language)) as any;
}

export function enumCaseNames(e: EnumType, language: string): Map<string, [string, boolean] | undefined> {
  const accessors = accessorNamesTypeAttributeKind.tryGetInAttributes(e.getAttributes());
  if (!accessors) return mapMap(e.cases.entries(), (_) => undefined);
  return mapMap(e.cases.entries(), (c) => lookupKey(accessors, c, language));
}

export function getAccessorName(
  names: Map<string, [string, boolean] | undefined>,
  original: string
): [string | undefined, boolean] {
  const maybe = names.get(original);
  if (!maybe) return [undefined, false];
  return maybe;
}

class UnionIdentifierTypeAttributeKind extends TypeAttributeKind<ReadonlySet<number>> {
  constructor() {
    super("unionIdentifier");
  }
  combine(arr: ReadonlySet<number>[]): ReadonlySet<number> {
    return setUnionManyInto(new Set(), arr);
  }
  makeInferred(_: ReadonlySet<number>): ReadonlySet<number> {
    return new Set();
  }
}

export const unionIdentifierTypeAttributeKind: TypeAttributeKind<
  ReadonlySet<number>
> = new UnionIdentifierTypeAttributeKind();
let nextUnionIdentifier: number = 0;
export function makeUnionIdentifierAttribute(): TypeAttributes {
  const attributes = unionIdentifierTypeAttributeKind.makeAttributes(new Set([nextUnionIdentifier]));
  nextUnionIdentifier++;
  return attributes;
}

class UnionMemberNamesTypeAttributeKind extends TypeAttributeKind<Map<number, AccessorEntry>> {
  constructor() {
    super("unionMemberNames");
  }
  combine(arr: Map<number, AccessorEntry>[]): Map<number, AccessorEntry> {
    const result = new Map<number, AccessorEntry>();
    for (const m of arr) {
      mapMergeInto(result, m);
    }
    return result;
  }
}

export const unionMemberNamesTypeAttributeKind: TypeAttributeKind<
  Map<number, AccessorEntry>
> = new UnionMemberNamesTypeAttributeKind();

export function makeUnionMemberNamesAttribute(unionAttributes: TypeAttributes, entry: AccessorEntry): TypeAttributes {
  const identifiers = defined(unionIdentifierTypeAttributeKind.tryGetInAttributes(unionAttributes));
  const map = mapFromIterable(identifiers, (_) => entry);
  return unionMemberNamesTypeAttributeKind.makeAttributes(map);
}

export function unionMemberName(u: UnionType, member: Type, language: string): [string | undefined, boolean] {
  const identifiers = unionIdentifierTypeAttributeKind.tryGetInAttributes(u.getAttributes());
  if (!identifiers) return [undefined, false];
  const memberNames = unionMemberNamesTypeAttributeKind.tryGetInAttributes(member.getAttributes());
  if (!memberNames) return [undefined, false];
  const names = new Set<string>();
  const fixedNames = new Set<string>();
  for (const i of identifiers) {
    let maybe = memberNames.get(i);
    if (!maybe) continue;
    let maybe2 = getFromEntry(maybe, language);
    if (!maybe2) continue;
    const [name, isNameFixed] = maybe2;
    isNameFixed ? fixedNames.add(name) : names.add(name);
  }
  let size: number,
    isFixed: boolean,
    first = iterableFirst(fixedNames);

  if (first) {
    size = fixedNames.size;
    isFixed = true;
  } else {
    first = iterableFirst(names);
    if (!first) return [undefined, false];
    size = names.size;
    isFixed = false;
  }
  messageAssert(size === 1, "SchemaMoreThanOneUnionMemberName", { names: Array.from(names) });
  return [first, isFixed];
}

function isAccessorEntry(x: any): x is string | Record<string, string> {
  if (typeof x === "string") return true;
  return isStringMap(x, (v: any): v is string => typeof v === "string");
}

function makeAccessorEntry(ae: string | Record<string, string>): AccessorEntry {
  if (typeof ae === "string") return ae;
  return mapFromObject(ae);
}

export function makeAccessorNames(x: any): AccessorNames {
  const stringMap = checkStringMap(x, isAccessorEntry);
  return mapMap(mapFromObject(stringMap), makeAccessorEntry);
}

export function accessorNamesAttributeProducer(
  schema: JSONSchema,
  canonicalRef: Ref,
  types: Set<JSONSchemaType>,
  cases: JSONSchema[] | undefined
): JSONSchemaAttributes | undefined {
  if (typeof schema !== "object") return;
  const maybe = schema["qt-accessors"];
  if (!maybe) return;
  if (!cases) return { forType: accessorNamesTypeAttributeKind.makeAttributes(makeAccessorNames(maybe)) };
  else {
    const identifierAttribute = makeUnionIdentifierAttribute();
    const accessors = checkArray(maybe, isAccessorEntry);
    messageAssert(cases.length === accessors.length, "SchemaWrongAccessorEntryArrayLength", {
      operation: "oneOf",
      ref: canonicalRef.push("oneOf"),
    });
    const caseAttributes = accessors.map((accessor) =>
      makeUnionMemberNamesAttribute(identifierAttribute, makeAccessorEntry(accessor))
    );
    return { forUnion: identifierAttribute, forCases: caseAttributes };
  }
}
