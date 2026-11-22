// A fast drop-in for makefun-site 1.0.0: build(input) returns the output tree
// (a JSON object of every path it writes and that file's text, byte for byte).
// Written from the makefun-site README (its front matter, template dialect,
// Markdown subset, slug rule and report); no reference code was copied.

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape a string. */
function esc(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '', j = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out += s.slice(j, i) + ESC_MAP[c];
      j = i + 1;
    }
  }
  return out + s.slice(j);
}

const MARK_RE = /\p{M}/gu;
const slugCache = new Map();

/** A slug: NFKD, combining marks dropped, A-Z lowered, each run of
 *  characters other than a-z and 0-9 one '-', none at either end,
 *  cut to 64 characters, a '-' left at the cut dropped, 'untitled' when
 *  nothing is left. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let s = text.normalize('NFKD').replace(MARK_RE, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) === 45) a++;
  while (b > a && s.charCodeAt(b - 1) === 45) b--;
  s = s.slice(a, b);
  if (s.length > 64) {
    s = s.slice(0, 64);
    if (s.charCodeAt(63) === 45) s = s.slice(0, 63);
  }
  const out = s === '' ? 'untitled' : s;
  slugCache.set(text, out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The date in words from the string alone: 2026-11-09 is 9 November 2026. */
function dateLong(d) {
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

function isLeap(y) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }

// ---------------------------------------------------------------- front matter

const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function parseString(key, value) {
  if (value.charCodeAt(0) === 34) { // "
    let out = '', i = 1;
    while (i < value.length) {
      const c = value[i];
      if (c === '\\') {
        const nx = value[i + 1];
        if (nx === '"' || nx === '\\') { out += nx; i += 2; continue; }
        return { err: 'key "' + key + '": a quoted string has a bad escape' };
      }
      if (c === '"') {
        if (i !== value.length - 1) return { err: 'key "' + key + '": a quoted string is not closed' };
        return { v: out };
      }
      out += c; i++;
    }
    return { err: 'key "' + key + '": a quoted string is not closed' };
  }
  if (value.charCodeAt(0) === 91) return { err: 'key "' + key + '": a bare string opens on [' }; // [
  return { v: value };
}

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return { err: DATE_ERR };
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12) return { err: DATE_ERR };
  const dim = mo === 2 ? (isLeap(y) ? 29 : 28) : (mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31);
  if (d < 1 || d > dim) return { err: DATE_ERR };
  if (value < '1970-01-01' || value > '2099-12-31') return { err: DATE_ERR };
  return { v: value };
}

function parseTags(value) {
  if (value.length < 2 || value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
    return { err: 'key "tags": not a list [a, b]' };
  }
  const inner = value.slice(1, -1);
  if (inner.trim() === '') return { v: [] };
  const parts = inner.split(',');
  const tags = [];
  for (let p of parts) {
    p = p.trim();
    if (p === '' || p.indexOf('"') >= 0 || p.indexOf('[') >= 0 || p.indexOf(']') >= 0) {
      return { err: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(p);
  }
  return { v: tags };
}

function parseKeyValue(key, value) {
  switch (key) {
    case 'title':
    case 'summary':
      return parseString(key, value);
    case 'date':
      return parseDate(value);
    case 'tags':
      return parseTags(value);
    case 'draft':
      if (value === 'true') return { v: true };
      if (value === 'false') return { v: false };
      return { err: 'key "draft": true or false' };
    case 'layout':
      if (/^[a-z0-9-]+$/.test(value)) return { v: value };
      return { err: 'key "layout": not a template name' };
    case 'slug':
      if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length <= 64) return { v: value };
      return { err: 'key "slug": not a slug' };
    default:
      return { err: 'unknown key "' + key + '"' };
  }
}

const KEY_RE = /^([a-z_]+):(.*)$/;

/** Parse a source's front matter. Returns { fm, body } or { err }. */
function parseFrontMatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { err: 'no front matter' };
  const fm = {};
  const seen = new Set();
  let i = 1;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '---') return { fm, body: lines.slice(i + 1).join('\n') };
    if (isBlank(line) || line.charCodeAt(0) === 35) { i++; continue; } // blank or '#'
    const m = KEY_RE.exec(line);
    if (!m) return { err: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    if (seen.has(key)) return { err: 'key "' + key + '" is given twice' };
    const rest = m[2];
    if (rest === '') return { err: 'key "' + key + '" has no value' };
    if (rest.charCodeAt(0) !== 32) return { err: 'line ' + (i + 1) + ' is not "key: value"' };
    const value = rest.slice(1).replace(/[ \t]+$/, '');
    if (value === '') return { err: 'key "' + key + '" has no value' };
    seen.add(key);
    const r = parseKeyValue(key, value);
    if (r.err) return { err: r.err };
    fm[key] = r.v;
    i++;
  }
  return { err: 'the front matter is not closed' };
}

