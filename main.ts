// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Positions where O occurs in lines at one tier, at or after `from`. Occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with all its positions (SPEC.md section 5). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `ctxO` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctxO: number;
}

/** Build N's lines at an occurrence: context lines are the file's own, others re-indented at tier 2. */
function applyLines(fileLines: string[], at: number, tier: number, o: string[], n: NLine[]): string[] {
  const f = tier === 2 ? leadWS(fileLines[at] ?? '') : '';
  const p = tier === 2 ? leadWS(o[0] ?? '') : '';
  return n.map((nl) => {
    if (nl.ctxO >= 0) return fileLines[at + nl.ctxO]!;
    const l = nl.text;
    if (tier === 2 && l !== '' && l.trim() !== '' && l.startsWith(p)) return f + l.slice(p.length);
    return l;
  });
}

/** A hunk/chunk body line: context, old, or new. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this item immediately. */
  backslashAfter: boolean;
}

function bodyItems(raw: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const l of raw) {
    if (l === '') items.push({ kind: 'ctx', text: '', backslashAfter: false });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), backslashAfter: false });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1), backslashAfter: false });
    else if (l[0] === '+') items.push({ kind: 'new', text: l.slice(1), backslashAfter: false });
    else if (l[0] === '\\') {
      const prev = items[items.length - 1];
      if (prev !== undefined) prev.backslashAfter = true;
    }
  }
  return items;
}

/** O (context + old) and N (context + new) of a body, context lines mapped to their O index. */
function splitBody(items: BodyItem[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const oIndex = new Map<BodyItem, number>();
  for (const it of items) {
    if (it.kind !== 'new') {
      oIndex.set(it, o.length);
      o.push(it.text);
    }
  }
  const n: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'old') continue;
    n.push({ text: it.text, ctxO: it.kind === 'ctx' ? oIndex.get(it)! : -1 });
  }
  return { o, n };
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as (old, new) pairs, for the `R` output lines. */
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its old start A and its body items. */
interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function lastCtxOrNewBackslash(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.backslashAfter;
  }
  return false;
}

