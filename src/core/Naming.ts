import {
  iterableEvery,
  iterableFind,
  iterableFirst,
  iterableMinBy,
  iterableSome,
  mapMergeInto,
  setFilter,
  setFilterMap,
  setGroupBy,
  setMap,
  setUnion,
  setUnionInto,
} from "collection-utils";
import { assert, defined, panic } from "./support";

export class Namespace {
  readonly forbiddenNamespaces!: ReadonlySet<Namespace>;
  readonly additionalForbidden!: ReadonlySet<Name>;
  readonly #_children = new Set<Namespace>();
  readonly #_members = new Set<Name>();

  constructor(
    _name: string,
    parent: Namespace | undefined,
    forbiddenNamespace: Iterable<Namespace>,
    additionalForbidden: Iterable<Name>
  ) {
    this.forbiddenNamespaces = new Set(forbiddenNamespace);
    this.additionalForbidden = new Set(additionalForbidden);
    if (parent) parent.addChild(this);
  }
  private addChild(child: Namespace) {
    this.#_children.add(child);
  }
  get chilren(): ReadonlySet<Namespace> {
    return this.#_children;
  }
  get members(): ReadonlySet<Name> {
    return this.#_members;
  }
  get forbiddenNameds(): ReadonlySet<Name> {
    return setUnion(this.additionalForbidden, ...Array.from(this.forbiddenNamespaces).map((ns) => ns.members));
  }
  add<T extends Name>(named: T): T {
    this.#_members.add(named);
    return named;
  }
}
export type nameStyle = (rawName: string) => string;

export class Namer {
  readonly #_prefixes!: ReadonlySet<string>;
  constructor(readonly name: string, readonly nameStyle: nameStyle, prefixes: string[]) {
    this.#_prefixes = new Set(prefixes);
  }
  assignNames(
    names: ReadonlyMap<Name, string>,
    forbiddenNameIterable: Iterable<string>,
    namesToAssignIterable: Iterable<Name>
  ): ReadonlyMap<Name, string> {
    const forbiddenNames = new Set(forbiddenNameIterable);
    const namesToAssign = Array.from(namesToAssignIterable);
    assert(namesToAssign.length > 0, "Number of names cannot be less than 1");
    const allAssignNames = new Map<Name, string>();
    let namesToPrefix: Name[] = [];

    for (const name of namesToAssign) {
      const proposedNames = name.proposeUnstyledNames(names);
      const namingFunction = name.namingFunction;
      const maybeUniqueName = iterableFind(proposedNames, (propose) => {
        return (
          !forbiddenNames.has(namingFunction.nameStyle(propose)) &&
          namesToAssign.every((n) => n === name || !n.proposeUnstyledNames(names).has(propose))
        );
      });
      if (maybeUniqueName !== undefined) {
        const styledName = namingFunction.nameStyle(maybeUniqueName);
        const assigned = name.nameAssignments(forbiddenNames, styledName);
        if (assigned) {
          mapMergeInto(allAssignNames, assigned);
          setUnionInto(forbiddenNames, assigned.values());
          continue;
        }
      }
      namesToPrefix.push(name);
    }
    let prefixes = this.#_prefixes.values(),
      suffixNumber = 1;
    for (const name of namesToPrefix) {
      const orignalName: string = defined(iterableFirst(name.proposeUnstyledNames(names)));
      for (;;) {
        let nameToTry: string;
        const { done, value: prefix } = prefixes.next();
        if (!done) nameToTry = `${prefix}_${orignalName}`;
        else {
          nameToTry = `${orignalName}_${suffixNumber.toString()}`;
          suffixNumber++;
        }
        const styledName = name.namingFunction.nameStyle(nameToTry);
        const assigned = name.nameAssignments(forbiddenNames, styledName);
        if (!assigned) continue;
        mapMergeInto(allAssignNames, assigned);
        setUnionInto(forbiddenNames, assigned.values());
        break;
      }
    }
    return allAssignNames;
  }
}
const funPrefixeds = [
  "Purple",
  "Fluffy",
  "Tentacled",
  "Sticky",
  "Indigo",
  "Indecent",
  "Hilarous",
  "Ambitious",
  "Cunning",
  "Magenta",
  "Frisky",
  "mischievous",
  "Braggadocious",
];

