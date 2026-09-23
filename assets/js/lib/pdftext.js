/* ============================================================
   pdftext.js — 零依賴 PDF 文字層抽取（畀「試卷匯入」用）
   ------------------------------------------------------------
   點解要自己寫：本系統係「純靜態、零依賴」，唔想為咗一個匯入
   功能引入成個 pdf.js（幾 MB）。而 Google Form 匯出嘅題目 PDF
   （表單 → ⋮ → 列印 → 另存 PDF）結構好固定：
     · 文字全部係內嵌子集字型（Type0 + Identity-H）＋ ToUnicode 對照表
     · 內容流係 BT/Tf/Tm/TJ 純文字指令，Flate 壓縮
   所以只需支援呢個「指定格式」就得，唔使支援全的世界嘅 PDF。

   能力：
     inflateZlib(bytes)            zlib/deflate 解壓（RFC1950/1951）
     parsePdfObjects(bytes)        掃描式物件表（唔使 xref）
     extractPdfLines(buf)          → { ok, lines:[{text,x,y,page}], error }
     pdfToQuizText(buf)            → { ok, text, error }（選項行加兩格縮排）
     pdfFileToQuizText(file)       File/Blob 版本

   抽出嘅文字一定會擺喺可編輯嘅預覽格度 —— 抽得唔完美，
   用家可以喺匯入之前手改，唔會「收收埋埋抽錯仲匯入」。
   ============================================================ */

/* ---------------- inflate（RFC 1951 raw DEFLATE） ---------------- */
class BitReader {
  constructor(bytes, pos = 0) { this.b = bytes; this.pos = pos; this.bit = 0; }
  /** 由流度讀 n 個 bit（LSB first —— DEFLATE 標準） */
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos];
      if (byte === undefined) throw new Error('inflate: 資料唔夠');
      v |= ((byte >> this.bit) & 1) << i;
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  }
  align() { if (this.bit) { this.bit = 0; this.pos++; } }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuff(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) { code = (code + blCount[l - 1]) << 1; nextCode[l] = code; }
  const byLen = Array.from({ length: maxLen + 1 }, () => new Map());
  lengths.forEach((l, sym) => { if (l) byLen[l].set(nextCode[l]++, sym); });
  return { byLen, maxLen };
}

function decodeSym(br, h) {
  let code = 0;
  for (let len = 1; len <= h.maxLen; len++) {
    code = (code << 1) | br.bits(1);
    const s = h.byLen[len].get(code);
    if (s !== undefined) return s;
  }
  throw new Error('inflate: 壞嘅 Huffman 碼');
}

/** raw DEFLATE（唔帶 zlib header）→ Uint8Array */
export function inflateRaw(bytes, pos = 0) {
  const br = new BitReader(bytes, pos);
  const out = [];
  const litH = () => {
    const lengths = new Array(288);
    for (let i = 0; i < 144; i++) lengths[i] = 8;
    for (let i = 144; i < 256; i++) lengths[i] = 9;
    for (let i = 256; i < 280; i++) lengths[i] = 7;
    for (let i = 280; i < 288; i++) lengths[i] = 8;
    return { lit: buildHuff(lengths), dist: buildHuff(new Array(30).fill(5)) };
  };
  let fixed = null;
  for (;;) {
    const bfinal = br.bits(1);
    const btype = br.bits(2);
    if (btype === 0) {
      br.align();
      const len = br.b[br.pos] | (br.b[br.pos + 1] << 8);
      br.pos += 4;                       // LEN + NLEN
      for (let i = 0; i < len; i++) out.push(br.b[br.pos++]);
    } else if (btype === 1 || btype === 2) {
      let lit, dist;
      if (btype === 1) {
        if (!fixed) fixed = litH();
        lit = fixed.lit; dist = fixed.dist;
      } else {
        const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
        const cl = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = br.bits(3);
        const clH = buildHuff(cl);
        const lengths = [];
        while (lengths.length < hlit + hdist) {
          const sym = decodeSym(br, clH);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) { const prev = lengths[lengths.length - 1]; const n = 3 + br.bits(2); for (let i = 0; i < n; i++) lengths.push(prev); }
          else if (sym === 17) { const n = 3 + br.bits(3); for (let i = 0; i < n; i++) lengths.push(0); }
          else { const n = 11 + br.bits(7); for (let i = 0; i < n; i++) lengths.push(0); }
        }
        lit = buildHuff(lengths.slice(0, hlit));
        dist = buildHuff(lengths.slice(hlit));
      }
      for (;;) {
        const sym = decodeSym(br, lit);
        if (sym < 256) out.push(sym);
        else if (sym === 256) break;
        else {
          const li = sym - 257;
          const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          const dsym = decodeSym(br, dist);
          const d = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
          let src = out.length - d;
          if (src < 0) throw new Error('inflate: 距離太遠');
          for (let i = 0; i < len; i++) out.push(out[src++]);
        }
      }
    } else throw new Error('inflate: 唔支援嘅 block');
    if (bfinal) break;
  }
  return Uint8Array.from(out);
}

