/* ============================================================
   zip.js — 純瀏覽器 ZIP 讀取器（匯入 .xlsx / Google Docs .docx）
   ------------------------------------------------------------
   只做「讀」：支援一般 ZIP 的 stored / deflate entry，不執行巨集，亦不會
   上載原檔。解壓使用現代瀏覽器內建 DecompressionStream，避免把大型第三方
   套件同供應鏈帶入零依賴前端。
   ============================================================ */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const DEFAULT_MAX_ENTRY = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 40 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5000;

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('ZIP 內容格式不正確');
}
function u16(v, p) { return v.getUint16(p, true); }
function u32(v, p) { return v.getUint32(p, true); }
function limit(value, fallback, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label}安全上限不正確`);
  return n;
}
function decodeName(bytes, utf8 = true) {
  try { return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}

async function inflateRaw(bytes, maxBytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('呢個瀏覽器未支援 ZIP 解壓；請更新瀏覽器，或者先把檔案另存 CSV／純文字再匯入');
  }
  let stream;
  try { stream = new DecompressionStream('deflate-raw'); }
  catch {
    throw new Error('呢個瀏覽器未支援 XLSX／DOCX 使用嘅 deflate 解壓；請更新瀏覽器或改用 CSV／純文字');
  }
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error('ZIP_ENTRY_TOO_LARGE');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(chunk => { out.set(chunk, offset); offset += chunk.byteLength; });
    return out;
  } catch (e) {
    if (e?.message === 'ZIP_ENTRY_TOO_LARGE') throw new Error('ZIP 解壓內容超出安全上限，為保障手機記憶體已停止');
    throw new Error('ZIP 內有一個檔案解壓失敗；原檔可能損壞或使用咗不支援嘅壓縮方式');
  }
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 讀取 ZIP entries。
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{wanted?:(name:string)=>boolean,maxEntryBytes?:number,maxTotalBytes?:number,maxArchiveBytes?:number,maxEntries?:number}} options
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function unzip(input, options = {}) {
  const bytes = asBytes(input);
  const maxArchive = limit(options.maxArchiveBytes, DEFAULT_MAX_ARCHIVE, 'ZIP 原檔');
  if (bytes.byteLength > maxArchive) throw new Error('ZIP 原檔超出安全上限，請只保留要匯入嘅工作表／文字');
  if (bytes.byteLength < 22) throw new Error('檔案太短，唔係有效 ZIP');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let p = bytes.byteLength - 22; p >= floor; p--) {
    if (u32(view, p) !== SIG_EOCD) continue;
    /* A signature inside the ZIP comment is not an EOCD. Requiring its declared
       comment to reach the real end prevents directory-confusion tricks. */
    const commentLen = u16(view, p + 20);
    if (p + 22 + commentLen === bytes.byteLength) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('搵唔到 ZIP 目錄；檔案可能唔完整');

  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const diskCount = u16(view, eocd + 8);
  const count = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count) throw new Error('唔支援分卷 ZIP');
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('唔支援 ZIP64；請先把檔案另存成一般 .xlsx／.docx');
  }
  const maxEntries = limit(options.maxEntries, DEFAULT_MAX_ENTRIES, 'ZIP entry 數量');
  if (count > maxEntries) throw new Error('ZIP entry 數量超出安全上限');
  if (centralOffset + centralSize > eocd) throw new Error('ZIP 目錄超出檔案範圍');

  const wanted = typeof options.wanted === 'function' ? options.wanted : () => true;
  const maxEntry = limit(options.maxEntryBytes, DEFAULT_MAX_ENTRY, 'ZIP 單一 entry');
  const maxTotal = limit(options.maxTotalBytes, DEFAULT_MAX_TOTAL, 'ZIP 解壓總內容');
  const index = [];
  const selectedNames = new Set();
  let declaredTotal = 0;
  let p = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let i = 0; i < count; i++) {
    if (p + 46 > centralEnd || u32(view, p) !== SIG_CENTRAL) throw new Error('ZIP 中央目錄損壞');
    const flags = u16(view, p + 8);
    const method = u16(view, p + 10);
    const crc = u32(view, p + 16);
    const compressedSize = u32(view, p + 20);
    const uncompressedSize = u32(view, p + 24);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > centralEnd) throw new Error('ZIP entry 名稱超出檔案範圍');
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800)).replace(/\\/g, '/');
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('ZIP entry 名稱包含無效控制字元');
    if (wanted(name) && !name.endsWith('/')) {
      if (flags & 1) throw new Error(`ZIP 入面嘅「${name}」有密碼，系統唔會要求或處理檔案密碼`);
      if (![0, 8].includes(method)) throw new Error(`ZIP 入面嘅「${name}」使用不支援嘅壓縮方式（${method}）`);
      if (uncompressedSize > maxEntry || (method === 0 && compressedSize > maxEntry)) throw new Error(`ZIP 入面嘅「${name}」解壓後太大`);
      const cleanName = name.replace(/^\/+/, '');
      const parts = cleanName.split('/');
      if (!cleanName || name.startsWith('/') || parts.some(part => !part || part === '.' || part === '..')
        || selectedNames.has(cleanName)) {
        throw new Error(`ZIP entry「${cleanName || name}」重複或名稱無效`);
      }
      selectedNames.add(cleanName);
      declaredTotal += uncompressedSize;
      if (declaredTotal > maxTotal) throw new Error('ZIP 解壓後總內容太大，為保障手機記憶體已停止');
      index.push({ name: cleanName, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    }
    p = end;
  }

  const out = new Map();
  let total = 0;
  for (const entry of index) {
    const lp = entry.localOffset;
    if (lp + 30 > centralOffset || u32(view, lp) !== SIG_LOCAL) throw new Error(`ZIP entry「${entry.name}」位置損壞`);
    const localFlags = u16(view, lp + 6);
    const localMethod = u16(view, lp + 8);
    const nameLen = u16(view, lp + 26);
    const extraLen = u16(view, lp + 28);
    const nameEnd = lp + 30 + nameLen;
    const start = nameEnd + extraLen;
    const end = start + entry.compressedSize;
    if (nameEnd > centralOffset || end > centralOffset) throw new Error(`ZIP entry「${entry.name}」內容唔完整`);
    const localName = decodeName(bytes.subarray(lp + 30, nameEnd), !!(localFlags & 0x800))
      .replace(/\\/g, '/').replace(/^\/+/, '');
    if (localName !== entry.name || localMethod !== entry.method || ((localFlags ^ entry.flags) & 1)) {
      throw new Error(`ZIP entry「${entry.name}」本機標頭同目錄不一致`);
    }
    const packed = bytes.subarray(start, end);
    const remaining = Math.max(0, maxTotal - total);
    const cap = Math.min(maxEntry, remaining);
    const value = entry.method === 0 ? new Uint8Array(packed) : await inflateRaw(packed, cap);
    if (value.byteLength > cap) throw new Error(`ZIP entry「${entry.name}」解壓後太大`);
    if (entry.uncompressedSize && value.byteLength !== entry.uncompressedSize) {
      throw new Error(`ZIP entry「${entry.name}」解壓後大小唔一致`);
    }
    if (crc32(value) !== entry.crc) throw new Error(`ZIP entry「${entry.name}」校驗失敗；原檔可能損壞`);
    total += value.byteLength;
    if (total > maxTotal) throw new Error('ZIP 解壓後總內容太大，為保障手機記憶體已停止');
    out.set(entry.name.replace(/^\/+/, ''), value);
  }
  return out;
}

export function zipText(entries, name, { required = true } = {}) {
  const bytes = entries.get(String(name || '').replace(/^\/+/, ''));
  if (!bytes) {
    if (required) throw new Error(`壓縮檔缺少 ${name}`);
    return '';
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** 將 OOXML relationship target 變成 ZIP 內實際路徑。
 *  External URL、控制字元及越過壓縮檔根目錄的 traversal 一律拒絕。 */
export function resolveZipPath(baseFile, target) {
  const raw = String(target || '').replace(/\\/g, '/');
  if (!raw || /[\u0000-\u001f\u007f?#]/.test(raw) || raw.startsWith('//')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return '';
  const absolute = raw.startsWith('/');
  const parts = absolute ? [] : String(baseFile || '').replace(/\\/g, '/').split('/');
  if (!absolute) parts.pop();
  for (const part of raw.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length && !parts.some(part => part === '..') ? parts.join('/') : '';
}
