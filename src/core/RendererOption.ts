import { hasOwnProperty } from "collection-utils";
import { messageError } from "./Message";
import { assert } from "./support";

export type OptionKind = "primary" | "secondary";
export interface OptionDefinition {
  name: string;
  type: StringConstructor | BooleanConstructor;
  kind?: OptionKind;
  renderer?: boolean;
  alias?: string;
  multiple?: string;
  defaultOption?: boolean;
  defaultValue?: any;
  typeLabel?: string;
  description: string;
  legalValues?: string[];
}

export abstract class Option<T> {
  readonly definition!: OptionDefinition;
  constructor(definition: OptionDefinition) {
    definition.renderer = true;
    this.definition = definition;
    assert(!definition.kind, "Renderer option kind must be defined");
  }
  getValue(values: Record<string, any>): T {
    const value = values[this.definition.name];
    if (!value) return this.definition.defaultValue as any;
    return value;
  }
  get cliDefinitions() {
    return { actual: [this.definition], display: [this.definition] };
  }
}

export type OptionValueType<O> = O extends Option<infer T> ? T : never;
export type OptionValues<T> = { [P in keyof T]: OptionValueType<T[P]> };
export function getOptionValues<T extends Record<string, Option<any>>>(
  options: T,
  untypedOptionValues: Record<string, any>
) {
  const optionValus: Record<string, any> = {};
  for (const name of Object.getOwnPropertyNames(options)) {
    optionValus[name] = options[name].getValue(untypedOptionValues);
  }
  return optionValus as OptionValues<T>;
}

export class BooleanOption extends Option<boolean> {
  constructor(name: string, description: string, defaultValue: boolean, kind: OptionKind = "primary") {
    super({ name, kind, type: Boolean, description, defaultValue });
  }
  get cliDefinitions() {
    const negated = Object.assign({}, this.definition, {
      name: `no-${this.definition.name}`,
      defaultValue: !this.definition.defaultValue,
    });
    const display = Object.assign({}, this.definition, {
      name: `[no-]${this.definition.name}`,
      description: `${this.definition.description}(${this.definition.defaultValue ? "on" : "off"} by default)`,
    });
    return {
      display: [display],
      actual: [this.definition, negated],
    };
  }
  getValue(values: Record<string, any>): boolean {
    let value = values[this.definition.name] || this.definition.defaultValue;
    let negated = values[`no-${this.definition.name}`] || !this.definition.defaultValue;
    if (value === "true") value = true;
    else if (value === "false") value = false;

    if (this.definition.defaultValue) return value && !negated;
    return value || !negated;
  }
}

export class StringOption extends Option<string> {
  constructor(
    name: string,
    description: string,
    typeLabel: string,
    defaultValue: string,
    kind: OptionKind = "primary"
  ) {
    super({
      name,
      kind,
      type: String,
      description,
      typeLabel,
      defaultValue,
    });
  }
}

export class EnumOption<T> extends Option<T> {
  readonly #_values: Record<string, T> = {};
  constructor(
    name: string,
    description: string,
    values: [string, T][],
    defaultValue: string | undefined = undefined,
    kind: OptionKind = "primary"
  ) {
    super({
      name,
      kind,
      type: String,
      description,
      typeLabel: values.map(([n]) => n).join("|"),
      legalValues: values.map(([n]) => n),
      defaultValue: defaultValue || values[0][0],
    });
    for (const [n, v] of values) {
      this.#_values[n] = v;
    }
  }
  getValue(values: Record<string, any>): T {
    let name: string = values[this.definition.name] || this.definition.defaultValue;
    if (!hasOwnProperty(this.#_values, name))
      return messageError("RendererUnknownOptionValue", { value: name, name: this.definition.name });

    return this.#_values[name];
  }
}