/** zlib（RFC1950）包住嘅 deflate；唔係 zlib 就當 raw 試 */
export function inflateZlib(bytes) {
  if (bytes && bytes.length > 2) {
    const cmf = bytes[0], flg = bytes[1];
    if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) {
      return inflateRaw(bytes, 2);
    }
  }
  return inflateRaw(bytes, 0);
}

/* ---------------- 細工具 ---------------- */
function latin1Str(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  return s;
}

/* ---------------- PDF 物件掃描（唔使 xref，夠用有餘） ---------------- */
/**
 * 掃勻成個檔，搵出 `N G obj … endobj`。
 * 有 stream 嘅物件會切埋 data 出嚟（跟 /Length；間接 reference 或爛 length
 * 就 scan 到 endstream 為止）。回傳 Map<num, {num, dict, data}>。
 */
export function parsePdfObjects(bytes) {
  const s = latin1Str(bytes);
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const starts = [];
  let m;
  while ((m = re.exec(s))) starts.push({ num: +m[1], at: m.index, body: m.index + m[0].length });
  starts.sort((a, b) => a.at - b.at);
  for (let i = 0; i < starts.length; i++) {
    const o = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].at : s.length;
    let chunk = s.slice(o.body, Math.min(end, o.body + 262144));
    const eo = chunk.indexOf('endobj');
    if (eo >= 0) chunk = chunk.slice(0, eo);
    let dict = chunk, data = null;
    const sm = chunk.match(/[^a-zA-Z]stream\r?\n/);
    if (sm) {
      dict = chunk.slice(0, sm.index + 1);
      const dataStart = o.body + sm.index + sm[0].length;
      let len = -1;
      const lm = chunk.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      const lr = chunk.match(/\/Length\s+(\d+)\s+\d+\s+R/);
      if (lm) len = +lm[1];
      else if (lr) {
        const ln = starts.find(x => x.num === +lr[1]);
        if (ln) { const seg = s.slice(ln.body, ln.body + 128); const nm = seg.match(/\b(\d+)\b/); if (nm) len = +nm[1]; }
      }
      let dataEnd;
      if (len >= 0 && dataStart + len <= bytes.length) dataEnd = dataStart + len;
      else {
        const es = s.indexOf('endstream', dataStart);
        dataEnd = es >= 0 ? es : bytes.length;
        while (dataEnd > dataStart && (bytes[dataEnd - 1] === 10 || bytes[dataEnd - 1] === 13)) dataEnd--;
      }
      data = bytes.subarray(dataStart, dataEnd);
    }
    objs.set(o.num, { num: o.num, dict, data });
  }
  return objs;
}

const findObj = (objs, num) => objs.get(num) || null;