// ---------------------------------------------------------------- Markdown: inline

// Characters a backslash may escape.
const ESCAPABLE = { '\\': 1, '`': 1, '*': 1, '_': 1, '[': 1, ']': 1, '(': 1, ')': 1, '#': 1, '+': 1, '-': 1, '.': 1, '!': 1, '>': 1 };

/** The first unescaped '**' at or after `from` (end exclusive), or -1. */
function findStrongClose(s, from, end) {
  let j = from;
  while (j + 1 < end) {
    const c = s[j];
    if (c === '\\' && ESCAPABLE[s[j + 1]]) { j += 2; continue; }
    if (c === '*' && s[j + 1] === '*') return j;
    j++;
  }
  // a '**' ending exactly at `end` cannot close (needs two chars inside)
  return -1;
}

/** The next single '*' at or after `from` (a '**' pair is a strong delimiter,
 *  not an emphasis closer, so a pair is skipped as a unit), or -1. */
function findEmClose(s, from, end) {
  let j = from;
  while (j < end) {
    const c = s[j];
    if (c === '\\' && ESCAPABLE[s[j + 1]]) { j += 2; continue; }
    if (c === '*') {
      if (s[j + 1] === '*') { j += 2; continue; }
      return j;
    }
    j++;
  }
  return -1;
}

/** The next backtick at or after `from`, or -1. */
function findCodeClose(s, from, end) {
  const k = s.indexOf('`', from);
  return k >= 0 && k < end ? k : -1;
}

/** The next unescaped ']' at or after `from`, or -1. */
function findTextClose(s, from, end) {
  let j = from;
  while (j < end) {
    const c = s[j];
    if (c === '\\' && ESCAPABLE[s[j + 1]]) { j += 2; continue; }
    if (c === ']') return j;
    j++;
  }
  return -1;
}

const WS_RE = /\s/;

