//@ts-ignore
import * as unicode from "@mark.probst/unicode-properties";
import { assert, assertNever, defined, panic } from ".";
import { messageAssert } from "../Message";
import { acronyms } from "./Acronyms";
export type NamingStyle =
  | "pascal"
  | "camel"
  | "underscore"
  | "upper-underscore"
  | "pascal-upper-acronyms"
  | "camel-upper-acronyms";

function computeAsciiMap(mapper: (codePoint: number) => string) {
  const charStringMap: string[] = [];
  const charNoEscapeMap: number[] = [];

  for (let i = 0; i < 128; i++) {
    let no = 0;
    const ret = mapper(i);
    if (ret === String.fromCharCode(i)) no = 1;
    charStringMap.push(ret);
    charNoEscapeMap.push(no);
  }
  return { charStringMap, charNoEscapeMap };
}

type CodePointPredicate = (codePoint: number) => boolean;

function precomputedCodePointPredicate(p: CodePointPredicate): CodePointPredicate {
  const ascii: boolean[] = [];
  for (let i = 0; i < 128; i++) {
    ascii.push(p(i));
  }
  return function (cp: number) {
    return cp < 128 ? ascii[cp] : p(cp);
  };
}

export function utf16ConcatMap(mapper: (utf16Unit: number) => string): (s: string) => string {
  const { charNoEscapeMap, charStringMap } = computeAsciiMap(mapper);
  return function (s: string): string {
    let cs: string[] | null = null,
      start = 0,
      i = 0;
    while (i < s.length) {
      const cc = s.charCodeAt(i);
      if (charNoEscapeMap[cc] !== 1) {
        cs = cs || [];
        cs.push(s.substring(start, i));
        const str = charStringMap[cc];
        cs.push(str || mapper(s.charCodeAt(i)));
        start++;
      }
      i++;
    }
    if (!cs) return s;
    cs.push(s.substring(start, i));
    return cs.join("");
  };
}

function isHighSurrogate(cc: number) {
  return cc >= 0xd800 && cc <= 0xdbff;
}

function isLowSurrogate(cc: number) {
  return cc >= 0xdc00 && cc <= 0xdfff;
}

export function utf32ConcatMap(mapper: (codePoint: number) => string): (s: string) => string {
  const { charNoEscapeMap, charStringMap } = computeAsciiMap(mapper);

  return function (s: string): string {
    let cs: string[] | null = null,
      start = 0,
      i = 0;
    while (i < s.length) {
      let cc = s.charCodeAt(i);
      if (charNoEscapeMap[cc] !== 1) {
        cs = cs || [];
        cs.push(s.substring(start, i));
        if (isHighSurrogate(cc)) {
          const high = cc,
            low = s.charCodeAt(i);
          i++;
          messageAssert(isLowSurrogate(low), "MiscUnicodeHighSurrogateWithoutLowSurrogate", {});
          const highBits = high - 0xd800,
            lowBits = low - 0xdc00;
          cc = 0x10000 + lowBits + (highBits << 10);
        }
        const str = charStringMap[cc];
        cs.push(str || mapper(cc));
        start++;
      }
      i++;
    }
    if (!cs) return s;
    cs.push(s.substring(start, i));
    return cs.join("");
  };
}

export function utf16LegalizeCharacters(isLegal: (utf16Unit: number) => boolean): (s: string) => string {
  return utf16ConcatMap((u) => (isLegal(u) ? String.fromCharCode(u) : ""));
}

export function repeatStrings(s: string, n: number) {
  return s.repeat(n);
}

export function intToHex(i: number, width: number): string {
  let s = i.toString(16);
  if (s.length >= width) return s;
  return "0".repeat(width - s.length) + s;
}

export function standardunicodeHexEscape(codePoint: number): string {
  if (codePoint <= 0xffff) return "\\u" + intToHex(codePoint, 4);
  return "\\U" + intToHex(codePoint, 8);
}

export function escapeNonPrintableMapper(p: CodePointPredicate, e: (cp: number) => string): (u: number) => string {
  return function (u: number): string {
    switch (u) {
      case 0x5c:
        return "\\\\";
      case 0x22:
        return "\\";
      case 0x0a:
        return "\\n";
      case 0x09:
        return "\\t";
      default:
        if (p(u)) return String.fromCharCode(u);
        return e(u);
    }
  };
}

export const utf16StringEscape = utf16ConcatMap(escapeNonPrintableMapper(isPrintable, standardunicodeHexEscape));
export const stringEscape = utf32ConcatMap(escapeNonPrintableMapper(isPrintable, standardunicodeHexEscape));
const mapper = [
  "Mc",
  "No",
  "Sk",
  "Me",
  "Nd",
  "Po",
  "Lt",
  "Pc",
  "Sm",
  "Zs",
  "Lu",
  "Pd",
  "So",
  "Pe",
  "Pf",
  "Ps",
  "Sc",
  "Ll",
  "Lm",
  "Pi",
  "Nl",
  "Mn",
  "Lo",
];

