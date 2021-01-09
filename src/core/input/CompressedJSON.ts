import { addHashCode, hashCodeInit, hashString } from "collection-utils";
import { inferTransformedStringTypeKindForString } from "../attributes/StringTypes";
import { DateTimeRecognizer } from "../DateTime";
import { assert, defined, panic } from "../support";
import { isPrimitiveStringTypeKind, TransformedStringTypeKind, transformedStringTypeTargetTypeKindsMap } from "../Type";

export enum Tag {
  Null,
  False,
  True,
  Integer,
  Double,
  InternedString,
  UninternedString,
  Object,
  Array,
  StringFormat,
  TransformedString,
}
export type Value = number;
const TAG_BITS = 4;
const TAG_MASK = (1 << TAG_BITS) - 1;

export function makeValue(t: Tag, index: number): Value {
  return t | (index << TAG_BITS);
}

function getIndex(v: Value, tag: Tag): number {
  assert(valueTag(v) === tag, "Trying to get index for value with invalid tag");
  return v >> TAG_BITS;
}

export function valueTag(v: Value): Tag {
  return v & TAG_MASK;
}

type Context = {
  currentObject?: Value[];
  currentArray?: Value[];
  currentKey?: string;
  currentNumberIsDouble: boolean;
};

export abstract class CompressedJSON<T> {
  #rootValue?: Value;
  #ctx?: Context;
  #contextStack: Context[] = [];
  #strings: string[] = [];
  #stringIndexes: Record<string, number> = {};
  #objects: Value[][] = [];
  #arrays: Value[][] = [];
  constructor(readonly dateTimeRecognizer: DateTimeRecognizer, readonly handleRefs: boolean) {}
  abstract parse(input: T): Promise<Value>;
  parseSync(input: T): Value {
    return panic("ParseSync not implements in CompressedJSON");
  }
  getStringForValue(v: Value): string {
    const tag = valueTag(v);
    assert(tag === Tag.InternedString || tag === Tag.TransformedString);
    return this.#strings[getIndex(v, tag)];
  }
  getObjectForValue(v: Value): Value[] {
    return this.#objects[getIndex(v, Tag.Object)];
  }
  getArrayForValue(v: Value): Value[] {
    return this.#objects[getIndex(v, Tag.Array)];
  }

