import { assert, StringMap } from "../support";

export type JSONSchema = StringMap | boolean;
export abstract class JSONSchemaStore {
  readonly #schemas = new Map<string, JSONSchema>();
  private add(address: string, schema: JSONSchema): void {
    assert(!this.#schemas.has(address), "Cannot set a schema for an address twice");
    this.#schemas.set(address, schema);
  }
  abstract async fetch(address: string): Promise<JSONSchema | undefined>;
  async get(address: string, debugPrint: boolean): Promise<JSONSchema | undefined> {
    let schema = this.#schemas.get(address);
    if (schema) return schema;
    if (debugPrint) console.log(`trying to fetch ${address}`);
    try {
      schema = await this.fetch(address);
    } catch {}
    if (!schema) {
      if (debugPrint) console.log(`couldn't fetch ${address}`);
      return;
    }
    if (debugPrint) console.log(`successully fetched ${address}`);
    this.add(address, schema);
    return schema;
  }
}
