import { iterableEnumerate } from "collection-utils";
import { AnnotationData, IssueAnnotationData } from "./Annotation";
import { assignNames, Name, Namespace } from "./Naming";
import { annotated, newline, NewLineSource, Source, Sourcelike, sourcelikeToSource } from "./Source";
import { assert, panic } from "./support";
import { TargetLanguage } from "./TargetLanguage";
import { TypeGraph } from "./TypeGraph";

export type RenderResult = {
  sources: ReadonlyMap<string, Source>;
  names: ReadonlyMap<Name, string>;
};

export type BlankLinePosition = "none" | "interposing" | "leading" | "leading-and-interposing";
export type BlankLineConfig = BlankLinePosition | [BlankLinePosition, number];
function getBlankLineConfig(cfg: BlankLineConfig): { position: BlankLinePosition; count: number } {
  if (Array.isArray(cfg)) return { position: cfg[0], count: cfg[1] };
  return { position: cfg, count: 1 };
}

function lineIndentation(line: string): { indent: number; text: string | null } {
  const len = line.length;
  let indent = 0;
  for (let i = 0; i < len; i++) {
    const c = line.charAt(i);
    if (c === "") {
      indent++;
    } else if (c === "\t") {
      indent = (indent / 4 + 1) * 4;
    } else {
      return { indent, text: line.substring(i) };
    }
  }
  return { indent: 0, text: null };
}

export type RenderContext = {
  typeGraph: TypeGraph;
  leadingComments: string[] | undefined;
};

export type ForEachPostion = "first" | "last" | "middle" | "only";

