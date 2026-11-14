/* ============================================================
   xlsx.js — 原生 .xlsx 讀取（財務／舊資源遷移）
   ------------------------------------------------------------
   XLSX 其實係 ZIP + XML。呢個模組只讀工作表值，不執行公式／巨集／外部連結，
   原檔全程留喺瀏覽器。支援共享字串、inline string、數字、布林值及常見日期格式。
   ============================================================ */

import { unzip, zipText, resolveZipPath } from './zip.js';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_SHEETS = 256;
const MAX_SHARED_STRINGS = 200000;
const MAX_STYLES = 65536;
const MAX_SHEET_ROWS = 100000;
const MAX_SHEET_COLUMNS = 1024;
const MAX_SHEET_CELLS = 500000;

function xmlCodePoint(raw, radix) {
  const cp = Number.parseInt(raw, radix);
  const valid = cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);
  return valid ? String.fromCodePoint(cp) : '\uFFFD';
}
export function decodeXml(value) {
  return String(value || '').replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi,
    (_, hex, dec, named) => {
      if (hex) return xmlCodePoint(hex, 16);
      if (dec) return xmlCodePoint(dec, 10);
      return XML_ENTITIES[String(named || '').toLowerCase()] || _;
    });
}
function attr(tag, name) {
  const escaped = String(name).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const m = String(tag || '').match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return decodeXml(m ? (m[1] ?? m[2] ?? '') : '');
}
function texts(xml) {
  return [...String(xml || '').matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
    .map(m => decodeXml(m[1])).join('');
}
function colIndex(ref) {
  const m = String(ref || '').match(/^([A-Z]+)/i);
  if (!m) return -1;
  let n = 0;
  for (const c of m[1].toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}
function excelDate(serial, date1904 = false) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return String(serial ?? '');
  const millis = Math.round((n - (date1904 ? 24107 : 25569)) * 86400000);
  const d = new Date(millis);
  if (Number.isNaN(d.getTime())) return String(serial ?? '');
  const iso = d.toISOString();
  const fraction = Math.abs(n - Math.trunc(n));
  return fraction > 0.000001 ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
}

function parseSharedStrings(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/gi)) {
    if (out.length >= MAX_SHARED_STRINGS) throw new Error('Excel 共享文字數量超出安全上限');
    out.push(texts(m[1]));
  }
  return out;
}
function parseDateStyles(xml) {
  if (!xml) return new Set();
  const custom = new Map();
  for (const m of String(xml).matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?\s*>/gi)) {
    if (custom.size >= MAX_STYLES) throw new Error('Excel 樣式數量超出安全上限');
    custom.set(Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode'));
  }
  const builtInDates = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const dateStyles = new Set();
  const xfs = String(xml).match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/i)?.[1] || '';
  let index = 0;
  for (const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*)\/?\s*>/gi)) {
    if (index >= MAX_STYLES) throw new Error('Excel 樣式數量超出安全上限');
    const id = Number(attr(m[1], 'numFmtId'));
    const code = String(custom.get(id) || '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '').toLowerCase();
    if (builtInDates.has(id) || /(^|[^a-z])[ymdhis]+([^a-z]|$)/i.test(code)) dateStyles.add(index);
    index++;
  }
  return dateStyles;
}

function parseSheet(xml, shared, dateStyles, date1904 = false) {
  const rows = [];
  let fallbackRow = 0;
  let rowElements = 0;
  let cellCount = 0;
  for (const rm of String(xml || '').matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/gi)) {
    rowElements++;
    if (rowElements > MAX_SHEET_ROWS) throw new Error('Excel 工作表行數超出安全上限');
    const declared = Number(attr(rm[1], 'r'));
    const ri = Number.isInteger(declared) && declared > 0 ? declared - 1 : fallbackRow;
    if (!Number.isSafeInteger(ri) || ri < 0 || ri >= MAX_SHEET_ROWS) {
      throw new Error('Excel 工作表行號超出安全上限');
    }
    fallbackRow = ri + 1;
    const row = rows[ri] || [];
    let fallbackCol = 0;
    for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi)) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = attr(attrs, 'r');
      const referencedCol = colIndex(ref);
      const ci = referencedCol >= 0 ? referencedCol : fallbackCol;
      if (!Number.isSafeInteger(ci) || ci < 0 || ci >= MAX_SHEET_COLUMNS) {
        throw new Error('Excel 工作表欄號超出安全上限');
      }
      cellCount++;
      if (cellCount > MAX_SHEET_CELLS) throw new Error('Excel 工作表儲存格數量超出安全上限');
      fallbackCol = ci + 1;
      const type = attr(attrs, 't');
      const style = Number(attr(attrs, 's'));
      const raw = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i)?.[1] ?? '';
      let value;
      if (type === 'inlineStr') value = texts(body);
      else if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'b') value = String(raw) === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e' || type === 'd') value = decodeXml(raw);
      else if (raw === '') value = '';
      else if (dateStyles.has(style)) value = excelDate(raw, date1904);
      else {
        const num = Number(raw);
        value = Number.isFinite(num) ? String(num) : decodeXml(raw);
      }
      row[ci] = String(value ?? '');
    }
    rows[ri] = row;
  }
  while (rows.length && !(rows[rows.length - 1] || []).some(v => String(v || '').trim())) rows.pop();
  const maxColumns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { rows: rows.map(r => Array.from({ length: maxColumns }, (_, i) => String(r?.[i] ?? ''))), maxColumns };
}