/** /Key N 0 R → N（第一個） */
function refAfter(dict, key) {
  const m = dict.match(new RegExp('\\/' + key + '\\s+(\\d+)\\s+\\d+\\s+R'));
  return m ? +m[1] : -1;
}

/* ---------------- ToUnicode CMap ---------------- */
function hexToUnits(h) {
  const out = [];
  for (let i = 0; i + 3 < h.length; i += 4) out.push(parseInt(h.slice(i, i + 4), 16));
  return out;
}
const unitsToStr = a => a.map(c => String.fromCharCode(c)).join('');

export function parseToUnicode(src) {
  const map = new Map();
  let m;
  const bc = src.match(/beginbfchar([\s\S]*?)endbfchar/);
  if (bc) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = re.exec(bc[1]))) map.set(parseInt(m[1], 16), unitsToStr(hexToUnits(m[2])));
  }
  const br = src.match(/beginbfrange([\s\S]*?)endbfrange/);
  if (br) {
    const re1 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((m = re1.exec(br[1]))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), base = hexToUnits(m[3]);
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        const u = base.slice();
        u[u.length - 1] = u[u.length - 1] + (c - lo);
        map.set(c, unitsToStr(u));
      }
    }
    const re2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((m = re2.exec(br[1]))) {
      const lo = parseInt(m[1], 16);
      const arr = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => unitsToStr(hexToUnits(x[1])));
      for (let i = 0; i < arr.length; i++) map.set(lo + i, arr[i]);
    }
  }
  return map;
}

/* ---------------- 字型資源 ---------------- */
/** 一頁嘅 /Resources /Font：名字 → {dict, _inlineToUni} */
function fontMapFor(page, objs) {
  const d = page.dict;
  let resDict = d;
  const rref = refAfter(d, 'Resources');
  if (rref > 0) resDict = findObj(objs, rref)?.dict || d;
  const fonts = {};
  const fm = resDict.match(/\/Font\s*<<([\s\S]*?)>>/);
  if (fm) {
    const fre = /\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g;
    let f;
    while ((f = fre.exec(fm[1]))) {
      const o = findObj(objs, +f[2]);
      if (o) fonts['/' + f[1]] = o;
    }
  } else {
    const fidx = resDict.indexOf('/Font');
    if (fidx >= 0) {
      const seg = resDict.slice(fidx);
      const dre = /\/([^\s/<>]+)\s*<<([\s\S]*?)>>/g;
      let dd;
      while ((dd = dre.exec(seg))) fonts['/' + dd[1]] = { num: -1, dict: dd[2], _inlineToUni: refAfter(dd[2], 'ToUnicode') };
    }
  }
  return fonts;
}

function fontInfo(fo, objs) {
  if (!fo) return { type0: false, toUni: new Map() };
  const d = fo.dict || '';
  const type0 = /\/Subtype\s*\/Type0/.test(d);
  let ref = refAfter(d, 'ToUnicode');
  if (ref < 0 && fo._inlineToUni > 0) ref = fo._inlineToUni;
  let toUni = new Map();
  if (ref > 0) {
    const o = findObj(objs, ref);
    if (o?.data) {
      try { toUni = parseToUnicode(new TextDecoder('utf-8').decode(inflateZlib(o.data))); } catch { /* 冇對照表就照算 */ }
    }
  }
  return { type0, toUni };
}

/* ---------------- 內容流 tokenizer ---------------- */
function readLiteral(s, i) {          // s[i] === '('
  const out = [];
  let depth = 1, j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      const k = s[j + 1];
      if (k === 'n') out.push(10);
      else if (k === 'r') out.push(13);
      else if (k === 't') out.push(9);
      else if (k === 'b') out.push(8);
      else if (k === 'f') out.push(12);
      else if (k >= '0' && k <= '7') {
        let o = '', p = j + 1;
        while (p < s.length && o.length < 3 && s[p] >= '0' && s[p] <= '7') o += s[p++];
        out.push(parseInt(o, 8) & 0xff);
        j = p - 1;
      } else if (k === '\r' || k === '\n') { /* 行尾續行：跳都唔使跳字 */ if (k === '\r' && s[j + 2] === '\n') j++; }
      else out.push(s.charCodeAt(j + 1) & 0xff);
      j += 2; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (!depth) { j++; break; } }
    const code = s.charCodeAt(j);
    out.push(code > 255 ? 63 : code);
    j++;
  }
  return { bytes: Uint8Array.from(out), next: j };
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
];