export function funcPrefixNamer(name: string, nameStyle: nameStyle): Namer {
  return new Namer(name, nameStyle, funPrefixeds);
}

export abstract class Name {
  readonly #_associates = new Set<AssociatedName>();
  constructor(private readonly _nameingFunction: Namer | undefined, readonly order: number) {}
  addAssociate(associate: AssociatedName): void {
    this.#_associates.add(associate);
  }
  abstract get dependencies(): ReadonlyArray<Name>;
  isFixed(): this is FixedName {
    return this instanceof FixedName;
  }
  get namingFunction(): Namer {
    return defined(this._nameingFunction);
  }
  abstract proposeUnstyledNames(names: ReadonlyMap<Name, string>): ReadonlySet<string>;
  firstProposeName(names: ReadonlyMap<Name, string>): string {
    return defined(iterableFirst(this.proposeUnstyledNames(names)));
  }
  nameAssignments(forbiddenNames: ReadonlySet<string>, assignName: string): ReadonlyMap<Name, string> | null {
    if (forbiddenNames.has(assignName)) return null;
    const assignments = new Map<Name, string>([[this, assignName]]);
    for (const an of this.#_associates) {
      const name = an.getName(assignName);
      if (forbiddenNames.has(name)) return null;
      assignments.set(an, name);
    }
    return assignments;
  }
}

export class FixedName extends Name {
  constructor(private readonly _fixedName: string) {
    super(undefined, 0);
  }
  get dependencies(): ReadonlyArray<Name> {
    return [];
  }
  addAssociate(associate: AssociatedName): never {
    return panic(`Cannot add associates to fixed names`);
  }
  get fixedName(): string {
    return this._fixedName;
  }
  proposeUnstyledNames(_?: ReadonlyMap<Name, string>): ReadonlySet<string> {
    return panic("Only fixedName should be called on fixedName");
  }
}

export class SimpleName extends Name {
  readonly #_unstyleNames: ReadonlySet<string>;
  constructor(unstyleNames: Iterable<string>, namingFuncton: Namer, order: number) {
    super(namingFuncton, order);
    this.#_unstyleNames = new Set(unstyleNames);
  }
  get dependencies(): ReadonlyArray<Name> {
    return [];
  }
  proposeUnstyledNames(_?: ReadonlyMap<Name, string>): ReadonlySet<string> {
    return this.#_unstyleNames;
  }
}

export class AssociatedName extends Name {
  constructor(private readonly _sponsor: Name, order: number, readonly getName: (sponsorName: string) => string) {
    super(undefined, order);
  }
  get dependencies(): ReadonlyArray<Name> {
    return [this._sponsor];
  }
  proposeUnstyledNames(_?: ReadonlyMap<Name, string>): never {
    return panic("AssociatedName must be a assigned via its sponsor");
  }
}

