/* ============================================================
   util.js — 共用工具：DOM、格式化、圖示、Toast、Modal、QR Code
   ============================================================ */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- escaping / ids ---------- */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

/* ---------- formatting ---------- */
export function money(n) {
  const v = Number(n) || 0;
  return 'HK$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
export function moneyPlain(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function nowStamp() {
  const d = new Date();
  return `${todayISO()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtDate(iso, style = 'md') {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  if (style === 'full') return `${y} 年 ${m} 月 ${d} 日`;
  if (style === 'short') return `${m}/${d}`;
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  return `<span class="mono">${esc(String(iso).slice(0, 10))}</span> <span class="faint">${esc(String(iso).slice(11, 16))}</span>`;
}
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function weekday(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return '週' + WEEK[new Date(y, m - 1, d).getDay()];
}
export function monthKey(iso) { return String(iso).slice(0, 7); }
export function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${y} 年 ${Number(m)} 月`;
}
export function daysUntil(iso) {
  if (!iso) return null;
  const a = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  const b = new Date(todayISO() + 'T00:00:00');
  return Math.round((a - b) / 86400000);
}
export function relDay(iso) {
  const n = daysUntil(iso);
  if (n === null) return '';
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === -1) return '昨天';
  if (n > 0) return `${n} 日後`;
  return `${Math.abs(n)} 日前`;
}

/* ---------- people ---------- */
export function initials(name = '?') {
  const n = String(name).trim();
  if (!n) return '?';
  if (/^[A-Za-z]/.test(n)) {
    const parts = n.split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
  }
  return n.slice(-2);
}
const PALETTE = ['#0F5132', '#A32B2B', '#1F5FA8', '#7A4E9B', '#0E7490', '#B45309', '#4D7C0F', '#BE185D', '#334155', '#065F46'];
export function colorFrom(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function avatar(name, size = '') {
  return `<span class="avatar ${size}" style="background:${colorFrom(name)}">${esc(initials(name))}</span>`;
}

/* ---------- files ---------- */
export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* execCommand 喺邊度都可能唔存在（舊 fallback）——失敗就乾淨咁回 false，
       唔好 throw 出去（用家會見到「複製失敗」toast，唔係整頁卡死） */
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }
}

