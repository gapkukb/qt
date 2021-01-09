import { hashString, mapFilter, mapFilterMap, mapTranspose } from "collection-utils";
import { BaseGraphRewriteBuilder } from "../GraphRewriting";
import { assert, panic } from "../support";
import { Type, TypeKind } from "../Type";

export class TypeAttributeKind<T> {
  constructor(readonly name: string) {}
  appliesToTypeKind(kind: TypeKind): boolean {
    return kind !== "any";
  }
  combine(attrs: T[]): T | undefined {
    return panic("Cannot combine type attribute " + this.name);
  }
  intersect(attrs: T[]): T | undefined {
    return this.combine(attrs);
  }
  makeInferred(_: T): T | undefined {
    return panic(`Cannot make type attribute ${this.name} inferred`);
  }
  increaseDistance(attrs: T): T | undefined {
    return attrs;
  }
  addToSchema(schema: Record<string, unknown>, t: Type, attrs: T): void {
    return;
  }
  children(_: T): ReadonlySet<Type> {
    return new Set();
  }
  stringify(_: T): string | undefined {
    return undefined;
  }
  get inIndentity(): boolean {
    return false;
  }
  requireUniqueIdentity(_: T): boolean {
    return false;
  }
  reconstitute<TBuilder extends BaseGraphRewriteBuilder>(builder: TBuilder, a: T): T {
    return a;
  }
  makeAttributes(value: T): TypeAttributes {
    const kvps: [this, T][] = [[this, value]];
    return new Map(kvps);
  }
  tryGetInAttributes(a: TypeAttributes): T | undefined {
    return a.get(this);
  }
  private setInAttributes(a: TypeAttributes, value: T): TypeAttributes {
    return new Map(a).set(this, value);
  }
  modifyInAttributes(a: TypeAttributes, modify: (value: T | undefined) => T | undefined): TypeAttributes {
    const modified = modify(this.tryGetInAttributes(a));
    if (!modified) {
      const result = new Map(a);
      result.delete(this);
      return result;
    }
    return this.setInAttributes(a, modified);
  }
  setDefaultInAttributes(a: TypeAttributes, makeDefault: () => T): TypeAttributes {
    if (this.tryGetInAttributes(a)) return a;
    return this.modifyInAttributes(a, makeDefault);
  }
  removeInAttributes(a: TypeAttributes): TypeAttributes {
    return mapFilter(a, (_, k) => k !== this);
  }
  equals(other: any): boolean {
    if (!(other instanceof TypeAttributeKind)) return false;
    return this.name === other.name;
  }
  hashCode(): number {
    return hashString(this.name);
  }
}

export type TypeAttributes = ReadonlyMap<TypeAttributeKind<any>, any>;
export const emptyTypeAttributes: TypeAttributes = new Map();
export type CombinationKind = "union" | "intersect";
export function combineTypeAttributes(kind: CombinationKind, attributes: TypeAttributes[]): TypeAttributes;
export function combineTypeAttributes(kind: CombinationKind, a: TypeAttributes, b: TypeAttributes): TypeAttributes;
export function combineTypeAttributes(
  combinationKind: CombinationKind,
  firstOrArray: TypeAttributes[] | TypeAttributes,
  second?: TypeAttributes
): TypeAttributes {
  const union = (combinationKind = "union");
  let attributesArray: TypeAttributes[];
  if (Array.isArray(firstOrArray)) {
    attributesArray = firstOrArray;
  } else {
    if (!second) return panic("Must have no array or two attributes");
    attributesArray = [firstOrArray, second];
  }
  const attributesByKind = mapTranspose(attributesArray);
  function combine(attrs: any[], kind: TypeAttributeKind<any>): any {
    assert(attrs.length > 0, "Cannot combine zero type attributes");
    if (attrs.length === 1) return attrs[0];
    if (union) return kind.combine(attrs);
    return kind.intersect(attrs);
  }
  return mapFilterMap(attributesByKind, combine);
}

export function makeTypeAttributesInferred(attr: TypeAttributes): TypeAttributes {
  return mapFilterMap(attr, (value, kind) => kind.makeInferred(value));
}

export function increaseTypeAttributesDistance(attr: TypeAttributes): TypeAttributes {
  return mapFilterMap(attr, (value, kind) => kind.increaseDistance(value));
}
