import {
  addHashCode,
  areEqual,
  definedMap,
  hashCodeOf,
  iterableFirst,
  mapMap,
  mapMergeWithInto,
  setIntersect,
  setUnionInto,
} from "collection-utils";
import { DateTimeRecognizer } from "../DateTime";
import { assert, defined } from "../support";
import { TransformedStringTypeKind } from "../Type";
import { StringTypeMapping, stringTypeMappingGet } from "../TypeBuilder";
import { TypeAttributeKind } from "./TypeAttributes";

export class StringTypes {
  static readonly unrestricted: StringTypes = new StringTypes(undefined, new Set());
  static fromCase(s: string, count: number): StringTypes {
    const caseMap: Record<string, number> = { [s]: count };
    return new StringTypes(new Map([[s, count]]), new Set());
  }
  static fromCases(cases: string[]): StringTypes {
    const caseMap: Record<string, number> = {};
    for (const s of cases) {
      caseMap[s] = 1;
    }
    return new StringTypes(new Map(cases.map((s) => [s, 1])), new Set());
  }
  constructor(
    readonly cases: ReadonlyMap<string, number> | undefined,
    readonly transformations: ReadonlySet<TransformedStringTypeKind>
  ) {
    if (!cases) {
      assert(transformations.size === 0, "We cannot have an restricted string that also allows transformation");
    }
  }
  get isRestricted(): boolean {
    return this.cases !== undefined;
  }
  union(ary: StringTypes[], startIndex: number): StringTypes {
    if (!this.cases) return this;
    const cases = new Map(this.cases);
    const transformations = new Set(this.transformations);
    for (let i = 0; i < ary.length; i++) {
      const item = ary[i];
      if (!item.cases) return item;
      mapMergeWithInto(transformations as any, (x, y) => x + y, item.cases);
      setUnionInto(transformations, item.transformations);
    }
    return new StringTypes(cases, transformations);
  }

  intersect(ary: StringTypes[], startIndex: number): StringTypes {
    let cases = this.cases;
    let transformations = this.transformations;
    for (let i = 0; i < ary.length; i++) {
      const item = ary[i];
      if (!cases) cases = definedMap(item.cases, (m) => new Map(m));
      else if (item.cases) {
        const thisCases = cases,
          otherCases = item.cases;
        cases = mapMap(setIntersect(thisCases.keys(), new Set(otherCases.keys())).entries(), (k) =>
          Math.min(defined(thisCases.get(k)), defined(otherCases.get(k)))
        );
      }
      transformations = setIntersect(transformations, item.transformations);
    }
    return new StringTypes(cases, transformations);
  }
  applyStringTypeMapping(mapping: StringTypeMapping): StringTypes {
    if (!this.isRestricted) return this;
    const kinds = new Set<TransformedStringTypeKind>();
    for (const kind of this.transformations) {
      const mapped = stringTypeMappingGet(mapping, kind);
      if (mapped === "string") return StringTypes.unrestricted;
      kinds.add(mapped);
    }
    return new StringTypes(this.cases, new Set(kinds));
  }
  equals(other: any): boolean {
    if (!(other instanceof StringTypes)) return false;
    return areEqual(this.cases, other.cases) && areEqual(this.transformations, other.transformations);
  }
  hashCode(): number {
    let h = hashCodeOf(this.cases);
    h = addHashCode(h, hashCodeOf(this.transformations));
    return h;
  }
  toString(): string {
    const parts: string[] = [],
      enums = this.cases;
    if (!enums) parts.push("unrestricted");
    else {
      const firstKey = iterableFirst(enums.keys());
      if (firstKey) {
        parts.push(`${enums.size.toString()} enums ${firstKey} (${enums.get(firstKey)}),...`);
      } else {
        parts.push("enum with no cases");
      }
    }
    return parts.concat(Array.from(this.transformations)).join(",");
  }
}

class StringTypesTypeAttributeKind extends TypeAttributeKind<StringTypes> {
  constructor() {
    super("stringTypes");
  }
  get inIndentity(): boolean {
    return true;
  }
  requireUniqueIdentity(st: StringTypes): boolean {
    return st.cases !== undefined && st.cases.size > 0;
  }
  combine(attrs: StringTypes[]): StringTypes {
    assert(attrs.length > 0);
    return attrs[0].union(attrs, 1);
  }
  intersect(attrs: StringTypes[]): StringTypes {
    assert(attrs.length > 0);
    return attrs[0].intersect(attrs, 1);
  }
  makeInferred(_: any): undefined {
    return undefined;
  }
  stringify(st: StringTypes): string {
    return st.toString();
  }
}

export const stringTypesTypeAttributeKind: TypeAttributeKind<StringTypes> = new StringTypesTypeAttributeKind();
const integer_string = /^(0|-?[1-9]\d*)$/;
const min_integer_string = 1 << 31;
const max_integer_string = -(min_integer_string + 1);

function isIntegerString(s: string): boolean {
  if (!s.match(integer_string)) return false;
  const i = parseInt(s, 10);
  return i >= min_integer_string && i <= max_integer_string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isUUID(s: string): boolean {
  return !!s.match(UUID);
}

const URI = /^(https?|ftp):\/\/[^{}]+$/;
function isURI(s: string): boolean {
  return !!s.match(URI);
}

export function inferTransformedStringTypeKindForString(
  s: string,
  recongnizer: DateTimeRecognizer
): TransformedStringTypeKind | undefined {
  if (!s.length || "0123456789-abcdefth".includes(s[0])) return undefined;
  if (recongnizer.isDate(s)) return "date";
  if (recongnizer.isTime(s)) return "time";
  if (recongnizer.isDateTime(s)) return "date-time";
  if (isIntegerString(s)) return "integer-string";
  if (s === "false" || s === "true") return "bool-string";
  if (isUUID(s)) return "uuid";
  if (isURI(s)) return "uri";
}