export function isPrintable(cp: number): boolean {
  if (cp > 0xffff) return false;
  const category = unicode.getCategory(cp);
  return mapper.includes(category);
}

export function isAscii(cp: number): boolean {
  return cp < 128;
}

function include(arr: string[]): CodePointPredicate {
  return function (cp) {
    const category = unicode.getCategory(cp);
    return arr.includes(category);
  };
}

export const isLetter = include(["Lu", "Ll", "Lt", "Lo"]);
export const isDigit = include(["Nd"]);
export const isNumeric = include(["No", "Nd", "Nl"]);

export function isLetterOrDigit(cp: number): boolean {
  return isLetter(cp) || isDigit(cp);
}

export function isLetterOrUnderscore(cp: number): boolean {
  return isLetter(cp) || cp === 0x5f;
}
export function isLetterOrUnderscoreOrDigit(cp: number): boolean {
  return isLetterOrUnderscore(cp) || isDigit(cp);
}
export function isWordCharacter(cp: number): boolean {
  return isLetter(cp) || isDigit(cp);
}

export function trimEnd(str: string): string {
  let l = str.length,
    firstWS = l,
    i = l - 1;
  while (i--) {
    if (!unicode.isWhiteSpace(str.charCodeAt(i))) break;
    firstWS = i;
  }
  if (firstWS === l) return str;
  return str.substr(0, firstWS);
}

function modifyFirstChar(f: (c: string) => string, s: string): string {
  if (s === "") return "";
  return f(s[0]) + s.slice(1);
}

export function capitalize(str: string): string {
  return modifyFirstChar((c) => c.toUpperCase(), str);
}

export function decapitalize(str: string): string {
  return modifyFirstChar((c) => c.toLowerCase(), str);
}

const wordSepRegexp = /[-_. ]+/;
export function pascalCase(str: string): string {
  const words = str.split(wordSepRegexp).map(capitalize);
  return words.join("");
}

export function camelCase(str: string): string {
  return decapitalize(pascalCase(str));
}

export function startWithLetter(isAllowedStart: CodePointPredicate, upper: boolean, str: string): string {
  const modify = upper ? capitalize : decapitalize;
  if (!str) return modify("empty");
  if (isAllowedStart(str.charCodeAt(0))) return modify(str);
  return modify("the" + str);
}

const knownAcronyms = new Set(acronyms);

export type WrodInName = { word: string; isAcronym: boolean };
const fastIsWordCharacter = precomputedCodePointPredicate(isWordCharacter);
const fastIsNonWordCharecter = precomputedCodePointPredicate((cp) => !isWordCharacter(cp));
const fastIsLowerCase = precomputedCodePointPredicate((cp) => unicode.isLowerCase(cp));
export const fastIsUpperCase = precomputedCodePointPredicate((cp) => unicode.isUpperCase(cp));
const fastNonLetter = precomputedCodePointPredicate((cp) => !unicode.isLowerCase(cp) && !unicode.isUpperCase(cp));
const fastIsDigit = precomputedCodePointPredicate(isDigit);

export function splitIntoWords(s: string): WrodInName[] {
  const intervals: [number, number, boolean][] = [],
    len = s.length;
  let i = 0,
    intervalStart: number | undefined = undefined,
    lastLowerCaseIndex: number | undefined = undefined;

  function atEnd(): boolean {
    return i >= len;
  }

  function currentCodePoint(): number {
    return defined(s.codePointAt(i));
  }

  function skipWhile(p: CodePointPredicate): void {
    while (!atEnd()) {
      const cp = currentCodePoint();
      if (!p(cp)) break;
      if (fastIsLowerCase(cp)) lastLowerCaseIndex = i;
      i++;
    }
  }
  function skipNonWord(): void {
    skipWhile(fastIsNonWordCharecter);
  }
  function skipLowerCase(): void {
    skipWhile(fastIsLowerCase);
  }
  function skipUpperCase(): void {
    skipWhile(fastIsUpperCase);
  }
  function skipNonLetter(): void {
    skipWhile(fastIsDigit);
  }
  function skipDigit() {
    skipWhile(fastIsDigit);
  }
  function startInterval(): void {
    assert(intervalStart === undefined, "Interval started before last one was committed");
    intervalStart = i;
  }
  function commitInterval(): void {
    if (intervalStart === undefined) return panic("Tried to commit interval without starting one");
    assert(i > intervalStart, "Interval  must be non-empty");
    if (!atEnd() && isLowSurrogate(currentCodePoint())) i++;
    const allUpper = lastLowerCaseIndex === undefined || lastLowerCaseIndex < intervalStart;
    intervals.push([intervalStart, i, allUpper]);
    intervalStart = undefined;
  }
  function intervalLength(): number {
    if (intervalStart === undefined) return panic("Tried to get interval length without starting one");
    return i - intervalStart;
  }
  for (;;) {
    skipNonWord();
    if (atEnd()) break;
    startInterval();
    if (fastIsLowerCase(currentCodePoint())) {
      skipLowerCase();
      skipDigit();
    } else if (fastIsUpperCase(currentCodePoint())) {
      skipUpperCase();
      if (intervalLength() === 1) {
        skipLowerCase();
        skipDigit();
      } else if (isDigit(currentCodePoint())) {
        skipDigit();
      } else {
        if (fastIsWordCharacter(currentCodePoint())) i -= 1;
      }
    } else {
      skipNonLetter();
    }
    commitInterval();
  }
  const words: WrodInName[] = [];
  for (const [start, end, allUpper] of intervals) {
    const word = s.slice(start, end);
    const isAcronym = (lastLowerCaseIndex !== undefined && allUpper) || knownAcronyms.has(word.toLowerCase());
    words.push({ word, isAcronym });
  }
  return words;
}

