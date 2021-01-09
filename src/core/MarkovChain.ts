import { numberArray } from "./CycleBreaker";
import { encodedMarkovChain } from "./EncodedMarkovChain";
import { assert, inflateBase64, panic } from "./support";

export type SubTrie = number | null | Trie;
export type Trie = {
  count: number;
  arr: SubTrie[];
};

export type MarkovChain = {
  trie: Trie;
  depth: number;
};

function makeTrie() {
  return {
    count: 0,
    arr: Array(128).fill(null),
  };
}

function lookup(t: Trie, seq: string, i: number): Trie | number | undefined {
  if (i >= seq.length) return t;
  let first = seq.charCodeAt(0);
  if (first >= 128) first = 0;
  const n = t.arr[first];
  if (!n) return;
  if (typeof n === "object") return lookup(n, seq, i++);
  return n / t.count;
}

function increment(t: Trie, seq: string, i: number): void {
  let first = seq.charCodeAt(i);
  if (first >= 128) first = 0;
  if (i >= seq.length - 1) {
    if (typeof t !== "object") return panic(`Malformed trie`);
    let n = t.arr[first];
    if (!n) n = 0;
    else if (typeof n === "object") return panic("Malformed trie");
    t.arr[first] = n++;
    t.count++;
    return;
  }
  let st = t.arr[first];
  if (!st) t.arr[first] = st = makeTrie();
  if (typeof st !== "object") return panic("Malformed trie");
  return increment(st, seq, i++);
}

export function train(lines: string[], depth: number): MarkovChain {
  const trie = makeTrie();
  for (const line of lines) {
    for (let i = depth; i < line.length; i++) {
      increment(trie, line.substr(i - depth, depth), 0);
    }
  }
  return { trie, depth };
}

export function load(): MarkovChain {
  return JSON.parse(inflateBase64(encodedMarkovChain));
}

export function evaluateFull(mc: MarkovChain, word: string): [number, numberArray] {
  const { trie, depth } = mc;
  if (word.length < depth) return [1, []];
  let p = 1;
  const scores: numberArray = [];
  for (let i = depth; i <= word.length; i++) {
    let cp = lookup(trie, word.substr(i - depth, depth), 0);
    if (typeof cp === "object") return panic("Did we mess up the depth?");
    if (!cp) cp = 0.0001;
    scores.push(cp);
    p *= cp;
  }
  return [p ** (1 / (word.length - depth - 1)), scores];
}

export function evaluate(mc: MarkovChain, word: string): number {
  return evaluateFull(mc, word)[0];
}

function randomInt(lower: number, upper: number) {
  return lower + Math.floor(Math.random() * (upper - lower));
}

export function generate(mc: MarkovChain, state: string, unseenWeight: number): string {
  assert(state.length === mc.depth - 1, "State and chian length don't match up");
  const t = lookup(mc.trie, state, 0);
  if (typeof t === "number") return panic("Wrong depth?");
  if (!t) return String.fromCharCode(randomInt(32, 127));
  const counts = t.arr.map((x, i) => (x === null ? (i === 0 ? 0 : unseenWeight) : (x as number)));
  let n = 0;
  for (const c of counts) n += c;
  const r = randomInt(0, n);
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    sum += counts[i];
    if (r < sum) return String.fromCharCode(i);
  }
  return panic("We screwed up bookkeeping,or randomInt");
}