function parseRelationships(xml) {
  const map = new Map();
  for (const m of String(xml || '').matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

/**
 * 讀取 Excel .xlsx ArrayBuffer。
 * @returns {Promise<{sheets:Array<{name:string,rows:string[][],maxColumns:number}>,warnings:string[]}>}
 */
export async function readXlsx(input) {
  const entries = await unzip(input, {
    wanted: name => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels'
      || name === 'xl/sharedStrings.xml' || name === 'xl/styles.xml' || /^xl\/worksheets\/[^/]+\.xml$/i.test(name)
  });
  const workbook = zipText(entries, 'xl/workbook.xml');
  const rels = parseRelationships(zipText(entries, 'xl/_rels/workbook.xml.rels'));
  const workbookPr = workbook.match(/<(?:\w+:)?workbookPr\b([^>]*)\/?\s*>/i)?.[1] || '';
  const date1904 = /^(?:1|true)$/i.test(attr(workbookPr, 'date1904'));
  const shared = parseSharedStrings(zipText(entries, 'xl/sharedStrings.xml', { required: false }));
  const dateStyles = parseDateStyles(zipText(entries, 'xl/styles.xml', { required: false }));
  const sheets = [];
  const warnings = [];
  let sheetCount = 0;
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?\s*>/gi)) {
    sheetCount++;
    if (sheetCount > MAX_SHEETS) throw new Error('Excel 工作表數量超出安全上限');
    const name = attr(m[1], 'name') || `工作表 ${sheets.length + 1}`;
    const rid = attr(m[1], 'r:id') || attr(m[1], 'id');
    const target = rels.get(rid);
    if (!target) { warnings.push(`搵唔到「${name}」嘅工作表關係`); continue; }
    const path = resolveZipPath('xl/workbook.xml', target);
    if (!path) { warnings.push(`「${name}」工作表關係路徑不安全或無效`); continue; }
    const xml = zipText(entries, path, { required: false });
    if (!xml) { warnings.push(`搵唔到「${name}」內容（${path}）`); continue; }
    const parsed = parseSheet(xml, shared, dateStyles, date1904);
    sheets.push({ name, ...parsed });
  }
  if (!sheets.length) throw new Error('Excel 檔案入面搵唔到可讀工作表');
  return { sheets, warnings };
}

export function sheetToTsv(sheet, { headerRow = 0 } = {}) {
  const rows = Array.isArray(sheet?.rows) ? sheet.rows.slice(Math.max(0, Number(headerRow) || 0)) : [];
  return rows.map(row => row.map(value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t')).join('\n');
}

/** 由一行揀最可能嘅標題行：有最多非空文字、並含常見財務欄名。 */
export function detectHeaderRow(rows, maxScan = 12) {
  const known = /日期|date|類型|type|項目|item|收入|支出|金額|amount|結餘|balance|備註|note|付款|經手/i;
  let best = 0;
  let score = -1;
  (Array.isArray(rows) ? rows : []).slice(0, maxScan).forEach((row, i) => {
    const values = (row || []).map(v => String(v || '').trim()).filter(Boolean);
    const hits = values.filter(v => known.test(v)).length;
    const candidate = hits * 20 + Math.min(values.length, 12) - (values.length <= 1 ? 10 : 0);
    if (candidate > score) { score = candidate; best = i; }
  });
  return best;
}