/* ---------- icons (24px stroke) ---------- */
const P = {
  home:      '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  calendar:  '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8.5 15h3"/>',
  wallet:    '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H19a2 2 0 0 1 2 2v1"/><path d="M3 8.5V17a3 3 0 0 0 3 3h14a2 2 0 0 0 2-2v-5"/><path d="M21 10.5h-4a2 2 0 0 0 0 4h4z"/>',
  users:     '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M17 4.2a3.5 3.5 0 0 1 0 6.6"/><path d="M22 20v-1.5a4 4 0 0 0-3-3.8"/>',
  chart:     '<path d="M3 3v16.5A1.5 1.5 0 0 0 4.5 21H21"/><path d="M7.5 15.5 11 11l3 2.5 4.5-6"/>',
  book:      '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/>',
  shield:    '<path d="M12 3 5 6v6c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6z"/><path d="m9.2 12.2 2 2 3.6-3.8"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  search:    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.7-4.7"/>',
  logout:    '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20H15"/><path d="M10 16.5 5.5 12 10 7.5"/><path d="M5.5 12H16"/>',
  check:     '<path d="m4.5 12.5 5 5 10-11"/>',
  x:         '<path d="M6 6l12 12M18 6 6 18"/>',
  edit:      '<path d="M12 20h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
  trash:     '<path d="M4 7h16"/><path d="M9.5 7V4.8A.8.8 0 0 1 10.3 4h3.4a.8.8 0 0 1 .8.8V7"/><path d="M6.5 7 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2A1.5 1.5 0 0 0 16.6 20L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/>',
  download:  '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  print:     '<path d="M7 8.5V4h10v4.5"/><rect x="4" y="8.5" width="16" height="7" rx="1.5"/><path d="M7 15.5h10v5H7z"/>',
  qr:        '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v0M14 20v0M20 20v0"/><path d="M17.5 14v3M14 17.5h3"/>',
  link:      '<path d="M9.5 14.5 14.5 9.5"/><path d="M11.5 6.8 13.2 5a4.2 4.2 0 0 1 6 6l-1.7 1.7"/><path d="M12.5 17.2 10.8 19a4.2 4.2 0 0 1-6-6l1.7-1.7"/>',
  external:  '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  chevronR:  '<path d="m9 5 7 7-7 7"/>',
  chevronL:  '<path d="m15 5-7 7 7 7"/>',
  chevronD:  '<path d="m5 9 7 7 7-7"/>',
  alert:     '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 9.5v4.5M12 17.2v.1"/>',
  clock:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user:      '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  upload:    '<path d="M12 20V9"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M4.5 4.5h15"/>',
  camera:    '<path d="M4 8.5h3l1.4-2h7.2l1.4 2h3v10H4z"/><circle cx="12" cy="13.2" r="3.2"/>',
  image:     '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3 3 2.5-2.5L20 18"/>',
  link:      '<path d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 1 1 5.6 5.6L16.6 13"/><path d="M14 10a4 4 0 0 1 0 5.6l-2.4 2.4a4 4 0 1 1-5.6-5.6L7.4 11"/>',
  share:     '<path d="M12 15V4"/><path d="m8 7.5 4-3.5 4 3.5"/><path d="M5 13v6.5h14V13"/>',
  send:      '<path d="M4 12 20 5l-6.5 15-2.8-6.2z"/>',
  megaphone: '<path d="M4 10.5v3l12 5V5.5z"/><path d="M16 8.5a3.5 3.5 0 0 1 0 7"/><path d="M7 14v5"/>',
  table:     '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5V19.5M3.5 14.5h17"/>',
  cloud:     '<path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.4A3.6 3.6 0 0 0 7 18z"/>',
  filter:    '<path d="M3.5 5.5h17l-6.6 7.6V20l-3.8-2.2v-5.7z"/>',
  key:       '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5"/><path d="m16.5 7 2 2"/><path d="m14 9.5 2 2"/>',
  copy:      '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 5.5H6a2 2 0 0 0-2 2v9.5"/>',
  save:      '<path d="M5 4h11l3 3v13H5z"/><path d="M8.5 4v5h7V4"/><rect x="8.5" y="13" width="7" height="7"/>',
  eye:       '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  arrowUp:   '<path d="M12 19V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m6.5 13.5 5.5 5.5 5.5-5.5"/>',
  more:      '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  refresh:   '<path d="M20 5.5v5h-5"/><path d="M19.4 13.5A7.5 7.5 0 1 1 17 7.2L20 10"/>',
  target:    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  note:      '<path d="M5 4.5h9l5 5v10H5z"/><path d="M14 4.5v5h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>',
  mail:      '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.8 6.5 8.2 6 8.2-6"/>',
  phone:     '<path d="M6.5 3.5h3l1.5 4-2 1.5a10 10 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5z"/>',
  history:   '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 5.5V10H8"/><path d="M12 8v4.5l3 1.8"/>',
  settings:  '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.5 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.5 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.5 11a2 2 0 1 1 0 4z"/>',
  grid:      '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  sparkle:   '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5 10.2 12.6 4.5 10.8 10.2 9z"/><path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  flag:      '<path d="M5 21V4"/><path d="M5 5h11l-1.6 3.5L16 12H5z"/>',
  /* 旅團公開連結（IG／FB／網頁／WhatsApp —— 團員入口用） */
  instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1"/>',
  facebook:  '<path d="M14.5 21v-7h2.6l.5-3.2h-3.1V8.6c0-1 .3-1.7 1.8-1.7h1.4V4.1C17.2 4 16.2 4 15.3 4c-2.6 0-4.3 1.5-4.3 4.3v2.5H8.5V14h2.5v7"/>',
  globe:     '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.1-3.9-8.5s1.3-6.2 3.9-8.5z"/>',
  whatsapp:  '<path d="M12 3.8a8.2 8.2 0 0 0-7 12.4L4 20l3.9-1a8.2 8.2 0 1 0 4.1-15.2z"/><path d="M9.3 8.6c-.3 0-.7.1-.9.5-.3.5-.6 1.3.2 2.7.8 1.4 2 2.6 3.6 3.3 1.5.7 2.2.5 2.7.2.4-.2.6-.7.6-1 0-.2-.1-.3-.3-.4l-1.3-.7c-.2-.1-.4-.1-.6.1l-.5.6c-.1.2-.3.2-.5.1-.7-.3-1.5-.9-2.1-1.7-.1-.2-.1-.4.1-.5l.4-.5c.2-.2.1-.4 0-.6l-.7-1.3c-.1-.2-.3-.3-.7-.3z"/>',
};
export function icon(name, size = 18, cls = '') {
  const d = P[name] || P.grid;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

/* ---------- toast ---------- */
let toastHost;
function toastEl() {
  toastHost = toastHost || (() => {
    const el = document.createElement('div');
    el.id = 'toasts'; document.body.appendChild(el); return el;
  })();
  return toastHost;
}
function fadeOut(t, ms = 2600) {
  setTimeout(() => {
    t.style.transition = 'opacity .25s, transform .25s';
    t.style.opacity = '0'; t.style.transform = 'translateY(10px)';
    setTimeout(() => t.remove(), 260);
  }, ms);
}
export function toast(message, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = (kind === 'ok' ? icon('check', 15) : kind === 'err' ? icon('alert', 15) : '') + `<span>${esc(message)}</span>`;
  toastEl().appendChild(t);
  fadeOut(t);
}
/** 有按鈕嘅 toast（例：刪除之後「還原」） */
export function toastAction(message, actionLabel, onAction, kind = '', ms = 6500) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = (kind === 'ok' ? icon('check', 15) : kind === 'err' ? icon('alert', 15) : icon('history', 15))
    + `<span>${esc(message)}</span><button class="toast-act" type="button">${esc(actionLabel)}</button>`;
  toastEl().appendChild(t);
  let done = false;
  t.querySelector('.toast-act').addEventListener('click', () => {
    if (done) return;
    done = true;
    try { onAction?.(); } catch (e) { console.error(e); }
    t.remove();
  });
  fadeOut(t, ms);
  return t;
}