/**
 * 行一段內容流，抽出文字 run（連位置）。
 * 只做文字抽取要用嘅狀態（CTM/Tm/Td/TL/Tf），其他 operator 一律略過。
 */
function extractFromContent(src, fontObjs, objs, out, pageIdx) {
  const fonts = {};    // name → info（lazy）
  const info = name => {
    if (!(name in fonts)) fonts[name] = fontInfo(fontObjs['/' + name], objs);
    return fonts[name];
  };
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let curFont = null, curSize = 11;
  const operands = [];
  const nums = k => { const v = []; for (let i = operands.length - 1; i >= 0 && v.length < k; i--) if (operands[i].t === 'n') v.unshift(operands[i].v); return v; };
  const lastName = () => { for (let i = operands.length - 1; i >= 0; i--) if (operands[i].t === 'name') return operands[i].v; return null; };
  const lastStr = () => { for (let i = operands.length - 1; i >= 0; i--) if (operands[i].t === 'str') return operands[i].bytes; return null; };

  const show = bytes => {
    if (!bytes || !bytes.length) return;
    let text = '';
    const f = curFont;
    if (f && (f.type0 || f.toUni.size)) {
      if (f.type0) {
        for (let i = 0; i + 1 < bytes.length; i += 2) text += f.toUni.get((bytes[i] << 8) | bytes[i + 1]) || '';
      } else {
        for (let i = 0; i < bytes.length; i++) text += f.toUni.get(bytes[i]) || '';
      }
    } else {
      text = latin1Str(bytes);
    }
    if (!text.trim()) return;
    const dev = mul(tlm, ctm);
    out.push({ text, x: dev[4], y: dev[5], size: curSize || 11, page: pageIdx });
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') { i++; continue; }
    if (/[0-9+\-.]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9+\-.eE]/.test(src[j])) j++;
      const v = parseFloat(src.slice(i, j));
      if (!Number.isNaN(v)) operands.push({ t: 'n', v });
      i = j; continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/[\s/[\]<>(){}%]/.test(src[j])) j++;
      operands.push({ t: 'name', v: src.slice(i + 1, j) });
      i = j; continue;
    }
    if (ch === '(') { const r = readLiteral(src, i); operands.push({ t: 'str', bytes: r.bytes }); i = r.next; continue; }
    if (ch === '<' && src[i + 1] === '<') { operands.push({ t: 'mark' }); i += 2; continue; }
    if (ch === '<') {
      const j = src.indexOf('>', i);
      if (j < 0) break;
      const rawHex = src.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, '');
      const hex = rawHex.length % 2 ? '0' + rawHex : rawHex;
      const bytes = new Uint8Array(hex.length >> 1);
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
      operands.push({ t: 'str', bytes });
      i = j + 1; continue;
    }
    if (ch === '[') { operands.push({ t: 'mark', arr: true }); i++; continue; }
    if (ch === ']') {
      const items = [];
      while (operands.length && !operands[operands.length - 1].arr) items.unshift(operands.pop());
      if (operands.length) operands.pop();
      operands.push({ t: 'arr', arr: true, items });
      i++; continue;
    }
    if (ch === '>' && src[i + 1] === '>') {
      while (operands.length && operands[operands.length - 1].t !== 'mark') operands.pop();
      if (operands.length) operands.pop();
      i += 2; continue;
    }
    if (ch === '{' || ch === '}') { i++; continue; }
    if (ch === ')' || ch === '>') { i++; continue; }   // 走散咗嘅收口符
    // operator
    let j = i;
    while (j < n && /[A-Za-z'"*]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    const op = src.slice(i, j);
    i = j;
    if (op === 'q') { ctmStack.push(ctm); operands.length = 0; continue; }
    if (op === 'Q') { ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0]; operands.length = 0; continue; }
    if (op === 'cm') { const v = nums(6); if (v.length === 6) ctm = mul(v, ctm); operands.length = 0; continue; }
    if (op === 'BT') { tlm = [1, 0, 0, 1, 0, 0]; operands.length = 0; continue; }
    if (op === 'Tf') {
      const nm = lastName();
      const v = nums(1);
      if (v.length) curSize = v[0];
      curFont = nm ? info(nm) : curFont;
      operands.length = 0; continue;
    }
    if (op === 'Tm') { const v = nums(6); if (v.length === 6) tlm = v.slice(); operands.length = 0; continue; }
    if (op === 'Td') { const v = nums(2); if (v.length === 2) tlm = mul([1, 0, 0, 1, v[0], v[1]], tlm); operands.length = 0; continue; }
    if (op === 'TD') { const v = nums(2); if (v.length === 2) { leading = -v[1]; tlm = mul([1, 0, 0, 1, v[0], v[1]], tlm); } operands.length = 0; continue; }
    if (op === 'TL') { const v = nums(1); if (v.length) leading = v[0]; operands.length = 0; continue; }
    if (op === 'T*') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); operands.length = 0; continue; }
    if (op === 'Tj') { show(lastStr()); operands.length = 0; continue; }
    if (op === "'") { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); show(lastStr()); operands.length = 0; continue; }
    if (op === '"') { show(lastStr()); operands.length = 0; continue; }
    if (op === 'TJ') {
      const arr = operands[operands.length - 1];
      if (arr?.t === 'arr') {
        const parts = [];
        for (const it of arr.items) if (it.t === 'str') parts.push(it.bytes);
        const total = parts.reduce((s2, b) => s2 + b.length, 0);
        const all = new Uint8Array(total);
        let off = 0;
        for (const b of parts) { all.set(b, off); off += b.length; }
        show(all);
      }
      operands.length = 0; continue;
    }
    operands.length = 0;   // 其他 operator：清走 operands 就夠
  }
}

