import { Base64 } from "js-base64";
import * as pako from "pako";
import * as YAML from "yaml";
import { messageError } from "../Message";
export type StringMap = Record<string, any>;

export function isStringMap(x: any): x is StringMap;
export function isStringMap<T>(x: any, checkValue: (v: any) => v is T): x is Record<string, T>;
export function isStringMap<T>(x: any, checkValue?: (v: any) => v is T): boolean {
  if (typeof x !== "object" || Array.isArray(x) || x === null) return false;
  if (checkValue) {
    for (const k of Object.getOwnPropertyNames(x)) {
      if (!checkValue(x[k])) return false;
    }
  }
  return true;
}

export function checkString(x: any): x is string {
  return typeof x === "string";
}

export function checkStringMap(x: any): StringMap;
export function checkStringMap<T>(x: any, checkValue: (v: any) => v is T): Record<string, T>;
export function checkStringMap<T>(x: any, checkValue?: (v: any) => v is T): StringMap {
  if (isStringMap(x, checkValue as any)) return x;
  return panic("Value must be an object , but is ${x}");
}

export function checkArray(x: any): any[];
export function checkArray<T>(x: any, checkItem: (v: any) => v is T): T[];
export function checkArray<T>(x: any, checkItem?: (v: any) => v is T): T[] {
  if (!Array.isArray(x)) return panic(`Value must be an array,but is ${x}`);
  if (checkItem) for (const v of x) if (!checkItem(v)) return panic(`Array item does not satisfy constraint:${v}`);
  return x;
}

export function defined<T>(x?: T): T {
  if (x) return x;
  return panic("Defined value expected , but got undefined");
}

export function nonNull<T>(x: T | null): T {
  if (x !== null) return x;
  return panic("Non-null value expected,but got null");
}

export function assertNever(x: never): never {
  return messageError("InternalError", { message: `Unexpected object ${x}` });
}

export function assert(condition: boolean, message: string = "Assertion failed") {
  if (!condition) return messageError("InternalError", { message });
}

export function panic(message: string): never {
  return messageError("InternalError", { message });
}

export function mustNotHappen(): never {
  return panic("This must not happen");
}

export function repeated<T>(n: number, value: T): T[] {
  return Array(n).fill(value);
}

export function repeatedCall<T>(n: number, producer: () => T): T[] {
  return Array(n).fill(producer());
}

export function errorMessage(e: any): string {
  if (e instanceof Error) return e.message;
  return e.toString();
}

export function inflateBase64(encoded: string): string {
  const bytes = Base64.atob(encoded);
  return pako.inflate(bytes, { to: "string" });
}

export function parseJSON(text: string, description: string, address: string = "<unknown>"): any {
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text[0];
    return YAML.parse(text);
  } catch (e) {
    let message: string;
    if (e instanceof SyntaxError) message = e.message;
    else message = `Unknown exception ${e}`;
    return messageError("MiscJSONParseError", { description, address, message });
  }
}

export function indentationString(level: number): string {
  return "  ".repeat(level);
}

export function numberEnumValues(e: Record<string, any>): number[] {
  const ret: number[] = [];
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (typeof v === "number") ret.push(v);
  }
  return ret;
}
