/* ============================================================
   tests/_gasvm.mjs — 迷你 Google Apps Script 模擬器（共用）
   ------------------------------------------------------------
   真正執行 apps-script/Code.gs（vm.runInContext），Stub 晒
   SpreadsheetApp / PropertiesService / LockService / Utilities …
   由 tests/gas.mjs 抽出嚟共用：
     · tests/gas.mjs      —— 契約測試（authorization／action 契約）
     · tests/_realgas.mjs —— 把同一個「真 Code.gs」包做一個 HTTP /exec，
                            俾 dev-server /api/proxy 同真前端端到端打
   點解要共用：以前端到端測試全部打 tests/_fakegas.mjs（一份**重寫**嘅
   假後端）。假後端同真 Code.gs 行為一旦有出入，測試全綠、真站照死 ——
   「儲存唔到去後端」就係呢種盲點。
   ============================================================ */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ============================================================
   迷你 Google Apps Script 模擬器
   ============================================================ */
function makeSheet(name, headers) {
  const rows = headers ? [headers.slice()] : [];
  const chain = {};
  const range = (row, col, nr = 1, nc = 1) => ({
    setValues: (vals) => {
      vals.forEach((v, i) => {
        const ri = row - 1 + i;
        while (rows.length <= ri) rows.push([]);
        v.forEach((cell, j) => { rows[ri][col - 1 + j] = cell; });
      });
      return chain;
    },
    setValue: (v) => { const ri = row - 1; while (rows.length <= ri) rows.push([]); rows[ri][col - 1] = v; return chain; },
    getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const r = rows[row - 1 + i] || []; out.push(r.slice(col - 1, col - 1 + nc)); } return out; },
    getValue: () => (rows[row - 1] || [])[col - 1],
    setFontWeight: () => chain, setBackground: () => chain, setFontColor: () => chain,
    setNumberFormat: () => chain, setWrap: () => chain, setHorizontalAlignment: () => chain,
    setFontSize: () => chain, setBorder: () => chain, clearContent: () => chain, setFontFamily: () => chain
  });
  Object.assign(chain, range(1, 1));
  const sheet = {
    _rows: rows,
    getName: () => name,
    /* 真 GAS 嘅 appendRow 會回返個 Sheet（可以連住 .getRange()）—— stub 要一樣 */
    appendRow: (r) => { rows.push(r.slice()); return sheet; },
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()), clearContent: () => { rows.length = 0; } }),
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: range,
    deleteRow: (i) => { rows.splice(i - 1, 1); },
    deleteRows: (i, n) => { rows.splice(i - 1, n); },
    setFrozenRows: () => {}, setColumnWidth: () => {}, autoResizeColumn: () => {},
    clear: () => { rows.length = 0; }, clearContents: () => { rows.length = 0; },
    getSheetId: () => 1, hideSheet: () => {}, showSheet: () => {}, setTabColor: () => {}, getFilter: () => null
  };
  return sheet;
}

function makeGas({ apiKey = null } = {}) {
  const sheets = new Map();
  const props = new Map();
  if (apiKey) props.set('API_KEY', apiKey);

  const ss = {
    getName: () => '測試試算表',
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s) => sheets.delete(s.getName()),
    getId: () => 'fake', setSpreadsheetTimeZone: () => {}, getSpreadsheetTimeZone: () => 'Asia/Hong_Kong'
  };

  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss,
      getUi: () => { throw new Error('headless'); }, flush: () => {}
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, v); },
        deleteProperty: (k) => { props.delete(k); }
      })
    },
    Utilities: {
      getUuid: () => 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
      formatDate: (d) => new Date(d).toISOString(), sleep: () => {},
      base64Decode: () => [], newBlob: () => ({ setName: () => ({}) })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    Logger: { log: () => {} },
    DriveApp: { getFolderById: () => ({ createFile: () => ({ getUrl: () => 'https://drive/x', setSharing: () => {} }) }) },
    ContentService: {
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
      MimeType: { JSON: 'application/json' }
    },
    MailApp: { sendEmail: () => {} },
    Session: { getActiveUser: () => ({ getEmail: () => 't@e.com' }) },
    console, JSON, Date, Math, String, Number, Object, Array,
    isNaN, parseInt, parseFloat, RegExp, Error, encodeURIComponent, decodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });

  const post = (body) => {
    const out = sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
    try { return JSON.parse(out.getContent()); } catch { return { _raw: out.getContent() }; }
  };
  /* GET（doGet：?action=load 讀進度 —— 進度前端／團員入口用） */
  const get = (params = {}) => {
    const out = sandbox.doGet({ parameter: params });
    try { return JSON.parse(out.getContent()); } catch { return { _raw: out.getContent() }; }
  };
  return { sandbox, post, get, props, sheets };
}

export { makeSheet, makeGas };