/* ---------------- 行重組 ---------------- */
function groupLines(items) {
  const byPage = new Map();
  items.forEach(it => { (byPage.get(it.page) || byPage.set(it.page, []).get(it.page)).push(it); });
  const lines = [];
  [...byPage.keys()].sort((a, b) => a - b).forEach(pg => {
    const list = byPage.get(pg).slice().sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null, curY = 0;
    list.forEach(it => {
      if (!cur || Math.abs(it.y - curY) > Math.max(3, (it.size || 11) * 0.4)) {
        cur = { text: '', x: it.x, y: it.y, page: pg, size: it.size || 11, _parts: [] };
        curY = it.y;
        lines.push(cur);
      }
      cur._parts.push(it);
      cur.x = Math.min(cur.x, it.x);
    });
  });
  /* 同一行內：按 x 排，隔得太遠就補個空格（中文字連住就唔補） */
  lines.forEach(l => {
    l._parts.sort((a, b) => a.x - b.x);
    let s2 = '', prevEnd = null, prevSize = 11;
    l._parts.forEach(p => {
      const wApprox = p.text.length * (p.size || 11) * 0.55;
      if (prevEnd !== null && p.x - prevEnd > Math.max(1.2, prevSize * 0.3) && !/\s$/.test(s2)) s2 += ' ';
      s2 += p.text;
      prevEnd = p.x + wApprox;
      prevSize = p.size || 11;
    });
    l.text = s2.replace(/[ \t]+$/, '');
    delete l._parts;
  });
  return lines;
}

/* ============================================================
   對外 API
   ============================================================ */