class EmitContext {
  #lastNewLine?: NewLineSource;
  #emitted: Sourcelike[] = [];
  #currentEmitTarget: Sourcelike[] = [];
  #numBlankLinesNeeded: number = 0;
  #preventBlankLine: boolean = true;
  constructor() {
    this.#currentEmitTarget = this.#emitted = [];
  }
  get isEmpty(): boolean {
    return this.#emitted.length === 0;
  }
  get isNested(): boolean {
    return this.#emitted !== this.#currentEmitTarget;
  }
  get source(): Sourcelike[] {
    return this.#emitted;
  }
  private pushItem(item: Sourcelike): void {
    this.#currentEmitTarget.push(item);
    this.#preventBlankLine = false;
  }
  emitNewLine(): void {
    const nl = newline();
    this.pushItem(nl);
    this.#lastNewLine = nl;
  }
  emitItem(item: Sourcelike): void {
    if (!this.isEmpty)
      for (let i = 0; i < this.#numBlankLinesNeeded; i++) {
        this.emitNewLine();
      }
    this.#numBlankLinesNeeded = 0;
    this.pushItem(item);
  }
  containsItem(item: Sourcelike): boolean {
    const exsitingItem = this.#currentEmitTarget.find((value) => item === value);
    return exsitingItem !== undefined;
  }
  ensureBlankLine(numBlankLines: number): void {
    if (this.#preventBlankLine) return;
    this.#numBlankLinesNeeded = Math.max(this.#numBlankLinesNeeded, numBlankLines);
  }
  preventBlankLine(): void {
    this.#numBlankLinesNeeded = 0;
    this.#preventBlankLine = true;
  }
  changeIndent(offset: number): void {
    if (this.#lastNewLine === undefined) return panic(`Cannot change indent for the first line`);
    this.#lastNewLine.indentationChange += offset;
  }
}

export abstract class Renderer {
  protected readonly typeGraph!: TypeGraph;
  protected readonly leadingComments?: string[];
  #names?: ReadonlyMap<Name, string>;
  #finishedFiles: Map<string, Source> = new Map();
  #finishedEmitContexts: Map<string, EmitContext> = new Map();
  #emitContext = new EmitContext();
  constructor(protected readonly targetLanguage: TargetLanguage, renderContext: RenderContext) {
    this.typeGraph = renderContext.typeGraph;
    this.leadingComments = renderContext.leadingComments;
  }

  ensureBlankLine(numBlankLines: number = 1): void {
    this.#emitContext.ensureBlankLine(numBlankLines);
  }

  preventBlankLine(): void {
    this.#emitContext.preventBlankLine();
  }
  emitItem(item: Sourcelike): void {
    this.#emitContext.emitItem(item);
  }
  emitItemOnce(item: Sourcelike): boolean {
    if (this.#emitContext.containsItem(item)) return false;
    this.emitItem(item);
    return true;
  }
  emitLineOnce(...lineParts: Sourcelike[]): void {
    let lineEmitted = lineParts.length ? this.emitLineOnce(lineParts.length === 1 ? lineParts[0] : lineParts) : true;
    if (lineEmitted) this.#emitContext.emitNewLine();
  }
  emitLine(...lineParts: Sourcelike[]): void {
    if (lineParts.length === 1) this.#emitContext.emitItem(lineParts[0]);
    else if (lineParts.length > 1) this.#emitContext.emitItem(lineParts);
    this.#emitContext.emitNewLine();
  }
  emitMultiline(linesString: string): void {
    const lines = linesString.split("\n");
    const numLines = lines.length;
    if (!numLines) return;
    this.emitLine(lines[0]);
    let currentIndent = 0;
    for (let i = 0; i < numLines; i++) {
      const line = lines[i];
      const { indent, text } = lineIndentation(line);
      assert(indent % 4 === 0, "Indentation is not a multiple of 4");
      if (text !== null) {
        const newIndent = indent / 4;
        this.changeIndent(newIndent - currentIndent);
        currentIndent = newIndent;
        this.emitLine(text);
      } else {
        this.#emitContext.emitNewLine();
      }
    }
    if (currentIndent !== 0) this.changeIndent(-currentIndent);
  }
  gatherSource(emiiter: () => void): Sourcelike[] {
    const oldEmitContext = this.#emitContext;
    this.#emitContext = new EmitContext();
    emiiter();
    assert(!this.#emitContext.isNested, "emit context not restored correctly");
    const source = this.#emitContext.source;
    this.#emitContext = oldEmitContext;
    return source;
  }
  emitGatheredSource(items: Sourcelike[]): void {
    for (const item of items) {
      this.#emitContext.emitItem(item);
    }
  }
  emitAnnotated(annotation: AnnotationData, emitter: () => void): void {
    const lines = this.gatherSource(emitter);
    const source = sourcelikeToSource(lines);
    this.#emitContext.emitItem(annotated(annotation, source));
  }
  emitIssue(message: string, emitter: () => void): void {
    this.emitAnnotated(new IssueAnnotationData(message), emitter);
  }
  protected emitTable = (tableArray: Sourcelike[][]): void => {
    if (!tableArray.length) return;
    const table = tableArray.map((r) => r.map((sl) => sourcelikeToSource(sl)));
    this.#emitContext.emitItem({ kind: "table", table });
    this.#emitContext.emitNewLine();
  };
  changeIndent(offset: number): void {
    this.#emitContext.changeIndent(offset);
  }
  iterableForEach<T>(iterable: Iterable<T>, emitter: (v: T, position: ForEachPostion) => void): void {
    const items = Array.from(iterable);
    let onFirst = true;
    for (const [i, v] of iterableEnumerate(items)) {
      const position = items.length === 1 ? "only" : onFirst ? "first" : i === items.length - 1 ? "last" : "middle";
      emitter(v, position);
      onFirst = false;
    }
  }
  forEach<K, V>(
    iterable: Iterable<[K, V]>,
    interposedBlankLines: number,
    leadingBlankLines: number,
    emitter: (v: V, k: K, position: ForEachPostion) => void
  ): boolean {
    let didEmit = false;
    this.iterableForEach(iterable, ([k, v], position) => {
      if (position === "only" || position === "first") {
        this.ensureBlankLine(leadingBlankLines);
      } else {
        this.ensureBlankLine(interposedBlankLines);
      }
      emitter(v, k, position);
      didEmit = true;
    });
    return didEmit;
  }
  forEachWithBlankLines<K, V>(
    iterable: Iterable<[K, V]>,
    bankLineConfig: BlankLineConfig,
    emitter: (v: V, k: K, position: ForEachPostion) => void
  ): boolean {
    const { position, count } = getBlankLineConfig(bankLineConfig);
    const interposing = ["interposing", "leading-and-interposing"].includes(position);
    const leading = ["leading", "leading-and-interposing"].includes(position);
    return this.forEach(iterable, interposing ? count : 0, leading ? count : 0, emitter);
  }
  indent(fn: () => void): void {
    this.changeIndent(1);
    fn();
    this.changeIndent(-1);
  }
  protected abstract setUpNaming(): Iterable<Namespace>;
  protected abstract emitSouce(givenOutoutFilename: string): void;
  private assignName(): ReadonlyMap<Name, string> {
    return assignNames(this.setUpNaming());
  }
  protected initializeEmitContextForFilename(filename: string): void {
    if (this.#finishedEmitContexts.has(filename.toLowerCase())) {
      const exsitingEmitContext = this.#finishedEmitContexts.get(filename.toLowerCase());
      if (exsitingEmitContext) this.#emitContext = exsitingEmitContext;
    }
  }
  protected finishFile(filename: string): void {
    if (this.#finishedFiles.has(filename)) {
      console.log(
        `[warning] tried to emit file ${filename} more than once,if performing multi-file output this waring can be safely ignored.`
      );
    }
    const source = sourcelikeToSource(this.#emitContext.source);
    this.#finishedFiles.set(filename, source);
    this.#finishedEmitContexts.set(filename.toLowerCase(), this.#emitContext);
    this.#emitContext = new EmitContext();
  }
  render(givenOutputFilename: string): RenderResult {
    this.#names = this.assignName();
    this.emitSouce(givenOutputFilename);
    if (!this.#emitContext.isEmpty) this.finishFile(givenOutputFilename);
    return { sources: this.#finishedFiles, names: this.#names };
  }
  get names(): ReadonlyMap<Name, string> {
    if (!this.#names) return panic(`Names accessed before they were assigned`);
    return this.#names;
  }
}