export class DependencyName extends Name {
  readonly #_dependencies!: ReadonlySet<Name>;
  constructor(
    namingFunction: Namer | undefined,
    order: number,
    private readonly _proposeUnstyledName: (lookup: (n: Name) => string) => string
  ) {
    super(namingFunction, order);
    const dependencies: Name[] = [];
    _proposeUnstyledName((n) => {
      dependencies.push(n);
      return "0xDEADBEEF";
    });
    this.#_dependencies = new Set(dependencies);
  }
  get dependencies(): ReadonlyArray<Name> {
    return Array.from(this.#_dependencies);
  }
  proposeUnstyledNames(names: ReadonlyMap<Name, string>): ReadonlySet<string> {
    return new Set([
      this._proposeUnstyledName((n) => {
        assert(this.#_dependencies.has(n), "DependencyName proposer is not pure");
        return defined(names.get(n));
      }),
    ]);
  }
}

export function keywordNamespace(name: string, keywords: string[]) {
  const ns = new Namespace(name, undefined, [], []);
  for (const k of keywords) {
    ns.add(new FixedName(k));
  }
  return ns;
}

function allNamespacesRecursively(namespaces: Iterable<Namespace>): ReadonlySet<Namespace> {
  return setUnion(namespaces, ...Array.from(setMap(namespaces, (ns) => allNamespacesRecursively(ns.chilren))));
}

class NamingContext {
  readonly #_names: Map<Name, string> = new Map();
  readonly #_namedsForName: Map<string, Set<Name>> = new Map();
  readonly namespaces!: ReadonlySet<Namespace>;
  constructor(rootNamespace: Iterable<Namespace>) {
    this.namespaces = allNamespacesRecursively(rootNamespace);
  }
  get names(): ReadonlyMap<Name, string> {
    return this.#_names;
  }

  isReadyToBeNamed = (named: Name): boolean => {
    if (this.#_names.has(named)) return false;
    return named.dependencies.every((n) => this.#_names.has(n));
  };

  areForbiddensFullyNamed(ns: Namespace): boolean {
    return iterableEvery(ns.forbiddenNameds, (n) => this.#_names.has(n));
  }

  isConflicting(namedNamespace: Namespace, proposed: string): boolean {
    const namedForProposed = this.#_namedsForName.get(proposed);
    if (!namedForProposed) return false;
    for (const n of namedForProposed) {
      if (namedNamespace.members.has(n) || namedNamespace.forbiddenNameds.has(n)) return true;
    }
    return false;
  }

  assign(named: Name, namedNamespace: Namespace, name: string): void {
    assert(!this.names.has(named), `Name "${name}" assigne twice`);
    assert(!this.isConflicting(namedNamespace, name), `Assigned name "${name}" conflicts`);
    this.#_names.set(named, name);
    let namedForName = this.#_namedsForName.get(name);
    if (!namedForName) {
      namedForName = new Set();
      this.#_namedsForName.set(name, namedForName);
    }
    namedForName.add(named);
  }
}

export function assignNames(rootNamespace: Iterable<Namespace>): ReadonlyMap<Name, string> {
  const ctx = new NamingContext(rootNamespace);
  for (const ns of ctx.namespaces) {
    for (const n of ns.members) {
      if (!n.isFixed()) continue;
      ctx.assign(n, ns, n.fixedName);
    }
  }
  for (;;) {
    const unfinishedNamespaces = setFilter(ctx.namespaces, (ns) => ctx.areForbiddensFullyNamed(ns));
    const readyNamespace = iterableFind(unfinishedNamespaces, (ns) => iterableSome(ns.members, ctx.isReadyToBeNamed));

    if (!readyNamespace) return ctx.names;
    const allForbiddenNames = setUnion(readyNamespace.members, readyNamespace.forbiddenNameds);
    let forbiddenNames = setFilterMap(allForbiddenNames, (n) => ctx.names.get(n));

    for (;;) {
      const allReadyNames = setFilter(readyNamespace.members, ctx.isReadyToBeNamed);
      const minOrderName = iterableMinBy(allReadyNames, (n) => n.order);
      if (!minOrderName) break;
      const minOrder = minOrderName.order;
      const readyNames = setFilter(allReadyNames, (n) => n.order === minOrder);
      const byNamingFunction = setGroupBy(readyNames, (n) => n.namingFunction);
      for (const [namer, namedForNamingFunction] of byNamingFunction) {
        const propose = setGroupBy(namedForNamingFunction, (n) =>
          n.namingFunction.nameStyle(n.firstProposeName(ctx.names))
        );
        for (const [_, nameds] of propose) {
          const names = namer.assignNames(ctx.names, forbiddenNames, nameds);
          for (const [name, assigned] of names) {
            ctx.assign(name, readyNamespace, assigned);
          }
          setUnionInto(forbiddenNames, names.values());
        }
      }
    }
  }
}