/** PDF (ArrayBuffer/Uint8Array) → 有位置嘅文字行 */
export function extractPdfLines(buf) {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes.length < 100 || latin1Str(bytes.subarray(0, 8)).indexOf('%PDF') !== 0) {
      return { ok: false, lines: [], error: '呢個檔唔係 PDF（個檔頭唔係 %PDF）' };
    }
    const objs = parsePdfObjects(bytes);
    let catalog = null;
    for (const o of objs.values()) if (/\/Type\s*\/Catalog/.test(o.dict)) { catalog = o; break; }
    let kidsSrc = '';
    const pagesRef = catalog ? refAfter(catalog.dict, 'Pages') : -1;
    const pagesObj = pagesRef > 0 ? findObj(objs, pagesRef) : [...objs.values()].find(o => /\/Type\s*\/Pages/.test(o.dict));
    if (pagesObj) kidsSrc = (pagesObj.dict.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1] || '';
    let pageRefs = [...kidsSrc.matchAll(/(\d+)\s+\d+\s+R/g)].map(x => +x[1]).filter(n => objs.has(n));
    if (!pageRefs.length) {
      pageRefs = [...objs.values()].filter(o => /\/Type\s*\/Page[^s]/.test(o.dict)).map(o => o.num);
    }
    if (!pageRefs.length) return { ok: false, lines: [], error: 'PDF 入面搵唔到頁面（可能係加密或者唔完整嘅檔）' };

    const items = [];
    pageRefs.forEach((pnum, idx) => {
      const page = objs.get(pnum);
      if (!page) return;
      const contentIds = [];
      const cm1 = page.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (cm1) contentIds.push(+cm1[1]);
      const cArr = page.dict.match(/\/Contents\s*\[([^\]]*)\]/);
      if (cArr) [...cArr[1].matchAll(/(\d+)\s+\d+\s+R/g)].forEach(x => contentIds.push(+x[1]));
      if (!contentIds.length) return;
      const src = contentIds.map(id => {
        const o = objs.get(id);
        if (!o?.data) return '';
        try { return new TextDecoder('utf-8').decode(inflateZlib(o.data)); } catch { return ''; }
      }).join('\n');
      const fonts = fontMapFor(page, objs);
      extractFromContent(src, fonts, objs, items, idx);
    });

    if (!items.length) {
      return { ok: false, lines: [], error: 'PDF 入面讀唔到文字層（多數係掃描相／圖片）。請改用「複製文字」貼上，或者用手機影相後人手輸入。' };
    }
    return { ok: true, lines: groupLines(items), error: '' };
  } catch (e) {
    return { ok: false, lines: [], error: 'PDF 解析失敗：' + (e?.message || e) };
  }
}

/**
 * PDF → 試卷匯入格式文字。
 * 選項行（x 位置明顯右移）會加兩格縮排 —— parseQuizImport 認得呢個記認。
 * 頁碼、純數字行會丟走。
 */
export function pdfToQuizText(buf) {
  const r = extractPdfLines(buf);
  if (!r.ok) return r;
  const baseX = r.lines.reduce((m, l) => Math.min(m, l.x), Infinity);
  const out = [];
  for (const l of r.lines) {
    const t = String(l.text || '').trim();
    if (!t) continue;
    if (/^\d{1,3}$/.test(t)) continue;                       // 頁碼
    const indent = l.x - baseX > 10;                          // Forms 嘅選項一律右移一段
    out.push((indent ? '  ' : '') + t);
  }
  if (!out.length) return { ok: false, lines: r.lines, error: 'PDF 讀到文字，但係一行有用嘅都冇' };
  return { ok: true, text: out.join('\n'), lineCount: out.length, error: '' };
}

/** File/Blob → 試卷匯入格式文字 */
export async function pdfFileToQuizText(file) {
  const buf = await file.arrayBuffer();
  return pdfToQuizText(buf);
}