  getStringFormatTypeKind(v: Value): TransformedStringTypeKind {
    const kind = this.#strings[getIndex(v, Tag.StringFormat)];
    if (!isPrimitiveStringTypeKind(kind) || kind === "string") return panic("Not a transformed string type kind");
    return kind;
  }
  protected get context(): Context {
    return defined(this.#ctx);
  }
  protected internString(s: string): number {
    if (Object.prototype.hasOwnProperty.call(this.#stringIndexes, s)) return this.#stringIndexes[s];
    const index = this.#strings.length;
    this.#strings.push(s);
    this.#stringIndexes[s] = index;
    return index;
  }
  protected makeString(s: string): Value {
    const value = makeValue(Tag.InternedString, this.internString(s));
    assert(typeof value === "number", `Interned string value is not a number:${value}`);
    return value;
  }
  protected internObject(obj: Value[]): Value {
    const index = this.#objects.length;
    this.#objects.push(obj);
    return makeValue(Tag.Object, index);
  }
  protected internArray(arr: Value[]): Value {
    const index = this.#arrays.length;
    this.#arrays.push(arr);
    return makeValue(Tag.Array, index);
  }
  protected get isExpectionREf(): boolean {
    return this.#ctx !== undefined && this.#ctx.currentKey === "$ref";
  }
  protected commitValue(value: Value): void {
    assert(typeof value === "number", "CompressedJSON value is not a number:" + value);
    if (!this.#ctx) {
      assert(!this.#rootValue, "Committing value but nowhere to commit to -root value still here");
      this.#rootValue = value;
    } else if (this.#ctx.currentObject) {
      if (!this.#ctx.currentKey) return panic("Must have key and can't have string when committing");
      this.#ctx.currentObject.push(this.makeString(this.#ctx.currentKey), value);
      this.#ctx.currentKey = undefined;
    } else if (this.#ctx.currentArray) {
      this.#ctx.currentArray.push(value);
    } else {
      return panic("Committing value but nowhere to commit to");
    }
  }
  protected commitNull(): void {
    this.commitValue(makeValue(Tag.Null, 0));
  }
  protected commitBoolean(v: boolean): void {
    this.commitValue(makeValue(v ? Tag.True : Tag.False, 0));
  }
  protected commitNumber(isDouble: boolean): void {
    const numberTag = isDouble ? Tag.Double : Tag.Integer;
    this.commitValue(makeValue(numberTag, 0));
  }
  protected commitString(s: string): void {
    let value: Value | undefined = undefined;
    if (this.handleRefs && this.isExpectionREf) {
      value = this.makeString(s);
    } else {
      const format = inferTransformedStringTypeKindForString(s, this.dateTimeRecognizer);
      if (format) {
        if (defined(transformedStringTypeTargetTypeKindsMap.get(format) as any).attributesProducer) {
          value = makeValue(Tag.TransformedString, this.internString(s));
        } else {
          value = makeValue(Tag.StringFormat, this.internString(format));
        }
      } else if (s.length <= 64) {
        value = this.makeString(s);
      } else {
        value = makeValue(Tag.UninternedString, 0);
      }
    }
    this.commitValue(value);
  }
  protected finish(): Value {
    const value = this.#rootValue;
    if (!value) return panic("Finished without root document");
    assert(!this.#ctx && !this.#contextStack.length, "Finished with contexts present");
    this.#rootValue = undefined;
    return value;
  }
  protected pushContext(): void {
    if (this.#ctx) this.#contextStack.push(this.#ctx);
    this.#ctx = {
      currentObject: undefined,
      currentArray: undefined,
      currentKey: undefined,
      currentNumberIsDouble: false,
    };
  }
  protected pushObjectContext(): void {
    this.pushContext();
    defined(this.#ctx).currentObject = [];
  }
  protected setPropertyKey(key: string): void {
    const ctx = this.context;
    ctx.currentKey = key;
  }
  protected finishObject(): void {
    const obj = this.context.currentObject;
    if (!obj) return panic("Object ended but not started");
    this.popContext();
    this.commitValue(this.internObject(obj));
  }
  protected pushArrayContext(): void {
    this.pushContext();
    defined(this.#ctx).currentArray = [];
  }
  protected finishArray(): void {
    const arr = this.context.currentArray;
    if (!arr) return panic("Array ended but not started");
    this.popContext();
    this.commitValue(this.internArray(arr));
  }
  protected popContext(): void {
    assert(!!this.#ctx, "Popping context when there isn't one");
    this.#ctx = this.#contextStack.pop();
  }
  equals(other: any): boolean {
    return this === other;
  }
  hashCode(): number {
    let hashAccumulator = hashCodeInit;
    for (const s of this.#strings) {
      hashAccumulator = addHashCode(hashAccumulator, hashString(s));
    }
    for (const s of Object.getOwnPropertyNames(this.#stringIndexes).sort()) {
      hashAccumulator = addHashCode(hashAccumulator, hashString(s));
      hashAccumulator = addHashCode(hashAccumulator, this.#stringIndexes[s]);
    }
    for (const o of this.#objects) {
      for (const v of o) {
        hashAccumulator = addHashCode(hashAccumulator, v);
      }
    }
    for (const o of this.#arrays) {
      for (const v of o) {
        hashAccumulator = addHashCode(hashAccumulator, v);
      }
    }
    return hashAccumulator;
  }
}

export class CompressedJSONFromString extends CompressedJSON<string> {
  async parse(input: string): Promise<Value> {
    return this.parseSync(input);
  }
  parseSync(input: string): Value {
    const json = JSON.parse(input);
    this.process(json);
    return this.finish();
  }
  private process(json: unknown): void {
    if (json === null) this.commitNull();
    else if (typeof json === "boolean") this.commitBoolean(json);
    else if (typeof json === "string") this.commitString(json);
    else if (typeof json === "number") {
      const isDouble = json !== Math.floor(json) || json < Number.MIN_SAFE_INTEGER || json > Number.MAX_SAFE_INTEGER;
      this.commitNumber(isDouble);
    } else if (Array.isArray(json)) {
      this.pushArrayContext();
      for (const v of json) {
        this.process(v);
      }
      this.finishArray();
    } else if (typeof json === "object") {
      this.pushObjectContext();
      for (const key of Object.getOwnPropertyNames(json)) {
        this.setPropertyKey(key);
        this.process((json as any)[key]);
      }
      this.finishObject();
    } else {
      return panic("Invalid JSON object");
    }
  }
}
