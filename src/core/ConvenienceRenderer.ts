import {
  iterableEnumerate,
  iterableSome,
  mapFilter,
  mapFilterMap,
  mapSome,
  mapSortBy,
  setFilter,
} from "collection-utils";
import { enumCaseNames, getAccessorName, objectPropertyNames, unionMemberName } from "./attributes/AccessorNames";
import { descriptionTypeAttributeKind, propertyDescriptionTypeAttributeKind } from "./attributes/Description";
import { TypeAttributeKind } from "./attributes/TypeAttributes";
import { cycleBreakerTypesForGraph, Declaration, DeclarationIR, declarationsForGraph } from "./DeclarationIR";
import { DependencyName, FixedName, keywordNamespace, Name, Namer, Namespace, SimpleName } from "./Naming";
import { BlankLineConfig, ForEachPostion, RenderContext, Renderer } from "./Renderer";
import { serializeRenderResult, Sourcelike } from "./Source";
import { assert, defined, nonNull, panic } from "./support";
import { trimEnd } from "./support/Strings";
import { TargetLanguage } from "./TargetLanguage";
import { followTargetType, Transformation, transformationForType } from "./Transformers";
import { ClassProperty, ClassType, EnumType, MapType, ObjectType, Type, TypeKind, UnionType } from "./Type";
import { TypeAttributeStoreView } from "./TypeGraph";
import { isNamedType, matchTypeExhaustive, nullableFromUnion, separatedNamedTypes } from "./TypeUtils";

const wordWrap: (s: string) => string = require("wordwrap")(90);
export const topLevelNameOrder = 1;
const givenNumberOrder = 10;
export const inferredNameOrder = 30;
const classPropertyNameOrder = 20;
const assignedClassPropertyNameOrder = 10;
const enumCaseNameOrder = 20;
const assignedEnumCaseNameOrder = 10;
const unionMemberNameOrder = 40;

function splitDescription(descriptions: Iterable<string> | undefined): string[] | undefined {
  if (descriptions === undefined) return;
  const description = Array.from(descriptions).join("\n\n").trim();
  if (description === "") return;
  return wordWrap(description)
    .split("\n")
    .map((l) => l.trim());
}

export type ForbiddenWordsInfo = { names: (Name | string)[]; includeGlobalForbidden: boolean };

const assignedNameAttributeKind = new TypeAttributeKind<Name>("assignedName");
const assignedPropertyNamesAttributeKind = new TypeAttributeKind<ReadonlyMap<string, Name>>("assignedPropertyNames");
const assignedMemberNamesAttributeKind = new TypeAttributeKind<ReadonlyMap<Type, Name>>("assignedMemberNames");
const assignedCaseNamesAttributeKind = new TypeAttributeKind<ReadonlyMap<string, Name>>("assignedCaseNames");

type StoreView<T> = TypeAttributeStoreView<ReadonlyMap<T, Name>>;

export abstract class ConvenienceRenderer extends Renderer {
  #globalForbiddenNamespace?: Namespace;
  #otherForbiddenNamespaces?: Map<string, Namespace>;
  #globalNamespace?: Namespace;
  #nameStoreView?: TypeAttributeStoreView<Name>;
  #propertyNamesStoreView?: StoreView<string>;
  #memberNamesStoreView?: StoreView<Type>;
  #caseNamesStoreView?: StoreView<string>;
  #namesForTransformations?: Map<Type, Name>;
  #namedTypeNamer?: Namer;
  #unionMemberNamer: Namer | null = null;
  #enumCaseNamer: Namer | null = null;
  #declarationIR?: DeclarationIR;
  #namedTypes?: ReadonlyArray<Type>;
  #namedObjects?: Set<ObjectType>;
  #namedEnums?: Set<EnumType>;
  #namedUnions?: Set<UnionType>;
  #haveUnions?: boolean;
  #haveMaps?: boolean;
  #haveOptionalProperties?: boolean;
  #cycleBreakerTypes?: Set<Type>;
  #alphabetizeProperties = false;