/** Render inline markup of s[a..b) into `out` (an array of chunks). */
function inlineInto(s, ctx, a, b, out) {
  let i = a;
  while (i < b) {
    // fast path: a run of plain characters
    let j = i;
    while (j < b) {
      const c = s[j];
      if (c === '\\' || c === '`' || c === '*' || c === '[' || c === '&' || c === '<' || c === '>' || c === '"' || c === "'") break;
      j++;
    }
    if (j > i) { out.push(s.slice(i, j)); i = j; }
    if (i >= b) break;
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE[s[i + 1]]) {
      out.push(ESC_MAP[s[i + 1]] || s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = findCodeClose(s, i + 1, b);
      if (k >= 0 && k - (i + 1) >= 1) {
        // A code span's content is its raw text, HTML-escaped only.
        out.push('<code>', esc(s.slice(i + 1, k)), '</code>');
        i = k + 1;
        continue;
      }
      out.push('`');
      i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const k = findStrongClose(s, i + 2, b);
        if (k >= 0 && k - (i + 2) >= 1) {
          out.push('<strong>');
          inlineInto(s, ctx, i + 2, k, out);
          out.push('</strong>');
          i = k + 2;
          continue;
        }
        out.push('**');
        i += 2;
        continue;
      }
      const k = findEmClose(s, i + 1, b);
      if (k >= 0 && k - (i + 1) >= 1) {
        out.push('<em>');
        inlineInto(s, ctx, i + 1, k, out);
        out.push('</em>');
        i = k + 1;
        continue;
      }
      out.push('*');
      i++;
      continue;
    }
    if (c === '[') {
      const k = findTextClose(s, i + 1, b);
      if (k >= 0 && k + 1 < b && s[k + 1] === '(') {
        const r = s.indexOf(')', k + 2);
        if (r >= 0 && r < b) {
          const target = s.slice(k + 2, r);
          if (target !== '' && !WS_RE.test(target)) {
            out.push('<a href="', esc(resolveHref(target, ctx)), '">');
            inlineInto(s, ctx, i + 1, k, out);
            out.push('</a>');
            i = r + 1;
            continue;
          }
        }
      }
      out.push('[');
      i++;
      continue;
    }
    // one of & < > " ' or a backslash before a character it cannot escape
    out.push(ESC_MAP[c] || c);
    i++;
  }
}

function inlineStr(s, ctx) {
  const out = [];
  inlineInto(s, ctx, 0, s.length, out);
  return out.join('');
}

// ---------------------------------------------------------------- Markdown: links

/** Resolve a link target from the source's directory. */
function resolveHref(target, ctx) {
  const c0 = target.charCodeAt(0);
  if (c0 === 35 || c0 === 47) return target; // '#' or '/'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return target; // a scheme
  let frag = '';
  let path = target;
  const h = target.indexOf('#');
  if (h >= 0) { frag = target.slice(h); path = target.slice(0, h); }
  const parts = ctx.dir === '' ? [] : ctx.dir.split('/');
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  const resolved = parts.join('/');
  const url = ctx.pageUrls.get(resolved);
  if (url !== undefined) return url + frag;
  if (ctx.statics.has(resolved)) return ctx.base + '/' + resolved + frag;
  ctx.broken.add(ctx.source + '\n' + target);
  return target;
}

// ---------------------------------------------------------------- Markdown: blocks

const FENCE_START_RE = /^```([A-Za-z0-9_+\-]*)[ \t]*$/;
const FENCE_END_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const BREAK_RE = /^(---|\*\*\*)[ \t]*$/;
const ORDERED_RE = /^(\d+)\. /;
function trimST(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

function isBlank(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The block a line starts, for paragraph termination: 'fence' | 'heading' | 'break' | null. */
function blockStartKind(line) {
  const c = line.charCodeAt(0);
  if (c === 96 && FENCE_START_RE.test(line)) return 'fence'; // `
  if (c === 35) {
    const m = HEADING_RE.exec(line);
    if (m && trimST(m[2]) !== '') return 'heading';
  }
  if ((c === 45 || c === 42) && BREAK_RE.test(line)) return 'break'; // - or *
  return null;
}

/** Claim the first of s, s-2, s-3, ... not yet in `taken`. */
function claimUnique(taken, s) {
  if (!taken.has(s)) { taken.add(s); return s; }
  let n = 2;
  while (taken.has(s + '-' + n)) n++;
  const out = s + '-' + n;
  taken.add(out);
  return out;
}

/**
 * Render one source's body to HTML. Returns { html, toc, excerpt, words }.
 * ctx: { dir, pageUrls, statics, base, source, broken }.
 */
