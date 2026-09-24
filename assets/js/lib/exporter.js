/* ============================================================
   exporter.js — 輸出中心：Word / PDF / CSV / Markdown / 單一 HTML / QR
   Word：用 .doc（HTML 格式，Word 及 Google Docs 都開得）
   PDF ：用瀏覽器列印（可「另存為 PDF」），A4 排版
   ============================================================ */

import { qrDataUrl, esc, qrSvg } from './util.js';

export function download(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/* ---------------- 共用樣式（Word + PDF + HTML） ---------------- */
export function docCss({ fontFamily = `"Times New Roman", "PMingLiU", "Microsoft JhengHei", "Noto Serif TC", serif` } = {}) {
  return `
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: ${fontFamily}; font-size: 11pt; line-height: 1.75; color: #1b1b1b; margin: 0; }
  .doc-head { text-align: center; border-bottom: 2.5pt solid #7B2233; padding-bottom: 8pt; margin-bottom: 14pt; }
  .doc-org { font-size: 10.5pt; letter-spacing: .18em; color: #7B2233; font-weight: 700; }
  .doc-title { font-size: 20pt; font-weight: 800; letter-spacing: .3em; margin: 6pt 0 2pt; }
  .doc-sub { font-size: 10pt; color: #555; }
  .doc-meta { font-size: 9.5pt; color: #666; display:flex; justify-content:space-between; gap:12pt; margin-bottom: 12pt; }
  h2 { font-size: 13pt; color: #7B2233; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: .6pt solid #e3ccd2; page-break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 12pt 0 5pt; page-break-after: avoid; }
  p { margin: 0 0 6pt; text-align: justify; }
  .art { margin: 0 0 7pt; }
  .art-no { font-weight: 700; margin-right: 4pt; }
  .art-item { margin-left: 16pt; display: flex; gap: 6pt; }
  .art-item.sub { margin-left: 32pt; }
  .en { color: #444; font-size: 10.5pt; }
  .en-block { color: #555; font-size: 10.5pt; margin: 3pt 0 8pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 8pt 0 12pt; }
  th, td { border: .6pt solid #cfc8c8; padding: 5pt 6pt; vertical-align: top; }
  th { background: #FBF1F3; color: #5E1826; text-align: left; font-weight: 700; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; background: #FAF7F7; }
  .kpi { display: flex; gap: 10pt; margin: 8pt 0 14pt; }
  .kpi > div { flex: 1; border: .8pt solid #e0d3d6; border-radius: 6pt; padding: 8pt 10pt; }
  .kpi .k { font-size: 9pt; color: #666; }
  .kpi .v { font-size: 15pt; font-weight: 800; color: #5E1826; }
  .note { font-size: 9.5pt; color: #666; border-left: 3pt solid #7B2233; padding: 4pt 8pt; background: #FBF1F3; }
  .foot { margin-top: 18pt; padding-top: 6pt; border-top: .6pt solid #ddd; font-size: 9pt; color: #777; display:flex; justify-content:space-between; }
  .avoid-break { page-break-inside: avoid; }
  @media print { .no-print { display: none !important; } }
  `;
}

function docShell(title, bodyHtml, { org = '', meta = '', css = '' } = {}) {
  return `<!doctype html><html lang="zh-Hant-HK"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${docCss()}${css}</style></head><body>
${org ? `<div class="doc-org">${esc(org)}</div>` : ''}
${bodyHtml}
</body></html>`;
}

/* ---------------- Word (.doc) ---------------- */
export function wordHtml({ title, org = '', bodyHtml, meta = '' }) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>${docCss()}</style></head>
<body>${org ? `<div class="doc-org">${esc(org)}</div>` : ''}${bodyHtml}${meta ? `<div style="font-size:9pt;color:#666">${esc(meta)}</div>` : ''}</body></html>`;
}
export function toWord({ filename, title, org = '', bodyHtml, meta = '' }) {
  download(filename.endsWith('.doc') ? filename : filename + '.doc', '\ufeff' + wordHtml({ title, org, bodyHtml, meta }), 'application/msword');
  return true;
}

/* ---------------- Markdown ---------------- */
export function toMarkdown({ filename, md }) {
  download(filename.endsWith('.md') ? filename : filename + '.md', md, 'text/markdown;charset=utf-8');
}

/* ---------------- CSV ---------------- */
export function csvText({ rows, headers }) {
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  if (headers) lines.push(headers.map(cell).join(','));
  rows.forEach(r => lines.push(r.map(cell).join(',')));
  return lines.join('\r\n');
}
export function toCSV({ filename, rows, headers }) {
  download(filename.endsWith('.csv') ? filename : filename + '.csv', '\ufeff' + csvText({ rows, headers }), 'text/csv;charset=utf-8');
}

/* ---------------- 單一 HTML（可離線／可上載，QR 目標） ---------------- */
export function toStandaloneHtml({ filename, title, org = '', bodyHtml, meta = '', extraHead = '' }) {
  const html = docShell(title, bodyHtml, { org, meta, css: `
    body{max-width:820px;margin:0 auto;padding:24px 18px 60px;background:#fff}
    .toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #e8dfe1;padding:8px 0 10px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .toolbar button{font:inherit;padding:7px 12px;border:1px solid #d9cdd0;border-radius:8px;background:#fff;cursor:pointer}
    .toolbar button.on{background:#7B2233;color:#fff;border-color:#7B2233}
    @media print{.toolbar{display:none}}
    ${extraHead}` });
  download(filename.endsWith('.html') ? filename : filename + '.html', html, 'text/html;charset=utf-8');
  return html;
}

/* ---------------- PDF（用瀏覽器列印） ---------------- */
export function printDoc({ title, org = '', bodyHtml, meta = '' }) {
  const html = docShell(title, bodyHtml, { org, meta });
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  const go = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) { console.error(e); }
    setTimeout(() => iframe.remove(), 1500);
  };
  // 等字型／版面穩定
  setTimeout(go, 320);
}

/* ---------------- QR ---------------- */
/* 單一實作在 util.js（避免兩份），喺呢度再出口方便 view 一併匯入 */
export { qrSvg, downloadSvgEl } from './util.js';

/** data URL → Blob（下載用） */
function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(String(dataUrl)) || [];
  const mime = m[1] || 'application/octet-stream';
  const body = m[3] || '';
  if (m[2]) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** data URL → PNG data URL（用 canvas；冇 canvas／載入唔到就回 null） */
function dataUrlToPng(dataUrl) {
  return new Promise(resolve => {
    try {
      if (typeof Image !== 'function' || !document.createElement('canvas').getContext) return resolve(null);
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 1200);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const cv = document.createElement('canvas');
          cv.width = img.width || 512; cv.height = img.height || 512;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(img, 0, 0);
          resolve(cv.toDataURL('image/png'));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = dataUrl;
    } catch (e) { resolve(null); }
  });
}

/**
 * 儲存 QR 圖（畀執委分享落 WhatsApp／儲存落手機相簿）
 * 有 canvas 就出 .png，冇就出 .gif —— 兩者 WhatsApp 都收
 */
export async function downloadQrImage(text, filename = 'QR', cell = 10, margin = 4) {
  const dataUrl = qrDataUrl(text, cell, margin);
  if (!dataUrl) return false;
  const png = await dataUrlToPng(dataUrl);
  if (png) { download(`${filename}.png`, dataUrlToBlob(png), 'image/png'); return true; }
  download(`${filename}.gif`, dataUrlToBlob(dataUrl), 'image/gif');
  return true;
}

export function downloadQrSvg(text, filename = 'qrcode.svg', cell = 8, margin = 3) {
  const svg = qrSvg(text, cell, margin);
  if (/QR 產生失敗|QR 模組未載入/.test(svg)) return false;
  download(filename, '<?xml version="1.0" encoding="UTF-8"?>' + svg, 'image/svg+xml;charset=utf-8');
  return true;
}