function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.items);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const nLines = applyLines(cur.lines, at, 0, o, n);
      let finalBreak = cur.finalBreak;
      if (at === cur.lines.length) finalBreak = !lastCtxOrNewBackslash(h.items);
      cur = { lines: [...cur.lines.slice(0, at), ...nLines, ...cur.lines.slice(at)], br: cur.br, finalBreak };
      d += nLines.length;
      continue;
    }
    const found = findTier(cur.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const nLines = applyLines(cur.lines, best, found.tier, o, n);
    let finalBreak = cur.finalBreak;
    if (best + o.length === cur.lines.length) finalBreak = !lastCtxOrNewBackslash(h.items);
    cur = { lines: [...cur.lines.slice(0, best), ...nLines, ...cur.lines.slice(best + o.length)], br: cur.br, finalBreak };
    d += nLines.length - o.length;
  }
  return cur;
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
  const newP = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    let kind: 'create' | 'delete' | 'move' | 'change';
    if (oldP === null) kind = 'create';
    else if (newP === null) kind = 'delete';
    else if (sec.isCreate && !sec.isDelete) kind = 'create';
    else if (sec.isDelete && !sec.isCreate) kind = 'delete';
    else if (sec.isCreate && sec.isDelete) kind = 'create';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';
    if (kind === 'create') {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const plus: BodyItem[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it);
      const lines = plus.map((it) => it.text);
      const finalBreak = plus.length === 0 ? false : !lastCtxOrNewBackslash(plus);
      tree.now.set(newP!, lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const out = applyHunks(parseDoc(before), sec.hunks, strict, oldP!);
    const text = writeDoc(out);
    if (kind === 'move') {
      tree.now.set(newP!, text);
      tree.now.set(oldP!, null);
      tree.moves.push({ old: oldP!, nw: newP! });
    } else {
      tree.now.set(oldP!, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: { a: number; raw: string[] } | null = null;
  const closeHunk = (): void => {
    if (hunk === null || cur === null) return;
    const raw = hunk.raw;
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    cur.hunks.push({ a: hunk.a, items: bodyItems(raw) });
    hunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        closeHunk();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
        continue;
      }
      if (isBodyLine(line)) {
        hunk.raw.push(line);
        i++;
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, renameOld: null, renameNew: null, diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = { pairOld: null, pairNew: null, renameOld: null, renameNew: null, diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
      }
      const op = headerPath(line);
      const np = headerPath(lines[i + 1]!);
      cur.pairOld = op === '/dev/null' ? null : op;
      cur.pairNew = np === '/dev/null' ? null : np;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        const np = headerPath(line);
        cur.pairNew = np === '/dev/null' ? null : np;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), raw: [] };
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  closeHunk();
  return sections.map((sec) => uniSectionEdit(sec, strict));
}

interface V4AChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

function v4aAddEdit(path: string, sec: Array<{ text: string; num: number }>): Edit {
  const fileLines: string[] = [];
  for (const { text, num } of sec) {
    if (text === '') fileLines.push('');
    else if (text.startsWith('+')) fileLines.push(text.slice(1));
    else throw new Exit2(`error: parse ${num}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string, sec: Array<{ text: string; num: number }>): Edit {
  if (sec.length > 0) throw new Exit2(`error: parse ${sec[0]!.num}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, sec: Array<{ text: string; num: number }>, updateNum: number, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (sec.length > 0 && sec[0]!.text.startsWith('*** Move to: ')) {
    moveTo = sec[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let closedByEof = false;
  for (; idx < sec.length; idx++) {
    const { text, num } = sec[idx]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      chunks.push(cur);
      closedByEof = false;
    } else if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      closedByEof = true;
    } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
      }
      if (closedByEof) throw new Exit2(`error: parse ${num}`);
      if (text === '') cur.items.push({ kind: 'ctx', text: '', backslashAfter: false });
      else if (text[0] === ' ') cur.items.push({ kind: 'ctx', text: text.slice(1), backslashAfter: false });
      else if (text[0] === '-') cur.items.push({ kind: 'old', text: text.slice(1), backslashAfter: false });
      else cur.items.push({ kind: 'new', text: text.slice(1), backslashAfter: false });
    } else {
      throw new Exit2(`error: parse ${num}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const af = findTier(doc.lines, [ch.anchor], strict, cursor);
        if (af === null) throw new Fail('no-match', path);
        cursor = af.pos[0]! + 1;
      }
      const { o, n } = splitBody(ch.items);
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const nLines = applyLines(doc.lines, at, 0, o, n);
        doc = { lines: [...doc.lines.slice(0, at), ...nLines, ...doc.lines.slice(at)], br: doc.br, finalBreak: doc.finalBreak };
        cursor = at + nLines.length;
        continue;
      }
      const found = findTier(doc.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at = -1;
      for (const p of found.pos) {
        if (ch.eof && p + o.length !== doc.lines.length) continue;
        at = p;
        break;
      }
      if (at < 0) throw new Fail('no-match', path);
      const nLines = applyLines(doc.lines, at, found.tier, o, n);
      doc = { lines: [...doc.lines.slice(0, at), ...nLines, ...doc.lines.slice(at + o.length)], br: doc.br, finalBreak: doc.finalBreak };
      cursor = at + nLines.length;
    }
    const text = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDel = line.startsWith('*** Delete File: ');
      const path = (isAdd ? line.slice('*** Add File: '.length) : line.slice('*** Update File: '.length)).trim();
      const sec: Array<{ text: string; num: number }> = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        sec.push({ text: l, num: j + 1 });
        j++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      if (isAdd) edits.push(v4aAddEdit(path, sec));
      else if (isDel) edits.push(v4aDeleteEdit(path, sec));
      else edits.push(v4aUpdateEdit(path, sec, i + 1, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctxO: -1 }));
    const nLines = applyLines(doc.lines, at, found.tier, oldLines, n);
    const out: FileDoc = {
      lines: [...doc.lines.slice(0, at), ...nLines, ...doc.lines.slice(at + oldLines.length)],
      br: doc.br,
      finalBreak: doc.finalBreak,
    };
    tree.now.set(path, writeDoc(out));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    const oldE = entries.find((e) => e.key === m.old && e.line.startsWith('D '));
    const newE = entries.find((e) => e.key === m.nw && e.line.startsWith('A '));
    if (oldE !== undefined && newE !== undefined) {
      entries.splice(entries.indexOf(oldE), 1);
      entries.splice(entries.indexOf(newE), 1);
      entries.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