function renderBody(body, ctx) {
  const lines = body.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const usedIds = new Set();
  let excerpt = '';
  let words = 0;
  // words: runs of characters other than whitespace in the body
  {
    let inWord = false;
    for (let k = 0; k < body.length; k++) {
      const c = body[k];
      const ws = c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
      if (ws) inWord = false;
      else if (!inWord) { inWord = true; words++; }
    }
  }
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    // fence
    let m = c0 === 96 ? FENCE_START_RE.exec(line) : null;
    if (m) {
      const lang = m[1];
      let j = i + 1;
      const buf = [lang === '' ? '<pre><code>' : '<pre><code class="language-' + lang + '">'];
      while (j < n && !FENCE_END_RE.test(lines[j])) { buf.push(esc(lines[j])); buf.push('\n'); j++; }
      buf.push('</code></pre>');
      out.push(buf.join(''));
      i = j + 1;
      continue;
    }
    // heading
    m = c0 === 35 ? HEADING_RE.exec(line) : null;
    if (m) {
      const text = trimST(m[2]);
      if (text !== '') {
        const level = m[1].length;
        const id = claimUnique(usedIds, slugify(text));
        const html = inlineStr(text, ctx);
        out.push('<h' + level + ' id="' + id + '">' + html + '</h' + level + '>');
        if (level === 2 || level === 3) toc.push({ level, id, html });
        i++;
        continue;
      }
    }
    // thematic break
    if ((c0 === 45 || c0 === 42) && BREAK_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // blockquote
    if (c0 === 62) { // '>'
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimST(t);
        if (t !== '') parts.push(t);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>');
      else out.push('<blockquote>\n<p>' + inlineStr(parts.join('\n'), ctx) + '</p>\n</blockquote>');
      continue;
    }
    // list
    const isBullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    const om = !isBullet && c0 >= 48 && c0 <= 57 ? ORDERED_RE.exec(line) : null;
    if (isBullet || om) {
      const ordered = !isBullet;
      const items = [];
      let startNum = 1;
      if (ordered) startNum = parseInt(om[1], 10);
      let cur = trimST(line.slice(ordered ? om[0].length : 2));
      i++;
      while (i < n) {
        const l = lines[i];
        const lc = l.charCodeAt(0);
        if (ordered ? (lc >= 48 && lc <= 57 && ORDERED_RE.test(l)) : ((lc === 45 || lc === 42) && l.charCodeAt(1) === 32)) {
          items.push(cur);
          const nm = ordered ? ORDERED_RE.exec(l) : null;
          cur = trimST(l.slice(ordered ? nm[0].length : 2));
          i++;
          continue;
        }
        if (/^[ \t]{2,}[^ \t]/.test(l)) {
          cur += '\n' + trimST(l);
          i++;
          continue;
        }
        break;
      }
      items.push(cur);
      const lparts = [ordered && startNum !== 1 ? '<ol start="' + startNum + '">' : ordered ? '<ol>' : '<ul>'];
      for (const it of items) lparts.push('<li>' + inlineStr(it, ctx) + '</li>');
      lparts.push(ordered ? '</ol>' : '</ul>');
      out.push(lparts.join('\n'));
      continue;
    }
    // paragraph: lines up to a blank line, a fence, a heading or a thematic break
    const parts = [trimST(line)];
    i++;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l) || blockStartKind(l)) break;
      parts.push(trimST(l));
      i++;
    }
    const text = parts.join('\n');
    const html = inlineStr(text, ctx);
    if (excerpt === '') excerpt = html;
    out.push('<p>' + html + '</p>');
  }
  return { html: out.length ? out.map((b) => b + '\n').join('') : '', toc, excerpt, words };
}

// ---------------------------------------------------------------- templates

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a {{ }} path's inner text into an array of names, or null. */
function parsePath(inner) {
  const t = trimST(inner);
  if (t === '') return null;
  const parts = t.split('.');
  for (const p of parts) if (!NAME_RE.test(p)) return null;
  return parts;
}

const FOR_RE = /^for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in[ \t]+(.+)$/;
const IF_RE = /^if[ \t]+(?:(not)[ \t]+)?(.+)$/;
const INCLUDE_RE = /^include[ \t]+"([^"]*)"[ \t]*$/;

