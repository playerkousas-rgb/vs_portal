/* ============================================================
   links.js — 已登入團員入口
   ------------------------------------------------------------
   舊「公開資料／對外專頁／免登入一覽」已刪除。呢頁只管理 members.html 的
   已登入團員入口；未來跨支部分享會由旅層雙邊授權契約處理，唔會喺呢度
   復活匿名公開層。
   ============================================================ */

import { esc, icon, modal, toast, copyText, qrSvg, safeHref } from '../lib/util.js';
import { printDoc, downloadQrSvg, stamp } from '../lib/exporter.js';
import { profile, memberLinks, publicLinkRoute } from '../lib/model.js';
import { pageHead, noteBoxHtml, empty } from './ui.js';

export function title() { return '團員入口'; }

function hubLink() {
  return memberLinks().find(link => link.id === 'hub') || null;
}

export function render() {
  const hub = hubLink();
  const route = publicLinkRoute();
  return `
  ${pageHead({
    title: '團員入口',
    sub: '派畀本團成員的登入入口；所有內容都要先核實個人身份',
    actions: hub ? `<button class="btn btn-sm" data-act="copy-hub">${icon('copy', 14)} 複製入口</button>
      <button class="btn btn-sm btn-primary" data-act="print-hub">${icon('print', 14)} 列印登入 QR</button>` : ''
  })}

  ${noteBoxHtml(`<b>呢個唔係公開專頁。</b>掃 QR 之後仍然要用本團的電郵／Scout ID 同密碼登入；
    系統唔會再向未登入訪客展示旅團簡介、相簿、社交連結、行事曆、通告或試卷。
    <div class="xs mt-4">跨支部資料日後由「來源支部分享整個獲准資料包 → 接收支部接受 → 接收支部授權本地身份」三道門處理，唔使用呢條團員入口。</div>`, 'brand')}

  ${noteBoxHtml(`<b>入口路線：${esc(route.label)}</b><div class="xs mt-4">${esc(route.detail)}</div>`, route.ok ? 'info' : 'warn')}

  ${hub ? `<div class="card" style="max-width:680px">
    <div class="card-head"><div><div class="card-title">本團團員登入 QR</div>
      <div class="card-sub" style="word-break:break-all">${esc(hub.url)}</div></div></div>
    <div class="center" style="padding:24px">
      <div class="qr-box" style="width:230px;margin:0 auto">${qrSvg(hub.url, 6, 2)}</div>
      <div class="row gap-8 wrap center mt-16" style="justify-content:center">
        <button class="btn btn-sm" data-act="copy-hub">${icon('copy', 14)} 複製登入連結</button>
        <button class="btn btn-sm" data-act="download-qr">${icon('download', 14)} 下載 QR</button>
        <button class="btn btn-sm btn-primary" data-act="print-hub">${icon('print', 14)} 列印登入海報</button>
        <button class="btn btn-sm" data-open="${esc(hub.url)}">${icon('external', 14)} 測試入口</button>
      </div>
      <div class="hint mt-16">QR 只係帶用戶去登入頁，唔係閱讀憑證；權限仍以登入者本支部身份為準。</div>
    </div>
  </div>` : empty('users', '未能產生團員入口', '請先完成旅團後端接線，再重新載入。')}`;
}

export function mount(root) {
  const hub = hubLink();
  const url = hub?.url || '';
  root.querySelectorAll('[data-act="copy-hub"]').forEach(button => button.addEventListener('click', async () => {
    if (!url) return;
    const ok = await copyText(`【${profile().name || ''}】團員登入入口\n${url}`);
    toast(ok ? '已複製團員登入入口' : '複製失敗', ok ? 'ok' : 'err');
  }));
  root.querySelector('[data-act="download-qr"]')?.addEventListener('click', () => {
    if (url) downloadQrSvg(url, `團員登入_QR_${stamp()}.svg`, 8, 3);
  });
  root.querySelectorAll('[data-act="print-hub"]').forEach(button => button.addEventListener('click', () => {
    if (!url) return;
    printDoc({
      title: '團員登入入口', org: profile().name,
      trustedBodyHtml: `<div style="text-align:center">
        <div class="doc-org" style="letter-spacing:.2em">${esc(profile().name || '')}</div>
        <div class="doc-title" style="font-size:19pt;letter-spacing:.14em;margin:8pt 0 4pt">團員登入入口</div>
        <div style="margin:16pt auto;width:240px">${qrSvg(url, 7, 2)}</div>
        <p style="font-size:12pt">掃描後請用個人電郵／Scout ID 同密碼登入。</p>
        <p style="font-size:10pt"><b>此 QR 不會免除登入，亦不會向外公開本團資料。</b></p>
        <p class="mono" style="font-size:9pt;word-break:break-all">${esc(url)}</p>
      </div>`
    });
  }));
  root.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => {
    const href = safeHref(button.dataset.open, { allowRelative: true });
    if (href === '#') return toast('入口網址唔安全，已停止開啟', 'err');
    window.open(href, '_blank', 'noopener');
  }));
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
