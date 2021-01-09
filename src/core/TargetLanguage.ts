import { RenderContext, Renderer } from "./Renderer";
import { Option, OptionDefinition } from "./RendererOption";
import { defined } from "./support";
import { TypeGraph } from "./TypeGraph";
import { SerializedRenderResult, serializeRenderResult } from "./Source";
import { StringTypeMapping } from "./TypeBuilder";
import { Type } from "./Type";
import { DateTimeRecognizer, DefaultDateTimeRecognizer } from "./DateTime";
import { ConvenienceRenderer } from "./ConvenienceRenderer";
import { mapMap } from "collection-utils";

export type MultiFileRenderResult = ReadonlyMap<string, SerializedRenderResult>;

export abstract class TargetLanguage {
  constructor(readonly displayName: string, readonly names: string[], readonly extension: string) {}
  protected abstract getOptions(): Option<any>[];
  get optionDefinitions(): OptionDefinition[] {
    return this.getOptions().map((o) => o.definition);
  }
  get cliOptionDefinitions() {
    let actual: OptionDefinition[] = [];
    let display: OptionDefinition[] = [];
    for (const { cliDefinitions } of this.getOptions()) {
      actual = actual.concat(cliDefinitions.actual);
      display = display.concat(cliDefinitions.display);
    }
    return { actual, display };
  }
  get name(): string {
    return defined(this.names[0]);
  }
  protected get defaultIndentation(): string {
    return "    ";
  }
  get stringTypeMapping(): StringTypeMapping {
    return new Map();
  }
  get supportsOptionalClassProperties(): boolean {
    return false;
  }
  get supportsUnionsWithBothNumberTypes(): boolean {
    return false;
  }
  get supportsFullObjectType(): boolean {
    return false;
  }
  needsTransformerForType(t: Type): boolean {
    return false;
  }
  get dateTimeRecognizer(): DateTimeRecognizer {
    return new DefaultDateTimeRecognizer();
  }
  protected abstract makeRenderer(renderContext: RenderContext, optionValues: Record<string, any>): Renderer;
  renderGraphAndSerialize(
    typeGraph: TypeGraph,
    givenOutputFilename: string,
    alphabetizeProperties: boolean,
    leadingComments: string[] | undefined,
    rendererOptions: Record<string, any>,
    indentation?: string
  ): MultiFileRenderResult {
    indentation = indentation || this.defaultIndentation;
    const renderContext = { typeGraph, leadingComments };
    const renderer = this.makeRenderer(renderContext, rendererOptions);
    if ((renderer as any).setAlphabetizeProperties !== undefined) {
      (renderer as ConvenienceRenderer).setAlphabetizeProperties(alphabetizeProperties);
    }
    const renderResult = renderer.render(givenOutputFilename);
    return mapMap(renderResult.sources, (s) => serializeRenderResult(s, renderResult.names, defined(indentation)));
  }
}