/* ---------- modal ---------- */
let openModals = [];
export function closeModal(value) {
  const m = openModals.pop();
  if (m) { m.el.remove(); m.resolve(value); }
}
export function modal({ title, sub = '', body = '', actions = [], wide = false, onMount = null }) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <div class="modal-title">${esc(title)}</div>
            ${sub ? `<div class="modal-sub">${sub}</div>` : ''}
          </div>
          <button class="btn btn-ghost btn-icon btn-sm" data-close-x aria-label="關閉">${icon('x', 18)}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${actions.length ? `<div class="modal-foot">${actions.map((a, i) =>
          `<button class="btn ${a.class || ''}" data-act="${i}" ${a.disabled ? 'disabled' : ''}>${a.label}</button>`).join('')}</div>` : ''}
      </div>`;
    document.body.appendChild(el);
    const rec = { el, resolve };
    openModals.push(rec);

    el.addEventListener('click', e => {
      if (e.target === el) { closeModal(null); return; }
      if (e.target.closest('[data-close-x]')) { closeModal(null); return; }
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const a = actions[Number(btn.dataset.act)];
        if (!a || a.disabled) return;
        const out = a.onClick ? a.onClick(el) : undefined;
        if (out !== false) closeModal(out === undefined ? (a.value ?? true) : out);
      }
    });
    const closeBtn = el.querySelector('[data-close-x]');
    if (closeBtn) closeBtn.onclick = () => closeModal(null);

    if (typeof onMount === 'function') {
      try { onMount(el, v => closeModal(v)); } catch (err) { console.error(err); }
    }
    const first = el.querySelector('input,textarea,select,button.btn-primary');
    if (first && window.innerWidth > 560) setTimeout(() => first.focus(), 60);
  });
}
export function confirmDlg({ title = '確認', message = '', okText = '確認', cancelText = '取消', danger = false }) {
  return modal({
    title, body: `<p style="font-size:14.5px;line-height:1.7">${message}</p>`,
    actions: [
      { label: cancelText, class: 'btn', value: false },
      { label: okText, class: danger ? 'btn-accent' : 'btn-primary', value: true }
    ]
  });
}

/* ---------- QR code ---------- */
export function qrSvg(text, cell = 5, margin = 2) {
  if (typeof window.qrcode !== 'function') return '<div class="faint sm">QR 模組未載入</div>';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag(cell, margin);
  } catch (e) {
    console.error(e);
    return '<div class="faint sm">QR 產生失敗（內容可能過長）</div>';
  }
}

/**
 * QR 圖（GIF data URL）—— 可以直接放 <img>、儲存落手機、貼落 WhatsApp 做圖
 * 同 qrSvg() 用同一個編碼器（assets/vendor/qrcode.js，離線可用）
 */
export function qrDataUrl(text, cell = 8, margin = 3) {
  if (typeof window.qrcode !== 'function') return '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createDataURL(cell, margin);
  } catch (e) {
    console.error(e);
    return '';
  }
}

/** 用 <img> 顯示 QR（拿唔到 data URL 就退回 SVG） */
export function qrImg(text, px = 190, cell = 8, margin = 3) {
  const d = qrDataUrl(text, cell, margin);
  if (!d) return qrSvg(text, 5, 2);
  return `<img src="${d}" width="${px}" height="${px}" alt="QR Code" style="display:block;margin:0 auto;max-width:100%">`;
}

/* ---------- misc ---------- */
export function groupBy(list, keyFn) {
  return list.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}
export function sortBy(list, keyFn, dir = 1) {
  return [...list].sort((a, b) => {
    const x = keyFn(a), y = keyFn(b);
    if (x === y) return 0;
    return (x > y ? 1 : -1) * dir;
  });
}
export function num(v) { return Number(String(v ?? '').replace(/[^0-9.\-]/g, '')) || 0; }

/* ---------- 小元件 ---------- */
export function badge(label, cls = 'b-grey', dot = false) {
  return `<span class="badge ${cls}">${dot ? '<span class="dot"></span>' : ''}${esc(label)}</span>`;
}
export function nf(n, digits = 0) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function pct(part, whole) {
  const w = Number(whole) || 0;
  return w ? Math.round((Number(part) || 0) / w * 100) : 0;
}
/** 純文字（用嚟做 CSV／剪貼） */
export function plain(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '');
}
/** 由元素下載 SVG（QR 等） */
export function downloadSvgEl(el, filename = 'qrcode.svg') {
  if (!el) return false;
  const svg = el.querySelector('svg') || el;
  const text = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(svg);
  download(filename, text, 'image/svg+xml;charset=utf-8');
  return true;
}

/* ---------- 相片檢視（lightbox） ---------- */
export function photoViewer(photos, index = 0) {
  const list = (photos || []).filter(p => p?.dataUrl);
  if (!list.length) return;
  let i = Math.max(0, Math.min(index, list.length - 1));
  const el = document.createElement('div');
  el.className = 'overlay lightbox';
  const paint = () => {
    const p = list[i];
    el.innerHTML = `
      <div class="lb-box">
        <div class="lb-head">
          <div class="sm">${esc(p.name || '')} <span class="faint">（${i + 1} / ${list.length}）</span></div>
          <div class="row gap-6">
            <button class="btn btn-xs" data-act="dl">${icon('download', 13)} 下載</button>
            <button class="btn btn-xs btn-ghost" data-act="close">${icon('x', 16)}</button>
          </div>
        </div>
        <div class="lb-body">
          ${list.length > 1 ? `<button class="lb-nav" data-act="prev">${icon('chevronL', 22)}</button>` : ''}
          <img src="${p.dataUrl}" alt="${esc(p.name || '')}">
          ${list.length > 1 ? `<button class="lb-nav right" data-act="next">${icon('chevronR', 22)}</button>` : ''}
        </div>
      </div>`;
  };
  paint();
  const close = () => el.remove();
  el.addEventListener('click', e => {
    if (e.target === el) return close();
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'close') close();
    if (a === 'prev') { i = (i - 1 + list.length) % list.length; paint(); }
    if (a === 'next') { i = (i + 1) % list.length; paint(); }
    if (a === 'dl') {
      const p = list[i];
      const link = document.createElement('a');
      link.href = p.dataUrl; link.download = p.name || 'photo.jpg';
      document.body.appendChild(link); link.click(); link.remove();
    }
  });
  document.body.appendChild(el);
}
