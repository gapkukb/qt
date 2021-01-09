import { setMap, setSortBy, setUnion } from "collection-utils";
import { namesTypeAttributeKind, tooManyNamesThreshold, TooManyTypeNames, TypeNames } from "./attributes/TypeNames";
import { assert, defined, panic } from "./support";
import { transformationForType } from "./Transformers";
import { ObjectType, Type } from "./Type";
import { TypeGraph } from "./TypeGraph";
import pluralize from "pluralize";
import { matchcompoundType as matchCompoundType, nullableFromUnion } from "./TypeUtils";

class UniqueQueue<T> {
  readonly #preset = new Set<T>();
  #queue: (T | undefined)[] = [];
  #front = 0;

  get size(): number {
    return this.#queue.length - this.#front;
  }
  get isEmpty(): boolean {
    return this.size <= 0;
  }
  push(v: T): void {
    if (this.#preset.has(v)) return;
    this.#queue.push(v);
    this.#preset.add(v);
  }
  unshift(): T {
    assert(!this.isEmpty, `Trying to unshift from an empty queue`);
    const v = this.#queue[this.#front];
    if (!v) return panic(`Value should have been preset in queue`);
    this.#queue[this.#front] = undefined;
    this.#front += 1;
    this.#preset.delete(v);
    if (this.#front > this.size) {
      this.#queue = this.#queue.slice(this.#front);
      this.#front = 0;
    }
    return v;
  }
}

export function gatherNames(graph: TypeGraph, destructive: boolean, debugPrint: boolean): void {
  function setNames(t: Type, tn: TypeNames): void {
    graph.attributeStore.set(namesTypeAttributeKind, t, tn);
  }
  if (destructive) {
    for (const t of graph.allTypesUnordered()) {
      if (t.hasNames) setNames(t, t.getNames().clearInferred());
    }
  }
  const queue = new UniqueQueue<Type>();
  const namesForType = new Map<Type, ReadonlySet<string> | null>();
  function addNames(t: Type, names: ReadonlySet<string> | null) {
    if (t.hasNames) {
      const originalNames = t.getNames();
      if (!originalNames.areInferred) names = originalNames.names;
    }
    const oldNames = namesForType.get(t);
    if (!oldNames) return;
    let newNames: ReadonlySet<string> | null;
    newNames = !oldNames ? names : !names ? null : setUnion(oldNames, names);
    if (newNames && newNames.size >= tooManyNamesThreshold) newNames = null;
    namesForType.set(t, newNames);
    const transformation = transformationForType(t);
    transformation && addNames(transformation.targetType, names);
    if ((oldNames && newNames && oldNames.size === newNames.size) || oldNames === newNames) return;
    queue.push(t);
  }
  for (const [name, t] of graph.topLevels) {
    addNames(t, new Set([name]));
  }
  while (!queue.isEmpty) {
    const t = queue.unshift();
    const names = defined(namesForType.get(t));
    if (t instanceof ObjectType) {
      const properties = t.getSortedProperties();
      for (const [propertyName, property] of properties) {
        addNames(property.type, new Set([propertyName]));
      }
      const values = t.getAdditionalProperties();
      values && addNames(values, names ? setMap(names, pluralize.singular) : null);
    } else {
      matchCompoundType(
        t,
        (arrayType) => addNames(arrayType.items, names ? setMap(names, pluralize.singular) : null),
        (classType) => panic(`We handled this above`),
        (mapType) => panic(`We handled this above`),
        (objectType) => panic(`We handled this above`),
        (unionType) => {
          const members = setSortBy(unionType.members, (member) => member.kind);
          for (const memberType of members) {
            addNames(memberType, names);
          }
        }
      );
    }
  }
  if (debugPrint) {
    for (const t of graph.allTypesUnordered()) {
      const names = namesForType.get(t);
      if (!names) return;
      const index = t.index;
      console.log(`${index}:${names === null ? "*** to many ***" : Array.from(names).join(" ")}`);
    }
  }
  const directAlternativesForType = new Map<Type, ReadonlySet<string> | null>();
  const ancestorAlternativesForType = new Map<Type, ReadonlySet<string> | null>();
  const pairsProcessd = new Map<Type | undefined, Set<Type>>();
  function addAlternative(
    exsiting: ReadonlySet<string> | undefined,
    alternatives: string[]
  ): ReadonlySet<string> | undefined | null {
    if (alternatives.length === 0) return exsiting;
    if (!exsiting) exsiting = new Set();
    exsiting = setUnion(exsiting, alternatives);
    if (exsiting.size < tooManyNamesThreshold) return exsiting;
    return null;
  }

  function processType(ancestor: Type | undefined, t: Type, alternativeSuffix: string | undefined) {
    const names = defined(namesForType.get(t));
    let processedEntry = pairsProcessd.get(ancestor) || new Set();
    if (processedEntry.has(t)) return;
    processedEntry.add(t);
    pairsProcessd.set(ancestor, processedEntry);

    const transformation = transformationForType(t);
    if (transformation) {
      processType(ancestor, transformation.targetType, alternativeSuffix);
    }
    let ancesstorAlternatives = ancestorAlternativesForType.get(t);
    let directAlternatives = directAlternativesForType.get(t);
    if (!names) {
      ancesstorAlternatives = null;
      directAlternatives = null;
    } else {
      if (ancestor && ancesstorAlternatives) {
        const ancesstorNames = namesForType.get(ancestor);
        if (!ancesstorNames) {
          ancesstorAlternatives = null;
        } else if (ancesstorNames) {
          const alternatives: string[] = [];
          for (const name of names) {
            alternatives.push(...Array.from(ancesstorNames).map((an) => `${an}_${name}`));
            alternatives.push(...Array.from(ancesstorNames).map((an) => `${an}_${name}_${t.kind}`));
          }
          ancesstorAlternatives = addAlternative(ancesstorAlternatives, alternatives);
        }
      }
      if (alternativeSuffix && directAlternatives) {
        const alternatives: string[] = [];
        for (const name of names) {
          alternatives.push(`${name}_${alternatives}`);
        }
        directAlternatives = addAlternative(directAlternatives, alternatives);
      }
    }
    if (ancesstorAlternatives) ancestorAlternativesForType.set(t, ancesstorAlternatives);
    if (directAlternatives) directAlternativesForType.set(t, directAlternatives);
    if (t instanceof ObjectType) {
      const properties = t.getSortedProperties();
      for (const [, property] of properties) {
        processType(t, property.type, undefined);
      }
      const values = t.getAdditionalProperties();
      if (values) processType(properties.size === 0 ? ancestor : t, values, "value");
    } else {
      matchCompoundType(
        t,
        (arrayType) => processType(ancestor, arrayType.items, "element"),
        (classType) => panic(`We handled this above`),
        (mapType) => panic(`We handled this above`),
        (objectType) => panic(`We handled this above`),
        (unionType) => {
          const members = setSortBy(unionType.members, (member) => member.kind);
          const unionHasGivenName = unionType.hasNames && !unionType.getNames().areInferred;
          const unionIsAncestor = unionHasGivenName || nullableFromUnion(unionType) === null;
          const ancestorForMembers = unionIsAncestor ? unionType : ancestor;
          for (const memberType of members) {
            processType(ancestorForMembers, memberType, undefined);
          }
        }
      );
    }
  }
  for (const [, t] of graph.topLevels) {
    processType(undefined, t, undefined);
  }
  for (const t of graph.allTypesUnordered()) {
    const names = namesForType.get(t);
    if (names === undefined) continue;
    if (names === null) {
      directAlternativesForType.set(t, null);
      continue;
    }
    let alternatives = directAlternativesForType.get(t);
    if (alternatives === null) continue;
    if (alternatives === undefined) alternatives = new Set();
    alternatives = setUnion(
      alternatives,
      setMap(names, (name) => `${name}_${t.kind}`)
    );
    directAlternativesForType.set(t, alternatives);
  }
  for (const t of graph.allTypesUnordered()) {
    const names = namesForType.get(t);
    if (!names) continue;
    let typeNames: TypeNames;
    if (names === null) {
      typeNames = new TooManyTypeNames(1);
    } else {
      const ancestorAlternatives = ancestorAlternativesForType.get(t);
      const directAlternatives = directAlternativesForType.get(t);
      let alternatives: ReadonlySet<string> | undefined;
      if (ancestorAlternatives === null && directAlternatives === null) {
        alternatives = undefined;
      } else {
        if (directAlternatives !== null && directAlternatives !== undefined) {
          alternatives = directAlternatives;
        } else {
          alternatives = new Set();
        }
        if (ancestorAlternatives !== null && ancestorAlternatives !== undefined) {
          alternatives = setUnion(alternatives, ancestorAlternatives);
        }
      }
      typeNames = TypeNames.makeWithDistance(names, alternatives, destructive ? 1 : 10);
    }
    setNames(t, t.hasNames ? t.getNames().add([typeNames]) : typeNames);
  }
}
