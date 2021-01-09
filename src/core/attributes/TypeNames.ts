import { definedMap, iterableFirst, iterableSkip, setMap, setUnionInto } from "collection-utils";
import { assert, defined, panic } from "../support";
import { Chance } from "../support/Chance";
import { splitIntoWords } from "../support/Strings";
import * as pluralize from "pluralize";
import { TypeAttributeKind, TypeAttributes } from "./TypeAttributes";

let chance: Chance, usedRandomNames: Set<string>;

export function initTypeNames(): void {
  chance = new Chance(31415);
  usedRandomNames = new Set();
}

initTypeNames();

function makeRandomName(): string {
  while (true) {
    const name = `${chance.city()}${chance.animal()}`;
    if (usedRandomNames.has(name)) continue;
    usedRandomNames.add(name);
    return name;
  }
}

export type NameOrNames = string | TypeNames;

function combineNames(names: ReadonlySet<string>): string {
  let originalFirst = iterableFirst(names);
  if (!originalFirst) return panic("Named type has no names");
  if (names.size === 1) return originalFirst;
  const namesSet = setMap(names, (s) =>
    splitIntoWords(s)
      .map((w) => w.word.toLowerCase())
      .join("_")
  );
  const first = defined(iterableFirst(namesSet));
  if (namesSet.size === 1) return first;
  let prefixLength = first.length,
    suffixLength = prefixLength;
  for (const n of iterableSkip(namesSet, 1)) {
    prefixLength = Math.min(prefixLength, n.length);
    for (let i = 0; i < prefixLength; i++) {
      if (first[i] !== n[i]) {
        prefixLength = i;
        break;
      }
    }
    suffixLength = Math.min(suffixLength, n.length);
    for (let i = 0; i < suffixLength; i++) {
      if (first[first.length - i - 1] !== n[n.length - i - 1]) {
        suffixLength = i;
        break;
      }
    }
  }
  const prefix = prefixLength > 2 ? first.substr(0, prefixLength) : "";
  const suffix = suffixLength > 2 ? first.substr(first.length - suffixLength) : "";
  const combined = prefix + suffix;
  if (combined.length > 2) return combined;
  return first;
}

export const tooManyNamesThreshold = 1000;

export abstract class TypeNames {
  abstract get names(): ReadonlySet<string>;
  abstract get combinedName(): string;
  abstract get proposedNames(): ReadonlySet<string>;
  abstract add(names: TypeNames[], startIndex?: number): TypeNames;
  abstract clearInferred(): TypeNames;
  abstract makeInferred(): TypeNames;
  abstract singularize(): TypeNames;
  abstract toString(): string;
  get areInferred(): boolean {
    return this.distance > 0;
  }

  static makeWithDistance(
    names: ReadonlySet<string>,
    alternativeNames: ReadonlySet<string> | undefined,
    distance: number
  ): TypeNames {
    if (names.size >= tooManyNamesThreshold) return new TooManyTypeNames(distance);
    if (!alternativeNames || alternativeNames.size > tooManyNamesThreshold) alternativeNames = undefined;
    return new RegularTypeNames(names, alternativeNames, distance);
  }
  static make(
    names: ReadonlySet<string>,
    alternativeNames: ReadonlySet<string> | undefined,
    areInferred: boolean
  ): TypeNames {
    return TypeNames.makeWithDistance(names, alternativeNames, areInferred ? 1 : 0);
  }
  constructor(readonly distance: number) {}
}

export class RegularTypeNames extends TypeNames {
  constructor(
    readonly names: ReadonlySet<string>,
    private readonly _alternativeNames: ReadonlySet<string> | undefined,
    distance: number
  ) {
    super(distance);
  }
  add(names: TypeNames[], startIndex: number = 0): TypeNames {
    let newNames = new Set(this.names),
      newDistance = this.distance,
      newAlternativeNames = definedMap(this._alternativeNames, (s) => new Set(s));
    for (let i = startIndex; i < names.length; i++) {
      const other = names[i];
      if (other instanceof RegularTypeNames && other._alternativeNames) {
        newAlternativeNames = newAlternativeNames || new Set();
        setUnionInto(newAlternativeNames, other._alternativeNames);
      }
      if (other.distance > newDistance) continue;
      if (!(other instanceof RegularTypeNames)) {
        assert(other instanceof TooManyTypeNames, "Unknown TypeNames instance");
        return other.add(names, i + 1);
      }
      if (other.distance < newDistance) {
        newNames = new Set(other.names);
        newDistance = other.distance;
        newAlternativeNames = definedMap(other._alternativeNames, (s) => new Set(s));
      } else {
        assert(other.distance === newDistance, "The should be the only case left");
        setUnionInto(newNames, other.names);
      }
    }
    return TypeNames.makeWithDistance(newNames, newAlternativeNames, newDistance);
  }