/** Parse one template's source into a node tree. Returns { nodes } or { err }. */
function parseTemplate(src) {
  const tokens = [];
  let i = 0, n = src.length, textStart = 0;
  const pushText = (s) => { if (s !== '') tokens.push({ t: 'text', s }); };
  while (i < n) {
    if (src.startsWith('{{{', i)) {
      const close = src.indexOf('}}}', i + 3);
      if (close < 0) return { err: 'a {{{ is not closed' };
      const path = parsePath(src.slice(i + 3, close));
      if (!path) return { err: 'a path is not one' };
      pushText(src.slice(textStart, i));
      tokens.push({ t: 'rawvar', path });
      i = close + 3; textStart = i;
    } else if (src.startsWith('{{', i)) {
      const close = src.indexOf('}}', i + 2);
      if (close < 0) return { err: 'a {{ is not closed' };
      const path = parsePath(src.slice(i + 2, close));
      if (!path) return { err: 'a path is not one' };
      pushText(src.slice(textStart, i));
      tokens.push({ t: 'var', path });
      i = close + 2; textStart = i;
    } else if (src.startsWith('{%', i)) {
      const close = src.indexOf('%}', i + 2);
      if (close < 0) return { err: 'a {% is not closed' };
      pushText(src.slice(textStart, i));
      tokens.push({ t: 'tag', s: src.slice(i + 2, close) });
      i = close + 2; textStart = i;
    } else i++;
  }
  pushText(src.slice(textStart));
  // A {% %} tag alone on its line (only spaces or tabs beside it) takes the
  // whole line with it, its '\n' included.
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].t !== 'tag') continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    let prevTail = '';
    let prevOK = true;
    if (prev !== undefined) {
      if (prev.t !== 'text') prevOK = false;
      else {
        const idx = prev.s.lastIndexOf('\n');
        prevTail = idx < 0 ? prev.s : prev.s.slice(idx + 1);
        if (!/^[ \t]*$/.test(prevTail)) prevOK = false;
      }
    }
    let nextHead = '';
    let nextOK = true;
    let nextCut = 0;
    if (next !== undefined) {
      if (next.t !== 'text') nextOK = false;
      else {
        const m = /^[ \t]*/.exec(next.s);
        nextHead = m[0];
        const rest = next.s.slice(nextHead.length);
        if (rest !== '' && rest.charCodeAt(0) !== 10) nextOK = false;
        else nextCut = nextHead.length + (rest.charCodeAt(0) === 10 ? 1 : 0);
      }
    }
    if (prevOK && nextOK) {
      if (prev !== undefined) prev.s = prev.s.slice(0, prev.s.length - prevTail.length);
      if (next !== undefined) next.s = next.s.slice(nextCut);
    }
  }
  // Build the node tree.
  const root = { t: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const add = (node) => {
    const p = top();
    (p.elseMode ? p.elseChildren : p.children).push(node);
  };
  for (const tok of tokens) {
    if (tok.t === 'text') { if (tok.s !== '') add({ t: 'text', s: tok.s }); continue; }
    if (tok.t === 'var') { add({ t: 'var', path: tok.path }); continue; }
    if (tok.t === 'rawvar') { add({ t: 'rawvar', path: tok.path }); continue; }
    const tag = trimST(tok.s);
    let m;
    if ((m = FOR_RE.exec(tag))) {
      const path = parsePath(m[2]);
      if (!path) return { err: 'a path is not one' };
      const node = { t: 'for', varName: m[1], path, children: [] };
      add(node);
      stack.push(node);
    } else if (tag === 'endfor') {
      if (top().t !== 'for') return { err: 'a for is not closed or closed out of order' };
      stack.pop();
    } else if ((m = IF_RE.exec(tag))) {
      const path = parsePath(m[2]);
      if (!path) return { err: 'a path is not one' };
      const node = { t: 'if', path, neg: !!m[1], children: [], elseChildren: null, elseMode: false };
      add(node);
      stack.push(node);
    } else if (tag === 'else') {
      if (top().t !== 'if' || top().elseChildren !== null) return { err: 'an if is not closed or closed out of order' };
      top().elseChildren = [];
      top().elseMode = true;
    } else if (tag === 'endif') {
      if (top().t !== 'if') return { err: 'an if is not closed or closed out of order' };
      stack.pop();
    } else if ((m = INCLUDE_RE.exec(tag))) {
      add({ t: 'include', name: m[1] });
    } else {
      return { err: 'a tag is none of for, if, else, endif, endfor or include' };
    }
  }
  if (stack.length !== 1) return { err: 'a for or if is not closed' };
  return { nodes: root.children };
}

