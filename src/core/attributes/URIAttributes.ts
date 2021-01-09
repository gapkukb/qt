import { setUnionManyInto } from "collection-utils";
import { Type } from "../Type";
import { emptyTypeAttributes, TypeAttributeKind, TypeAttributes } from "./TypeAttributes";
import URI from "urijs";
import { JSONSchema } from "../input/JSONSchemaStore";
import { JSONSchemaAttributes, JSONSchemaType, Ref } from "../input/JSONSchemaInput";
import { checkArray, checkString } from "../support";

const protocolsSchemaProperty = "qt-uri-protocols";
const extensionSchemaProperty = "qt-uri-extensions";
type URIAttributes = [ReadonlySet<string>, ReadonlySet<string>];
class URITypeAttributeKind extends TypeAttributeKind<URIAttributes> {
  constructor() {
    super("uriAttributes");
  }
  get inIndentity(): boolean {
    return true;
  }
  combine(attrs: URIAttributes[]): URIAttributes {
    const protocols = attrs.map((a) => a[0]);
    const extensions = attrs.map((a) => a[1]);
    return [setUnionManyInto(new Set(), protocols), setUnionManyInto(new Set(), extensions)];
  }
  makeInferred() {
    return undefined;
  }
  addToSchema(schema: Record<string, unknown>, t: Type, attrs: URIAttributes): void {
    if (t.kind !== "string" && t.kind !== "uri") return;
    const [protocols, extensions] = attrs;
    if (extensions.size > 0) schema[protocolsSchemaProperty] = Array.from(protocols).sort();
    if (extensions.size > 0) schema[extensionSchemaProperty] = Array.from(extensions).sort();
  }
}

export const uriTypeAttributeKind: TypeAttributeKind<URIAttributes> = new URITypeAttributeKind();
const extensionRegexp = /^.+(\.[^./\\]+)$/;
function pathExtension(path: string): string | undefined {
  const matched = path.match(extensionRegexp);
  if (!matched) return;
  return matched[1];
}

export function uriInferenceAttributesProducer(s: string): TypeAttributes {
  try {
    const uri = URI(s);
    const ext = pathExtension(uri.path());
    const exts = ext ? [ext.toLowerCase()] : [];
    return uriTypeAttributeKind.makeAttributes([new Set([uri.protocol().toLowerCase()]), new Set(exts)]);
  } catch {
    return emptyTypeAttributes;
  }
}

export function uriSchemaAttributesProducer(
  schema: JSONSchema,
  ref: Ref,
  types: Set<JSONSchemaType>
): JSONSchemaAttributes | undefined {
  if (typeof schema !== "object" || !types.has("string")) return;
  let protocols: ReadonlySet<string>;
  let maybe = schema[protocolsSchemaProperty];
  if (maybe) protocols = new Set(checkArray(maybe, checkString));
  else protocols = new Set();
  let exts: ReadonlySet<string>;
  maybe = schema[extensionSchemaProperty];
  if (maybe) exts = new Set(checkArray(maybe, checkString));
  else exts = new Set();
  if (protocols.size === 0 && exts.size === 0) return;
  return { forString: uriTypeAttributeKind.makeAttributes([protocols, exts]) };
}