  clearInferred(): TypeNames {
    const newNames = this.areInferred ? new Set() : this.names;
    return TypeNames.makeWithDistance(newNames as any, new Set(), this.distance);
  }

  get combinedName(): string {
    return combineNames(this.names);
  }

  get proposedNames(): ReadonlySet<string> {
    const set = new Set([this.combinedName]);
    if (!this._alternativeNames) return set;
    setUnionInto(set, this._alternativeNames);
    return set;
  }

  makeInferred(): TypeNames {
    return TypeNames.makeWithDistance(this.names, this._alternativeNames, this.distance + 1);
  }

  singularize(): TypeNames {
    return TypeNames.makeWithDistance(
      setMap(this.names, pluralize.singular),
      definedMap(this._alternativeNames, (an) => setMap(an, pluralize.singular)),
      this.distance + 1
    );
  }

  toString(): string {
    const inferred = this.areInferred ? `distance ${this.distance}` : "given";
    const names = inferred + Array.from(this.names).join(",");
    if (!this._alternativeNames) return names;
    return names + Array.from(this._alternativeNames).join(",");
  }
}

export class TooManyTypeNames extends TypeNames {
  readonly names!: ReadonlySet<string>;
  constructor(distance: number, name?: string) {
    super(distance);
    if (name === undefined) name = makeRandomName();
    this.names = new Set([name]);
  }
  get combinedName(): string {
    return defined(iterableFirst(this.names));
  }
  get proposedNames(): ReadonlySet<string> {
    return this.names;
  }
  add(names: TypeNames[], startIndex: number = 0): TypeNames {
    if (!this.areInferred) return this;
    for (let i = startIndex; i < names.length; i++) {
      const item = names[i];
      if (item.distance < this.distance) return item.add(names, i + 1);
    }
    return this;
  }
  clearInferred(): TypeNames {
    if (!this.areInferred) return this;
    return TypeNames.makeWithDistance(new Set(), new Set(), this.distance);
  }
  makeInferred(): TypeNames {
    if (!this.areInferred) return this;
    return TypeNames.makeWithDistance(new Set(), new Set(), this.distance);
  }
  singularize(): TypeNames {
    return this;
  }
  toString(): string {
    return `too many ${this.combinedName}`;
  }
}

class TypeNamesTypeAttributeKind extends TypeAttributeKind<TypeNames> {
  constructor() {
    super("names");
  }
  combine(names: TypeNames[]): TypeNames {
    assert(names.length > 0, "Cannot combine zero type names");
    return names[0].add(names, 1);
  }
  makeInferred(tn: TypeNames): TypeNames {
    return tn.makeInferred();
  }
  increaseDistance(tn: TypeNames): TypeNames {
    return tn.makeInferred();
  }
  stringify(tn: TypeNames): string {
    return tn.toString();
  }
}
export const namesTypeAttributeKind: TypeAttributeKind<TypeNames> = new TypeNamesTypeAttributeKind();
export function modifyTypeNames(
  attribtues: TypeAttributes,
  modifier: (tn: TypeNames | undefined) => TypeNames | undefined
): TypeAttributes {
  return namesTypeAttributeKind.modifyInAttributes(attribtues, modifier);
}

export function singularizeTypeNames(attribtues: TypeAttributes): TypeAttributes {
  return modifyTypeNames(attribtues, (maybe) => (maybe ? maybe.singularize() : undefined));
}

export function makeNamesTypeAttributes(nameOrNames: NameOrNames, areNamesInferred?: boolean): TypeAttributes {
  let typeNames: TypeNames;
  if (typeof nameOrNames === "string") {
    typeNames = TypeNames.make(new Set([nameOrNames]), new Set(), defined(areNamesInferred));
  } else {
    typeNames = nameOrNames as TypeNames;
  }
  return namesTypeAttributeKind.makeAttributes(typeNames);
}