  constructor(targetLanguage: TargetLanguage, renderContext: RenderContext) {
    super(targetLanguage, renderContext);
  }

  get topLevels(): ReadonlyMap<string, Type> {
    return this.typeGraph.topLevels;
  }

  protected forbiddenNamesForGlobalNamespace(): string[] {
    return [];
  }

  protected forbiddenForObjectProperties(o: ObjectType, className: Name): ForbiddenWordsInfo {
    return { names: [], includeGlobalForbidden: false };
  }

  protected forbiddenForUnionMembers(u: UnionType, unionName: Name): ForbiddenWordsInfo {
    return { names: [], includeGlobalForbidden: false };
  }

  protected forbiddenForEnumCases(e: EnumType, enumName: Name): ForbiddenWordsInfo {
    return { names: [], includeGlobalForbidden: false };
  }

  protected makeTopLevelDependencyNames(t: Type, topLevelName: Name): DependencyName[] {
    return [];
  }

  protected makeNamedTypeDependencyNames(t: Type, name: Name): DependencyName[] {
    return [];
  }

  protected abstract makeNamedTypeNamer(): Namer;
  protected abstract namerForObjectProperty(o: ObjectType, p: ClassProperty): Namer | null;
  protected abstract makeUnionMemberNamer(): Namer | null;
  protected abstract makeEnumCaseNamer(): Namer | null;
  protected abstract emitSourceStructure(givenOutputFilename: string): void;

  protected makeNameForTransformation(xf: Transformation, typeName: Name | undefined): Name | undefined {
    return undefined;
  }

  protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
    if (isNamedType(type)) return type;
    return undefined;
  }

  protected get unionMembersInGlobalNamespace(): boolean {
    return false;
  }

  protected get enumCasesInGlobalNamespace(): boolean {
    return false;
  }

  protected get needTypeDeclarationBeforeUse(): boolean {
    return false;
  }

  protected canBeForwardDeclared(t: Type): boolean {
    return panic(`If needsTypeDeclarationBeforeUse returns true,canBeForwardDeclared must be implemented`);
  }

  protected unionNeedsName(u: UnionType): boolean {
    return nullableFromUnion(u) === null;
  }

  private get globalNamespace(): Namespace {
    return defined(this.globalNamespace);
  }

  private get nameStoreView(): TypeAttributeStoreView<Name> {
    return defined(this.#nameStoreView);
  }

  protected descriptionForType(t: Type): string[] | undefined {
    let description = this.typeGraph.attributeStore.tryGet(descriptionTypeAttributeKind, t);
    return splitDescription(description);
  }

  protected descriptionForClassProperty(o: ObjectType, name: string): string[] | undefined {
    const descriptions = this.typeGraph.attributeStore.tryGet(propertyDescriptionTypeAttributeKind, o);
    if (!descriptions) return;
    return splitDescription(descriptions.get(name));
  }

  protected setUpNaming(): ReadonlySet<Namespace> {
    var attr = this.typeGraph.attributeStore;
    this.#nameStoreView = new TypeAttributeStoreView(attr, assignedNameAttributeKind);
    this.#propertyNamesStoreView = new TypeAttributeStoreView(attr, assignedPropertyNamesAttributeKind);
    this.#memberNamesStoreView = new TypeAttributeStoreView(attr, assignedMemberNamesAttributeKind);
    this.#caseNamesStoreView = new TypeAttributeStoreView(attr, assignedCaseNamesAttributeKind);
    this.#namesForTransformations = new Map();
    this.#namedTypeNamer = this.makeNamedTypeNamer();
    this.#unionMemberNamer = this.makeUnionMemberNamer();
    this.#enumCaseNamer = this.makeEnumCaseNamer();

    this.#globalForbiddenNamespace = keywordNamespace("forbidden", this.forbiddenNamesForGlobalNamespace());
    this.#otherForbiddenNamespaces = new Map();
    this.#globalNamespace = new Namespace("global", undefined, [this.#globalForbiddenNamespace], []);
    const { objects, enums, unions } = this.typeGraph.allNamedTypesSeparated();
    const namedUinons = setFilter(unions, (u) => this.unionNeedsName(u));
    for (const [name, t] of this.topLevels) {
      // TODO:
      this.nameStoreView.setForTopLevel(name, this.addNameForTopLevel(t, name));
    }
    for (const o of objects) {
    }
  }
  private addDependenciesForNamedType(type: Type, named: Name): void {
    const dependencyName = this.makeNamedTypeDependencyNames(type, named);
    for (const dn of dependencyName) {
      this.globalNamespace.add(dn);
    }
  }
  private makeNameForTopLevel(t: Type, givenName: string, maybeNamedType: Type | undefined): Name {
    return new SimpleName([givenName], defined(this.#namedTypeNamer), topLevelNameOrder);
  }
  private addNameForTopLevel(type: Type, givenName: string): Name {
    const maybeNamedType = this.namedTypeToNameForTopLevel(type);
    const name = this.makeNameForTopLevel(type, givenName, maybeNamedType);
    this.globalNamespace.add(name);
    const dependencyNames = this.makeTopLevelDependencyNames(type, name);
    for (const dn of dependencyNames) {
      this.globalNamespace.add(dn);
    }
    if (maybeNamedType) {
      this.addDependenciesForNamedType(maybeNamedType, name);
      this.nameStoreView.set(maybeNamedType, name);
    }
    return name;
  }
  private makeNameForType(t: Type, namer: Namer, givenOrder: number, inferredOrder: number): Name {
    const names = t.getNames();
    const order = names.areInferred ? inferredOrder : givenOrder;
    return new SimpleName(names.proposedNames, namer, order);
  }

  protected makeNameForNamedType(t: Type): Name {
    return this.makeNameForType(t, defined(this.#namedTypeNamer), givenNumberOrder, inferredNameOrder);
  }
  private addNameForNamedType(type: Type): Name {
    const exsiting = this.nameStoreView.tryGet(type);
    if (exsiting) return exsiting;
    const name = this.globalNamespace.add(this.makeNameForNamedType(type));
    this.addDependenciesForNamedType(type, name);
    this.nameStoreView.set(type, name);
    return name;
  }
  protected get typesWithNamedTransformations(): ReadonlyMap<Type, Name> {
    return defined(this.#namesForTransformations);
  }
  protected nameForTransformation(t: Type): Name | undefined {
    const xf = transformationForType(t);
    if (!xf) return;
    const name = defined(this.#namesForTransformations).get(t);
    if (!name) return panic(`No name for transformation`);
    return name;
  }
  private addNameForTransformation(t: Type): void {
    const xf = transformationForType(t);
    if (!xf) return;
    assert(
      defined(this.#namesForTransformations).get(t) === undefined,
      "Tried to give two names to the same transformation"
    );
    const name = this.makeNameForTransformation(xf, this.nameStoreView.tryGet(xf.targetType));
    if (!name) return;
    this.globalNamespace.add(name);
    defined(this.#namesForTransformations).set(t, name);
  }
  private processForbiddenWordsInfo(
    info: ForbiddenWordsInfo,
    namespaceName: string
  ): { forbiddenNames: ReadonlySet<Name>; forbiddenNamespaces: ReadonlySet<Namespace> } {
    const forbiddenNames: Name[] = [];
    const forbiidenStrings: string[] = [];
    for (const nameOrString of info.names) {
      if (typeof nameOrString === "string") {
        forbiidenStrings.push(nameOrString);
      } else {
        forbiddenNames.push(nameOrString);
      }
    }
    let namespace = defined(this.#otherForbiddenNamespaces).get(namespaceName);
    if (forbiidenStrings.length > 0 && !namespace) {
      namespace = keywordNamespace(namespaceName, forbiidenStrings);
      this.#otherForbiddenNamespaces = defined(this.#otherForbiddenNamespaces).set(namespaceName, namespace);
    }
    let forbiddenNamespaces = new Set<Namespace>();
    if (info.includeGlobalForbidden) {
      forbiddenNamespaces = forbiddenNamespaces.add(defined(this.#globalForbiddenNamespace));
    }
    if (namespace) {
      forbiddenNamespaces = forbiddenNamespaces.add(namespace);
    }
    return { forbiddenNames: new Set(forbiddenNames), forbiddenNamespaces };
  }

  protected makeNameForProperty(
    o: ObjectType,
    classNames: Name,
    p: ClassProperty,
    jsonName: string,
    assignedName: string | undefined
  ): Name | undefined {
    const namer = this.namerForObjectProperty(o, p);
    if (!namer) return;
    const alternative = `${o.getCombineName()}_${jsonName}`;
    const order = assignedName ? assignedClassPropertyNameOrder : classPropertyNameOrder;
    const names = assignedName ? [assignedName] : [jsonName, alternative];
    return new SimpleName(names, namer, order);
  }
  protected makePropertyDependencyNames(
    o: ObjectType,
    className: Name,
    p: ClassProperty,
    jsonName: string,
    name: Name
  ) {
    return [];
  }
  private addPropertyNames(o: ObjectType, className: Name): void {
    const { forbiddenNames, forbiddenNamespaces } = this.processForbiddenWordsInfo(
      this.forbiddenForObjectProperties(o, className),
      "forbidden-for-properties"
    );
    let ns: Namespace | undefined;
    const accessorNames = objectPropertyNames(o, this.targetLanguage.name);
    const names = mapFilterMap(o.getSortedProperties(), (p, jsonName) => {
      const [assignedName, isFixed] = getAccessorName(accessorNames, jsonName);
      let name: Name | undefined;
      if (isFixed) name = new FixedName(defined(assignedName));
      else name = this.makeNameForProperty(o, className, p, jsonName, assignedName);
      if (!name) return;
      ns = ns || new Namespace(o.getCombineName(), this.globalNamespace, forbiddenNamespaces, forbiddenNames);
      ns.add(name);
      for (const depName of this.makePropertyDependencyNames(o, className, p, jsonName, name)) {
        ns.add(depName);
      }
      return name;
    });
    defined(this.#propertyNamesStoreView).set(o, names);
  }
  protected makeNameForUnionMember(u: UnionType, unionName: Name, t: Type): Name {
    const [assignedName, isFixed] = unionMemberName(u, t, this.targetLanguage.name);
    if (isFixed) return new FixedName(defined(assignedName));
    return new DependencyName(nonNull(this.#unionMemberNamer), unionMemberNameOrder, (lookup) => {
      return assignedName || this.proposeUnionMemberName(u, unionName, t, lookup);
    });
  }
  private addUnionMemberNames(u: UnionType, unionName: Name): void {
    const memberNamer = this.#unionMemberNamer;
    if (!memberNamer) return;
    const { forbiddenNames, forbiddenNamespaces } = this.processForbiddenWordsInfo(
      this.forbiddenForUnionMembers(u, unionName),
      "forbidden-for-union-members"
    );
    let ns: Namespace;
    if (this.unionMembersInGlobalNamespace) {
      ns = this.globalNamespace;
    } else {
      ns = new Namespace(u.getCombineName(), this.globalNamespace, forbiddenNamespaces, forbiddenNames);
    }
    let names = new Map<Type, Name>();
    for (const t of u.members) {
      const name = this.makeNameForUnionMember(u, unionName, followTargetType(t));
      names.set(t, ns.add(name));
    }
    defined(this.#memberNamesStoreView).set(u, names);
  }
  protected makeNameForEnumCase(e: EnumType, enumName: Name, caseName: string, assignedName: string | undefined): Name {
    const alternative = `${e.getCombineName()}_${caseName}`;
    const order = assignedName ? assignedEnumCaseNameOrder : enumCaseNameOrder;
    const names = assignedName ? [assignedName] : [caseName, alternative];
    return new SimpleName(names, nonNull(this.#enumCaseNamer), order);
  }
  private addEnumCaseNames(e: EnumType, enumName: Name): void {
    if (!this.#enumCaseNamer) return;
    const { forbiddenNames, forbiddenNamespaces } = this.processForbiddenWordsInfo(
      this.forbiddenForEnumCases(e, enumName),
      "forbiiden-for-enum-cases"
    );
    let ns: Namespace;
    if (this.enumCasesInGlobalNamespace) {
      ns = this.globalNamespace;
    } else {
      ns = new Namespace(e.getCombineName(), this.globalNamespace, forbiddenNamespaces, forbiddenNames);
    }
    let names = new Map<string, Name>();
    const accessorNames = enumCaseNames(e, this.targetLanguage.name);
    for (const caseName of e.cases) {
      const [assignedName, isFixed] = getAccessorName(accessorNames, caseName);
      let name: Name;
      name = isFixed
        ? new FixedName(defined(assignedName))
        : this.makeNameForEnumCase(e, enumName, caseName, assignedName);
      names.set(caseName, ns.add(name));
    }
    defined(this.#caseNamesStoreView).set(e, names);
  }
  private childrenOfType(t: Type): ReadonlySet<Type> {
    const names = this.names;
    if (t instanceof ClassType) {
      const propertyNameds = defined(this.#propertyNamesStoreView).get(t);
      const filteredMap = mapFilterMap(t.getProperties(), (p, n) => {
        if (!propertyNameds.get(n)) return;
        return p.type;
      });
      const sortedMap = mapSortBy(filteredMap, (_, n) => defined(names.get(defined(propertyNameds.get(n)))));
      return new Set(sortedMap.values());
    }
    return t.getChildren();
  }
  protected get namedUnions(): ReadonlySet<UnionType> {
    return defined(this.#namedUnions);
  }
  protected get haveNamedUnions(): boolean {
    return this.namedUnions.size > 0;
  }
  protected get haveNamedTypes(): boolean {
    return defined(this.#namedTypes).length > 0;
  }
  protected get haveUinons(): boolean {
    return defined(this.#haveUnions);
  }
  protected get haveMaps(): boolean {
    return defined(this.#haveMaps);
  }
  protected get haveOptionalProperties(): boolean {
    return defined(this.#haveOptionalProperties);
  }
  protected get enums(): ReadonlySet<EnumType> {
    return defined(this.#namedEnums);
  }
  protected get haveEnums(): boolean {
    return this.enums.size > 0;
  }
  protected proposedUnionMemberNameForTypeKind(kind: TypeKind): string | null {
    return null;
  }
  protected proposeUnionMemberName(
    u: UnionType,
    unionName: Name,
    fieldType: Type,
    lookup: (u: Name) => string
  ): string {
    const simpleName = this.proposedUnionMemberNameForTypeKind(fieldType.kind);
    if (simpleName) return simpleName;
    const typeNameForUnionMember = (t: Type): string =>
      matchTypeExhaustive(
        t,
        (noneType) => panic(`none type should have been replaced`),
        (anyType) => `anything`,
        (nullType) => `null`,
        (boolType) => `bool`,
        (integerType) => `integer`,
        (doubleType) => `double`,
        (stringType) => `string`,
        (arrayType) => typeNameForUnionMember(arrayType.items) + `_array`,
        (classType) => lookup(this.nameForNamedType(classType)),
        (mapType) => typeNameForUnionMember(mapType.values) + `_map`,
        (objectType) => {
          assert(
            this.targetLanguage.supportsFullObjectType,
            `Object type should have been replaced in 'repalceObjectType'`
          );
          return lookup(this.nameForNamedType(objectType));
        },
        (enumType) => `enum`,
        (unionType) => `union`,
        (transformedType) => transformedType.kind.replace("-", "_")
      );

    return typeNameForUnionMember(fieldType);
  }
  protected nameForNamedType(t: Type): Name {
    return this.nameStoreView.get(t);
  }
  protected isForwardDeclaredType(t: Type): boolean {
    return defined(this.#declarationIR).forwardedTypes.has(t);
  }
  protected isImplicityCycleBreaker(t: Type): boolean {
    return panic(`A renderer that invokes isCycleBreaker must implement isImplicityCycleBreaker`);
  }
  protected canBreakerCycles(t: Type): boolean {
    return true;
  }
  protected isCycleBreakerType(t: Type): boolean {
    if (!this.#cycleBreakerTypes) {
      this.#cycleBreakerTypes = cycleBreakerTypesForGraph(
        this.typeGraph,
        (s) => this.isImplicityCycleBreaker(s),
        (s) => this.canBreakerCycles(s)
      );
    }
    return this.#cycleBreakerTypes.has(t);
  }
  protected forEachTopLevel(
    blankLocations: BlankLineConfig,
    f: (t: Type, name: Name, position: ForEachPostion) => void,
    predicate?: (t: Type) => boolean
  ): boolean {
    let topLevels: ReadonlyMap<string, Type> = predicate ? mapFilter(this.topLevels, predicate) : this.topLevels;
    return this.forEachWithBlankLines(topLevels, blankLocations, (t, name, pos) =>
      f(t, this.nameStoreView.getForTopLevel(name), pos)
    );
  }
  protected forEachDeclaration(
    blankLocations: BlankLineConfig,
    f: (decl: Declaration, position: ForEachPostion) => void
  ) {
    this.forEachWithBlankLines(
      iterableEnumerate(defined(this.#declarationIR).declarations),
      blankLocations,
      (decl, _, pos) => f(decl, pos)
    );
  }

  setAlphabetizeProperties(value: boolean): void {
    this.#alphabetizeProperties = value;
  }
  protected getAlphabetizeProperties(): boolean {
    return this.#alphabetizeProperties;
  }
  protected propertyCount(o: ObjectType): number {
    const propertNames = defined(this.#propertyNamesStoreView).get(o);
    return propertNames.size;
  }
  protected sortClassProperties(
    properties: ReadonlyMap<string, ClassProperty>,
    propertyNames: ReadonlyMap<string, Name>
  ): ReadonlyMap<string, ClassProperty> {
    if (this.#alphabetizeProperties) {
      return mapSortBy(properties, (p: ClassProperty, jsonName: string) => {
        const name = defined(propertyNames.get(jsonName));
        return defined(this.names.get(name));
      });
    }
    return properties;
  }
  protected forEachClassProperty(
    o: ObjectType,
    blankLocations: BlankLineConfig,
    f: (name: Name, jsonName: string, p: ClassProperty, position: ForEachPostion) => void
  ): void {
    const propertyNames = defined(this.#propertyNamesStoreView).get(o);
    const sortedProperties = this.sortClassProperties(o.getProperties(), propertyNames);
    this.forEachWithBlankLines(sortedProperties, blankLocations, (p, jsonName, pos) => {
      const name = defined(propertyNames.get(jsonName));
      f(name, jsonName, p, pos);
    });
  }
  protected nameForUnionMember(u: UnionType, t: Type): Name {
    return defined(
      defined(this.#memberNamesStoreView)
        .get(u)
        .get(t)
    );
  }
  protected nameForEnumCase(e: EnumType, caseName: string): Name {
    const caseNames = defined(this.#caseNamesStoreView).get(e);
    return defined(caseNames.get(caseName));
  }
  protected forEachUnionMember(
    u: UnionType,
    members: ReadonlySet<Type> | null,
    blankLocations: BlankLineConfig,
    sortOrder: ((n: Name, t: Type) => string) | null,
    f: (name: Name, t: Type, position: ForEachPostion) => void
  ): void {
    const iterateMembers = members ? members : u.members;
    sortOrder = sortOrder || ((n) => defined(this.names.get(n)));
    const memberNames = mapFilter(defined(this.#memberNamesStoreView).get(u), (_, t) => iterateMembers.has(t));
    const sortedMemberNames = mapSortBy(memberNames, sortOrder);
    this.forEachWithBlankLines(sortedMemberNames, blankLocations, f);
  }
  protected forEachEnumCase(
    e: EnumType,
    blankLocations: BlankLineConfig,
    f: (name: Name, jsonName: string, position: ForEachPostion) => void
  ): void {
    const caseNames = defined(this.#caseNamesStoreView).get(e);
    const sortedCaseNames = mapSortBy(caseNames, (n) => defined(this.names.get(n)));
    this.forEachWithBlankLines(sortedCaseNames, blankLocations, f);
  }
  protected forEachTransformation(
    blankLocations: BlankLineConfig,
    f: (n: Name, t: Type, position: ForEachPostion) => void
  ): void {
    this.forEachWithBlankLines(defined(this.#namesForTransformations), blankLocations, f);
  }
  protected forEachSpecificNamedType<T extends Type>(
    blankLocations: BlankLineConfig,
    types: Iterable<[any, T]>,
    f: (t: T, name: Name, position: ForEachPostion) => void
  ): void {
    this.forEachWithBlankLines(types, blankLocations, (t, _, pos) => f(t, this.nameForNamedType(t), pos));
  }
  protected forEachObject(
    blankLocations: BlankLineConfig,
    f: (
      c: ClassType,
      className: Name,
      position: ForEachPostion
    ) => void | ((o: ObjectType, objectName: Name, position: ForEachPostion) => void)
  ): void {
    this.forEachSpecificNamedType(blankLocations, defined(this.#namedObjects).entries(), f as any);
  }
  protected forEachEnum(
    blankLocations: BlankLineConfig,
    f: (u: EnumType, enumName: Name, position: ForEachPostion) => void
  ): void {
    this.forEachSpecificNamedType(blankLocations, this.enums.entries(), f);
  }
  protected forEachUnion(
    blankLocations: BlankLineConfig,
    f: (u: UnionType, unionName: Name, position: ForEachPostion) => void
  ): void {
    this.forEachSpecificNamedType(blankLocations, this.namedUnions.entries(), f);
  }
  protected forEachUniqueUnion<T>(
    blankLocations: BlankLineConfig,
    uniqueValue: (u: UnionType) => T,
    f: (firstUnion: UnionType, value: T, position: ForEachPostion) => void
  ): void {
    const firstUnionValue = new Map<T, UnionType>();
    for (const u of this.namedUnions) {
      const v = uniqueValue(u);
      if (!firstUnionValue.has(v)) {
        firstUnionValue.set(v, u);
      }
    }
    this.forEachWithBlankLines(firstUnionValue, blankLocations, f);
  }
  protected forEachNamedType(
    blankLocations: BlankLineConfig,
    objectFunc:
      | ((c: ClassType, className: Name, position: ForEachPostion) => void)
      | ((o: ObjectType, objecName: Name, position: ForEachPostion) => void),
    enumFunc: (e: EnumType, enumName: Name, position: ForEachPostion) => void,
    unionFunc: (e: UnionType, unionName: Name, position: ForEachPostion) => void
  ): void {
    this.forEachWithBlankLines(defined(this.#namedTypes).entries(), blankLocations, (t, _, pos) => {
      const name = this.nameForNamedType(t);
      if (t instanceof ObjectType) {
        (objectFunc as any)(t, name, pos);
      } else if (t instanceof EnumType) {
        enumFunc(t, name, pos);
      } else if (t instanceof UnionType) {
        unionFunc(t, name, pos);
      } else {
        return panic(`Named type that's neither a class nor union`);
      }
    });
  }
  protected sourceLikeToString(src: Sourcelike): string {
    return serializeRenderResult(this.sourceLikeToString(src), this.names, "").lines.join("\n");
  }
  protected get commentLineStart(): string {
    return "//";
  }
  protected emitCommentLines(
    lines: Sourcelike[],
    lineStart?: string,
    beforeLine?: string,
    afterLine?: string,
    firstLineStart?: string
  ): void {
    lineStart = lineStart || this.commentLineStart;
    firstLineStart = firstLineStart || lineStart;
    beforeLine && this.emitLine(beforeLine);
    let first = true;
    for (const line of lines) {
      let start = first ? firstLineStart : lineStart;
      if (!this.sourceLikeToString(line)) start = trimEnd(start);
      this.emitLine(start, line);
      first = false;
    }
    afterLine && this.emitLine(afterLine);
  }
  protected emitDescription(description: Sourcelike[] | undefined): void {
    if (!description) return;
    this.emitDescriptionBlock(description);
  }
  protected emitDescriptionBlock(lines: Sourcelike[]): void {
    this.emitCommentLines(lines);
  }
  protected emitPropertyTable(
    c: ClassType,
    makePropertyRow: (name: Name, jsonName: string, p: ClassProperty) => Sourcelike[]
  ): void {
    let table: Sourcelike[][] = [];
    const emitTable = () => {
      if (table.length === 0) return;
      this.emitTable(table);
      table = [];
    };
    this.forEachClassProperty(c, "none", (name, jsonName, p) => {
      const description = this.descriptionForClassProperty(c, jsonName);
      if (description) {
        emitTable();
        this.emitDescription(description);
      }
      table.push(makePropertyRow(name, jsonName, p));
    });
    emitTable();
  }
  private processGraph(): void {
    this.#declarationIR = declarationsForGraph(
      this.typeGraph,
      this.needTypeDeclarationBeforeUse ? (t) => this.canBeForwardDeclared(t) : undefined,
      (t) => this.childrenOfType(t),
      (t) => {
        if (t instanceof UnionType) return this.unionNeedsName(t);
        return isNamedType(t);
      }
    );
    const types = this.typeGraph.allTypesUnordered();
    this.#haveUnions = iterableSome(types, (t) => t instanceof UnionType);
    this.#haveMaps = iterableSome(types, (t) => t instanceof MapType);
    const classTypes = setFilter(types, (t) => t instanceof ClassType) as Set<ClassType>;
    this.#haveOptionalProperties = iterableSome(classTypes, (c) => mapSome(c.getProperties(), (p) => p.isOptional));
    this.#namedTypes = this.#declarationIR.declarations.filter((d) => d.kind === "define").map((d) => d.type);
    const { objects, enums, unions } = separatedNamedTypes(this.#namedTypes);
    this.#namedObjects = new Set(objects);
    this.#namedEnums = new Set(enums);
    this.#namedUnions = new Set(unions);
  }
  protected emitSource(givenOutputFilename: string): void {
    this.processGraph();
    this.emitSourceStructure(givenOutputFilename);
  }
  protected forEachType<TResult>(process: (t: Type) => TResult): Set<TResult> {
    const visitedTypes = new Set();
    const processed: Set<TResult> = new Set();
    const queue = Array.from(this.typeGraph.topLevels.values());
    function visit(t: Type) {
      if (visitedTypes.has(t)) return;
      for (const c of t.getChildren()) {
        queue.push(c);
      }
      visitedTypes.add(t);
      processed.add(process(t));
    }
    while (true) {
      const maybeType = queue.pop();
      if (!maybeType) break;
      visit(maybeType);
    }
    return processed;
  }
}