/** A path's value: the first name from the innermost loop that binds it,
 *  else from the page's values; each next name an own property, or undefined. */
function lookup(path, scope, top) {
  let v;
  let found = false;
  for (let s = scope.length - 1; s >= 0; s--) {
    const b = scope[s];
    if (Object.hasOwn(b, path[0])) { v = b[path[0]]; found = true; break; }
  }
  if (!found) {
    if (Object.hasOwn(top, path[0])) { v = top[path[0]]; found = true; }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || v === undefined) return undefined;
    if (!Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value written as: a string itself; a number in JavaScript's own digits;
 *  true or false; an array as its items written and joined by ', '; else ''. */
function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += writeValue(v[k]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0 && !(Array.isArray(v) && v.length === 0);
}

function renderNodes(nodes, scope, top, templates, out, depth) {
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        out.push(node.s);
        break;
      case 'var':
        out.push(esc(writeValue(lookup(node.path, scope, top))));
        break;
      case 'rawvar':
        out.push(writeValue(lookup(node.path, scope, top)));
        break;
      case 'for': {
        const arr = lookup(node.path, scope, top);
        if (Array.isArray(arr)) {
          const len = arr.length;
          for (let k = 0; k < len; k++) {
            const frame = {};
            frame[node.varName] = arr[k];
            frame.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
            scope.push(frame);
            renderNodes(node.children, scope, top, templates, out, depth);
            scope.pop();
          }
        }
        break;
      }
      case 'if': {
        const v = truthy(lookup(node.path, scope, top));
        const take = node.neg ? !v : v;
        if (take) renderNodes(node.children, scope, top, templates, out, depth);
        else if (node.elseChildren) renderNodes(node.elseChildren, scope, top, templates, out, depth);
        break;
      }
      case 'include': {
        const t = templates[node.name];
        if (t && depth < 8) renderNodes(t, scope, top, templates, out, depth + 1);
        break;
      }
    }
  }
}

function renderTemplate(nodes, top, templates) {
  const out = [];
  renderNodes(nodes, [], top, templates, out, 0);
  return out.join('');
}

// ---------------------------------------------------------------- the build