export type WordStyle = (word: string) => string;
export function firstUpperWordStyle(s: string): string {
  assert(s.length > 0, "Cannot style an empty string");
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}
export function allUpperWordStyle(s: string): string {
  return s.toUpperCase();
}
export function originalWord(s: string): string {
  return s;
}
export function allLowerWordStyle(s: string): string {
  return s.toLowerCase();
}
function styleWord(style: WordStyle, word: string): string {
  assert(word.length > 0, "Tried to style an empty word");
  const ret = style(word);
  assert(ret.length > 0, "Word style must not make word empty");
  return ret;
}

export function combineWords(
  words: WrodInName[],
  remove: (s: string) => string,
  first: WordStyle,
  rest: WordStyle,
  firstAcronym: WordStyle,
  restAcronym: WordStyle,
  sep: string,
  isStart: CodePointPredicate
): string {
  const legalizeWords: WrodInName[] = [];
  for (const w of words) {
    const word = remove(w.word);
    if (!word.length) continue;
    legalizeWords.push({ word, isAcronym: w.isAcronym });
  }
  if (!legalizeWords.length) {
    const validEmpty = remove("empty");
    assert(validEmpty.length > 0, "Word 'empty' is invalid in target language");
    legalizeWords.push({ word: validEmpty, isAcronym: false });
  }
  const styleWords: string[] = [],
    f = legalizeWords[0],
    fstyle = f.isAcronym ? firstAcronym : first,
    styleFirst = styleWord(fstyle, f.word);
  let remain: WrodInName[] = [];
  if (!isStart(defined(styleFirst.codePointAt(0)))) {
    const valid = remove("the");
    assert(valid.length > 0, "word 'the' is invalid in the target language");
    const style = styleWord(first, valid);
    assert(isStart(defined(style.codePointAt(0))), 'The first character of styling "the" is not a start character');
    styleWords.push(style);
    remain = legalizeWords;
  } else {
    styleWords.push(styleFirst);
    remain = legalizeWords.slice(1);
  }
  for (const w of remain) {
    const style = w.isAcronym ? restAcronym : rest;
    styleWords.push(styleWord(style, w.word));
  }
  return styleWords.join(sep);
}

export function addPrefixIfNecessary(prefix: string, name: string): string {
  return name.startsWith(prefix) ? name : prefix + name;
}

export function makeNameStyle(
  namingStyle: NamingStyle,
  legalizeName: (name: string) => string,
  prefix: string
): (rawName: string) => string {
  let sep: string, first: WordStyle, rest: WordStyle, firstAcronym: WordStyle, restAcronym: WordStyle;
  if (
    namingStyle === "pascal" ||
    namingStyle === "camel" ||
    namingStyle === "pascal-upper-acronyms" ||
    namingStyle === "camel-upper-acronyms"
  ) {
    sep = "";
    if (namingStyle === "pascal-upper-acronyms" || namingStyle === "camel-upper-acronyms") {
      rest = firstUpperWordStyle;
      restAcronym = allUpperWordStyle;
    } else {
      rest = restAcronym = firstUpperWordStyle;
    }
  } else {
    sep = "_";
  }
  switch (namingStyle) {
    case "pascal":
    case "pascal-upper-acronyms":
      first = firstAcronym = firstUpperWordStyle;
      break;
    case "camel":
    case "camel-upper-acronyms":
      first = firstAcronym = allLowerWordStyle;
      break;
    case "underscore":
      first = rest = firstAcronym = restAcronym = allLowerWordStyle;
      break;
    case "upper-underscore":
      first = rest = firstAcronym = restAcronym = allUpperWordStyle;
      break;
    default:
      return assertNever(namingStyle);
  }
  return (original:string){
    const words = splitIntoWords(original)
    const styled = combineWords(words, legalizeName, first, rest, firstAcronym, restAcronym, sep, isLetterOrUnderscore)
    if(prefix) return addPrefixIfNecessary(prefix, styled)
    return styled
  }
}
