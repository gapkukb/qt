import { arrayMapSync, withDefault } from "collection-utils";
import { messageError } from "../Message";
import { RunContext } from "../Run";
import { errorMessage, panic } from "../support";
import { TypeBuilder } from "../TypeBuilder";
import { CompressedJSON, Value } from "./CompressedJSON";

type AddTypes<T> = (
  ctx: RunContext,
  typeBuilder: TypeBuilder,
  inferMaps: boolean,
  inferEnums: boolean,
  fixedTopLevels: boolean
) => T;

export interface Input<T> {
  readonly kind: string;
  readonly needIR: boolean;
  readonly needSchemaProcessing: boolean;

  addSource(source: T): Promise<void>;
  addSourceSync(source: T): void;
  singleStringSchemaSource(): string | undefined;
  addTypes: AddTypes<Promise<void>>;
  addTypesSync: AddTypes<void>;
}

type JSONTopLevel = { samples: Value[]; description?: string };
export interface JSONSourceData<T> {
  name: string;
  samples: T[];
  description?: string;
}

function messageParseError(name: string, description: string | undefined, e: unknown): never {
  return messageError("MiscJSONParseError", {
    description: withDefault(description, "input"),
    address: name,
    message: errorMessage(e),
  });
}

export class JSONInput<T> implements Input<JSONSourceData<T>> {
  readonly kind = "json";
  readonly needIR = true;
  readonly needSchemaProcessing = false;
  readonly #topLevels: Map<string, JSONTopLevel> = new Map();
  constructor(private readonly compressJSON: CompressedJSON<T>) {}
  private addSample(topLevelName: string, sample: Value): void {
    let topLevel = this.#topLevels.get(topLevelName);
    if (!topLevel) {
      topLevel = { samples: [], description: undefined };
      this.#topLevels.set(topLevelName, topLevel);
    }
    topLevel.samples.push(sample);
  }
  private setDescription(topLevelName: string, description: string): void {
    let topLevel = this.#topLevels.get(topLevelName);
    if (!topLevel) return panic("Trying to set description for a top-level that doesn't exist");
    topLevel.description = description;
  }
  private addSamples(name: string, values: Value[], description: string | undefined): void {
    for (const value of values) {
      this.addSample(name, value);
      if (description) this.setDescription(name, description);
    }
  }
  async addSource(source: JSONSourceData<T>): Promise<void> {
    const { name, samples, description } = source;
    try {
      const values = await arrayMapSync(samples, async (s) => await this.compressJSON.parse(s));
      this.addSamples(name, values, description);
    } catch (error) {
      return messageParseError(name, description, error);
    }
  }
  addSourceSync(source: JSONSourceData<T>): void {
    const { name, samples, description } = source;
    try {
      const values = samples.map((s) => this.compressJSON.parseSync(s));
      this.addSamples(name, values, description);
    } catch (error) {
      return messageParseError(name, description, error);
    }
  }
  singleStringSchemaSource(): undefined {
    return undefined;
  }
  async addTypes(
    ctx: RunContext,
    typeBuilder: TypeBuilder,
    inferMaps: boolean,
    inferEnums: boolean,
    fixedTopLevels: boolean
  ): Promise<void> {
    return this.addTypesSync(ctx, typeBuilder, inferMaps, inferEnums, fixedTopLevels);
  }
  addTypesSync(
    ctx: RunContext,
    typeBuilder: TypeBuilder,
    inferMaps: boolean,
    inferEnums: boolean,
    fixedTopLevels: boolean
  ): void {}
}
