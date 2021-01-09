import { StringMap } from "./support";
import { Ref } from "./input/JSONSchemaInput";

export type ErrorProperties =
  | { kind: "InternalError"; properties: { message: string } }
  // misc
  | { kind: "MiscJSONParseError"; properties: { description: string; address: string; message: string } }
  | { kind: "MiscReadError"; properties: { fileOrURIL: string; message: string } }
  | { kind: "MiscUnicodeHighSurrogateWithoutLowSurrogate"; properties: {} }
  | { kind: "MiscInvalidMinMaxConstraint"; properties: { min: number; max: number } }
  //inference
  | { kind: "InferenceJSONReferenceNotRooted"; properties: { reference: string } }
  | { kind: "InferenceJSONReferenceToUnion"; properties: { reference: string } }
  | { kind: "InferenceJSONReferenceWrongProperty"; properties: { reference: string } }
  | { kind: "InferenceJSONReferenceInvalidArrayIndex"; properties: { reference: string } }
  //JSON Schema input
  | { kind: "SchemaArrayIsInvalidSchema"; properties: { ref: Ref } }
  | { kind: "SchemaNullIsInvalidSchema"; properties: { ref: Ref } }
  | { kind: "SchemaRefMustBeString"; properties: { actual: string; ref: Ref } }
  | { kind: "SchemaAdditionTypesForbidRequired"; properties: { ref: Ref } }
  | { kind: "SchemaNoTypeSpecified"; properties: { ref: Ref } }
  | { kind: "SchemaInvalidType"; properties: { type: string; ref: Ref } }
  | { kind: "SchemaFalseNotSupported"; properties: { ref: Ref } }
  | { kind: "SchemaInvalidJSONSchemaType"; properties: { type: string; ref: Ref } }
  | { kind: "SchemaRequiredMustBeStringOrStringArray"; properties: { actual: any; ref: Ref } }
  | { kind: "SchemaRequiredElementMustBeString"; properties: { element: any; ref: Ref } }
  | { kind: "SchemaArrayItemsMustBeStringOrArray"; properties: { actual: any; ref: Ref } }
  | { kind: "SchemaTypeMustBeStringOrStringArray"; properties: { actual: any } }
  | { kind: "SchemaTypeElementMustBeString"; properties: { element: any; ref: Ref } }
  | { kind: "SchemaIDMustHaveAddress"; properties: { id: string; ref: Ref } }
  | { kind: "SchemaWrongAccessorEntryArrayLength"; properties: { operation: string; ref: Ref } }
  | { kind: "SchemaSetOperationCasesIsNotArray"; properties: { operation: string; cases: any; ref: Ref } }
  | { kind: "SchemaCannotGetTypesFromBoolean"; properties: { ref: Ref } }
  | { kind: "SchemaMoreThanOneUnionMemberName"; properties: { names: string[] } }
  | { kind: "SchemaCannotGetTypesFromBoolean"; properties: { ref: string } }
  | { kind: "SchemaCannotIndexArrayWithNonNumber"; properties: { actual: string; ref: Ref } }
  | { kind: "SchemaIndexNotInArray"; properties: { index: number; ref: Ref } }
  | { kind: "SchemaKeyNotInObject"; properties: { key: string; ref: Ref } }
  | { kind: "SchemaFetchError"; properties: { address: string; base: Ref } }
  | { kind: "SchemaFetchErrorTopLevel"; properties: { address: string } }
  | { kind: "SchemaFetchErrorAdditional"; properties: { address: string } }
  // Graphql input
  | { kind: "GraphQLQueriesDefined"; properties: {} }
  // Driver
  | { kind: "DriverUnknownSourceLanguage"; properties: { lang: string } }
  | { kind: "DriverUnknownOutputLanguage"; properties: { lang: string } }
  | { kind: "DriverMoreThanOneInputGiven"; properties: { topLevel: string } }
  | { kind: "DriverCannotInferNameForSchema"; properties: { uri: string } }
  | { kind: "DriverNoGraphQLQueryGiven"; properties: {} }
  | { kind: "DriverNoGraphQLSchemaInDir"; properties: { dir: string } }
  | { kind: "DriverMoreThanOneGraphQLSchemaInDir"; properties: { dir: string } }
  | { kind: "DriverSourceLangMustBeGraphQL"; properties: {} }
  | { kind: "DriverGraphQLSchemaNeeded"; properties: {} }
  | { kind: "DriverInputFileDoesNotExist"; properties: { filename: string } }
  | { kind: "DriverCannotMixJSONWithOtherSamples"; properties: { dir: string } }
  | { kind: "DriverCannotMixNonJSONInputs"; properties: { dir: string } }
  | { kind: "DriverUnknownDebugOption"; properties: { option: string } }
  | { kind: "DriverNoLanguageOrExtention"; properties: {} }
  | { kind: "DriverCLIOptionParsingFailed"; properties: { message: string } }
  // IR
  | { kind: "IRNoForwardDeclarableTypeInCycle"; properties: {} }
  | { kind: "IRTypeAttributesNotPropagated"; properties: { count: number; indexes: number[] } }
  | { kind: "IRNoEmptyUnions"; properties: {} }
  // Rendering
  | { kind: "RendererUnknownOptionValue"; properties: { value: string; name: string } };