/** makefun-site's answer for one case's input: the output tree. */
export function run(input) {
  slugCache.clear(); // each case is answered alone; nothing is kept from one case to the next
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const report = [];

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out, as if it were not there.
  const templates = {};
  const tNames = Object.keys(input.templates).sort();
  for (const name of tNames) {
    const r = parseTemplate(input.templates[name]);
    if (r.err) { report.push('template "' + name + '": ' + r.err); continue; }
    templates[name] = r.nodes;
  }

  // Sources, sorted by path in code-unit order; a file ending in .md is a
  // source, any other file static.
  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const statics = new Map();
  const sources = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push(f);
    else statics.set(f.path, f.content);
  }

  // Front matter and the checks, in order: refused, under tags/ or page/,
  // a post with no date, a layout no template has, a draft.
  const pages = [];
  for (const f of sources) {
    const content = f.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const p = parseFrontMatter(content);
    if (p.err) { report.push('refused ' + f.path + ': ' + p.err); continue; }
    const fm = p.fm;
    if (fm.title === undefined || fm.title === '') { report.push('refused ' + f.path + ': no title'); continue; }
    const isPost = f.path.startsWith('posts/');
    if (f.path.startsWith('tags/')) { report.push('refused ' + f.path + ': tags/ is the generator\'s own'); continue; }
    if (f.path.startsWith('page/')) { report.push('refused ' + f.path + ': page/ is the generator\'s own'); continue; }
    if (isPost && fm.date === undefined) { report.push('refused ' + f.path + ': a post needs a date'); continue; }
    const layout = fm.layout || (isPost ? 'post' : 'page');
    if (!templates[layout]) { report.push('refused ' + f.path + ': layout "' + layout + '" is no template that parses'); continue; }
    if (fm.draft === true) { report.push('draft ' + f.path); continue; }
    const dir = isPost ? 'posts' : (f.path.indexOf('/') >= 0 ? f.path.slice(0, f.path.lastIndexOf('/')) : '');
    const srcDir = f.path.indexOf('/') >= 0 ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    pages.push({ path: f.path, fm, body: p.body, isPost, layout, dir, srcDir });
  }

  // Permalinks: a post's directory is posts/; a page's is its source's
  // directory. The slug is its slug key, or the slug of its title, made
  // unique in its directory in source order; at the root, posts, tags and
  // page are taken from the start.
  const takenByDir = new Map();
  const pageUrls = new Map();
  for (const pg of pages) {
    let taken = takenByDir.get(pg.dir);
    if (!taken) {
      taken = new Set();
      if (pg.dir === '') { taken.add('posts'); taken.add('tags'); taken.add('page'); }
      takenByDir.set(pg.dir, taken);
    }
    pg.slug = claimUnique(taken, pg.fm.slug || slugify(pg.fm.title));
    pg.url = base + '/' + (pg.dir === '' ? '' : pg.dir + '/') + pg.slug + '/';
    pg.outPath = (pg.dir === '' ? '' : pg.dir + '/') + pg.slug + '/index.html';
    pageUrls.set(pg.path, pg.url);
  }

  // Markdown, each source's body rendered to HTML, its links resolved.
  const broken = new Set();
  const ctx = { dir: '', pageUrls, statics, base, source: '', broken };
  for (const pg of pages) {
    ctx.dir = pg.srcDir;
    ctx.source = pg.path;
    const r = renderBody(pg.body, ctx);
    pg.html = r.html;
    pg.toc = r.toc;
    pg.excerpt = r.excerpt;
    pg.reading_minutes = Math.max(1, Math.ceil(r.words / 200));
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = pages.filter((p) => p.isPost).sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const postIndex = new Map();
  for (let k = 0; k < posts.length; k++) postIndex.set(posts[k], k);

  // Tags: each post's tags, each slug once (the first spelling kept), in its
  // own order; a tag is all the posts whose tags have its slug, named as it
  // is first met walking the posts in collection order.
  const tagMap = new Map();
  for (const post of posts) {
    const seen = new Set();
    for (const name of post.fm.tags || []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let t = tagMap.get(slug);
      if (!t) { t = { name, slug, posts: [] }; tagMap.set(slug, t); }
      t.posts.push(post);
    }
  }
  const tags = [...tagMap.values()].sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (const t of tags) t.url = base + '/tags/' + t.slug + '/';

  // A page's tags link to the tag of the same slug, or have the url ""
  // where no post has that tag.
  for (const pg of pages) {
    const seen = new Set();
    const list = [];
    for (const name of pg.fm.tags || []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const t = tagMap.get(slug);
      list.push({ name: t ? t.name : name, slug, url: t ? t.url : '' });
    }
    pg.tagList = list;
  }

  const cardOf = (pg) => ({
    title: pg.fm.title,
    url: pg.url,
    date: pg.fm.date || '',
    date_long: pg.fm.date ? dateLong(pg.fm.date) : '',
    summary: pg.fm.summary || '',
    excerpt: pg.excerpt,
    reading_minutes: pg.reading_minutes,
    tags: pg.tagList,
  });

  // One card per page, built once and reused wherever the page is listed.
  for (const pg of pages) pg.card = cardOf(pg);

  const siteCtx = { title: site.title, base_url: base };
  const tagsCtx = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((pg) => pg.card);

  const out = {};

  // Layouts: every page through its layout, with `page`.
  for (const pg of pages) {
    const idx = pg.isPost ? postIndex.get(pg) : -1;
    const newer = idx > 0 ? posts[idx - 1] : null;
    const older = idx >= 0 && idx < posts.length - 1 ? posts[idx + 1] : null;
    const card = pg.card;
    const page = {
      title: card.title, url: card.url, date: card.date, date_long: card.date_long,
      summary: card.summary, excerpt: card.excerpt, reading_minutes: card.reading_minutes, tags: card.tags,
      slug: pg.slug, content: pg.html, toc: pg.toc,
      newer: newer ? { title: newer.fm.title, url: newer.url, date: newer.fm.date, date_long: dateLong(newer.fm.date) } : null,
      older: older ? { title: older.fm.title, url: older.url, date: older.fm.date, date_long: dateLong(older.fm.date) } : null,
      is_post: pg.isPost,
    };
    out[pg.outPath] = renderTemplate(templates[pg.layout], { site: siteCtx, tags: tagsCtx, recent, page }, templates);
  }

  // The index through `index`, `site.per_page` posts a page (at least one,
  // even with no posts), with `posts` and `pager`.
  if (templates['index']) {
    const perPage = site.per_page;
    const total = Math.max(1, Math.ceil(posts.length / perPage));
    for (let k = 1; k <= total; k++) {
      const slice = posts.slice((k - 1) * perPage, k * perPage);
      const pager = {
        number: k,
        total,
        url: k === 1 ? base + '/' : base + '/page/' + k + '/',
        newer_url: k > 1 ? (k - 1 === 1 ? base + '/' : base + '/page/' + (k - 1) + '/') : '',
        older_url: k < total ? base + '/page/' + (k + 1) + '/' : '',
      };
      out[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = renderTemplate(
        templates['index'],
        { site: siteCtx, tags: tagsCtx, recent, posts: slice.map((pg) => pg.card), pager },
        templates,
      );
    }
  }

  // Each tag through `tag`, and `tags/index.html` through `tags`.
  if (templates['tag']) {
    for (const t of tags) {
      out['tags/' + t.slug + '/index.html'] = renderTemplate(
        templates['tag'],
        { site: siteCtx, tags: tagsCtx, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((pg) => pg.card) } },
        templates,
      );
    }
  }
  if (templates['tags']) {
    out['tags/index.html'] = renderTemplate(
      templates['tags'],
      { site: siteCtx, tags: tagsCtx, recent },
      templates,
    );
  }

  // Each static file at its own path, unless a built page has that path.
  let staticCount = 0;
  for (const [path, content] of statics) {
    if (Object.hasOwn(out, path)) { report.push('shadowed ' + path + ': a built page has its path'); continue; }
    out[path] = content;
    staticCount++;
  }

  // The report: every line reported above and each broken link, sorted in
  // code-unit order, then the built line.
  for (const b of broken) {
    const sep = b.indexOf('\n');
    report.push('broken-link ' + b.slice(0, sep) + ' -> ' + b.slice(sep + 1));
  }
  report.sort();
  const nPages = pages.length - posts.length;
  out['build-report.txt'] =
    (report.length ? report.join('\n') + '\n' : '') +
    'built ' + nPages + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + staticCount + ' static files\n';
  return out;
}