export type ErrorKinds = ErrorProperties extends { kind: infer K } ? K : never;
type ErrorMessages = { readonly [K in ErrorKinds]: string };

const errorMessages: ErrorMessages = {
  InternalError: "Internal error:${message}",
  MiscReadError: "Cannot read from file or URL ${fileOrURL}:${message}",
  MiscJSONParseError: "Syntax error in ${description} JSON ${address}:${message}",
  MiscUnicodeHighSurrogateWithoutLowSurrogate: "Malformed unicode:High surrogate not allowed by low surrogate",
  MiscInvalidMinMaxConstraint: "Invalid min-max constraint:${min}-${max}",
  InferenceJSONReferenceNotRooted: "JSON reference does not start with '#/' : ${reference}",
  InferenceJSONReferenceToUnion: "JSON reference points to a union type:${reference}",
  InferenceJSONReferenceWrongProperty: "JSON reference points to a non-existant property:${reference}",
  InferenceJSONReferenceInvalidArrayIndex: "JSON referece uses invalid array index:${reference}",
  SchemaArrayIsInvalidSchema: "An array is not a valid JSON Schema at ${ref}",
  SchemaNullIsInvalidSchema: "null is not a valid JSON Schema at ${ref}",
  SchemaRefMustBeString: "$ref must be a string,but is an ${actual} at ${ref}",
  SchemaAdditionTypesForbidRequired:
    "Cannot have non-specified required properties but forbidden additionalTypes at ${ref}",
  SchemaNoTypeSpecified: "JSON Schema must specify at least one type at ${ref}",
  SchemaInvalidType: "Invalid type ${type} in JSON Schema at ${ref}",
  SchemaFalseNotSupported: "Schema 'false' is not supported at ${ref}",
  SchemaInvalidJSONSchemaType: "Value of type ${type} is not valid JSON Schema at ${ref}",
  SchemaRequiredMustBeStringOrStringArray: "'required' must be string or array of strings,but is ${actual} at ${ref}",
  SchemaRequiredElementMustBeString: "'required' must contain only strings , but it has ${element} , at ${ref}",
  SchemaTypeMustBeStringOrStringArray: "'type' must contain only strings,but it has ${element} , at ${ref}",
  SchemaTypeElementMustBeString: "'type' must contain only strings,but it has ${element}",
  SchemaArrayItemsMustBeStringOrArray: "Array items must be an array or an object , but is ${actual}",
  SchemaIDMustHaveAddress: "$id ${id} does not have an address at ${ref}",
  SchemaWrongAccessorEntryArrayLength:
    "Accessor entry array must have the same number of entries as the ${operation} at ${ref}",
  SchemaSetOperationCasesIsNotArray: "${operation} cases must be an array , but is ${cases}, at ${ref}",
  SchemaMoreThanOneUnionMemberName: "More than one name given for union member :${names}",
  SchemaCannotGetTypesFromBoolean:
    "Accessor entry array must have the same number of entries as the ${operation},${ref}",
  SchemaCannotIndexArrayWithNonNumber:
    "Trying to index array in schema with key that is not a number,but is ${actual} at ${ref}",
  SchemaIndexNotInArray: "Index ${index} out of range of schema array at ${ref}",
  SchemaKeyNotInObject: "Key ${key} not in schema object at ${ref}",
  SchemaFetchError: "Could not fetch schema ${address} , referred to from ${base}",
  SchemaFetchErrorTopLevel: "Could not fetch top-level schema ${address}",
  SchemaFetchErrorAdditional: "Could not fetch additional schema ${address}",
  GraphQLQueriesDefined: "GraphQL file does not have any queries defined.",
  DriverUnknownSourceLanguage: "Unknown source language ${lang}",
  DriverUnknownOutputLanguage: "Unknown output language ${lang}",
  DriverMoreThanOneInputGiven: "More than one input given for top-level ${topLevel}",
  DriverCannotInferNameForSchema: "Cannot infer name for schema ${uri}",
  DriverNoGraphQLQueryGiven: "Please specifiy at least one GraphQL query as input",
  DriverNoGraphQLSchemaInDir: "No GraphQL schema in ${dir}",
  DriverMoreThanOneGraphQLSchemaInDir: "More than one GraphQL schema in ${dir}",
  DriverSourceLangMustBeGraphQL: "If a GraphQL schema is specified , the source language must be GraphQL",
  DriverGraphQLSchemaNeeded: "Please specify a GraphQL schema with --graphql-schema or --graphql-introspect",
  DriverInputFileDoesNotExist: "Input file ${filename} does not exist",
  DriverNoLanguageOrExtention: "Please specify a language (--lang) or an output file extension",
  DriverCannotMixJSONWithOtherSamples:
    "Cannot mix JSON samples with JSON Schemas,GraphQL,or TypeScript in input subdirectory ${dir}",
  DriverCannotMixNonJSONInputs: "Cannot mix JSON Schema,GraphQL,and TypeScript in an input subdirectory ${dir}",
  DriverUnknownDebugOption: "Unknown debug option ${option}",
  DriverCLIOptionParsingFailed: "Option parsing failed:${message}",
  IRNoForwardDeclarableTypeInCycle:
    "Cannot resolve cycle because it does not contain types that can be forward declared",
  IRTypeAttributesNotPropagated: "Type attributes for ${count} types were not carried over to the new graph:${indexed}",
  IRNoEmptyUnions: "Trying to make an empty union - do you have an impossible type in your schema?",
  RendererUnknownOptionValue: "Unknown value ${value} for option ${name}",
};

export type ErrorPropertiesForName<K> = Extract<ErrorProperties, { kind: K }> extends { properties: infer P }
  ? P
  : never;

export class QuickTypeError extends Error {
  constructor(
    readonly errorMessage: string,
    readonly messageName: string,
    userMessage: string,
    readonly properties: StringMap
  ) {
    super(userMessage);
  }
}

export function messageError<N extends ErrorKinds>(kind: N, properties: ErrorPropertiesForName<N>): never {
  const message = errorMessages[kind];
  let userMessage: string = message;

  for (const name of Object.getOwnPropertyNames(properties)) {
    let value = (<StringMap>properties)[name];
    if (typeof value === "object" && typeof value.toString === "function") value = value.message;
    else if (typeof value.message === "string") value = value.message;
    else if (typeof value !== "string") value = JSON.stringify(value);
    userMessage = userMessage.replace("${" + name + "}", value);
  }
  throw new QuickTypeError(message, kind, userMessage, properties as StringMap);
}

export function messageAssert<N extends ErrorKinds>(
  assertion: boolean,
  kind: N,
  properties: ErrorPropertiesForName<N>
): void {
  if (assertion) return;
  return messageError(kind, properties);
}
