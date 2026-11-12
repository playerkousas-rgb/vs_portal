/* ============================================================
   accounts.js — 系統（旅團設定、操作紀錄）
   ------------------------------------------------------------
   ★ 2026-09-24 團長定案：
     ① 側邊欄「**身份與系統**」改名做「**系統**」
     ② 入面嘅「**身份與帳號**」分頁成個搬去「**用戶與身份**」
        （#/members/accounts，見 views/members-accounts.js）
     所以呢一頁淨係剩返：**旅團設定 / 操作紀錄**。
   ★ 2026-11-12：「資料管理」唔再係呢頁嘅分頁 —— 佢本來主要係指路中轉頁，
     而家直接係側欄一個入口（#/tables），唔使兜兩層。
   規則（依實際需要）：
     超管：可改領袖、執委任何帳戶密碼，可開／刪帳戶
     領袖：可改自己同執委帳戶密碼，可開／刪執委帳戶
     執委：只可以改自己密碼
   超管帳戶：唔會出現在任何名單，任何人都唔可以改佢密碼。
   ============================================================ */

import { load, commit, add, audit, currentUnit, switchUnit } from '../lib/store.js';
import { ROLES, accounts, can, changeOwnPassword, currentRole, isSuper, displayName } from '../lib/auth.js';
import { profile, settings, members } from '../lib/model.js';
import * as fiscalLib from '../lib/fiscal.js';
import { unitList, isLocalUnit, saveLocalUnit, removeLocalUnit, loadRegistry, registry } from '../lib/units.js';
import { envUnitTemplate } from '../lib/onboard.js';
import { esc, icon, modal, confirmDlg, toast, copyText } from '../lib/util.js';
import { go } from '../lib/router.js';
import { pageHead, tabs, empty, kv, stat, noteBox } from './ui.js';
import { renderPublicLinksEditor, mountPublicLinksEditor } from './public-links-editor.js';

let tab = 'unit';

export function title() { return '系統'; }

/** 舊「團員睇到嘅公開連結」6 個槽已經自動搬入公開資料 —— 話聲領袖知 */
function legacyTroopLinksNote() {
  const L = settings()?.troopLinks || {};
  const n = Object.values(L).filter(v => String(v || '').trim()).length;
  if (!n) return '';
  return noteBox(`<b>舊嗰 ${n} 條「團員睇到嘅公開連結」已經自動搬咗落下面。</b>
    以後統一喺「公開資料」一欄度改（每一項仲可以設「邊個睇到」）。
    去<b>側邊欄「公開資料」</b>可以一眼睇晒而家公開緊啲乜。`);
}

export function render(params) {
  /* ★ 2026-09-24 團長：
     ①「權限總表」早已搬去「用戶與身份」（#/members/perms）
     ②「身份與帳號」都搬埋去「用戶與身份」（#/members/accounts，見 views/members-accounts.js）
     → 呢一頁（「系統」）淨係剩返 旅團設定／操作紀錄 兩樣。
     舊連結 #/admin/accounts 會喺 main.js 自動導去 #/members/accounts。 */
  /* ★ 2026-11-12：「資料管理」分頁已刪 —— 佢主要係指路中轉頁（3 張卡叫你去
     #/tables 嗰 3 個分頁），而 tables 本身已經有嗰 3 個分頁 = 兜圈。
     舊連結 #/admin/data 由 main.js 自動導去 #/tables。 */
  if (['unit', 'audit'].includes(params.id)) tab = params.id;
  else if (tab === 'data') tab = 'unit';
  return `
  ${pageHead({
    title: '系統',
    /* 副標題只留動態身份；分頁名唔再重複讀一次，教學已搬去頂欄（唔再重複一粒掣） */
    sub: `${displayName()}（${ROLES[currentRole()]?.name || ''}）`
  })}
  ${tabs([
    ['unit', '旅團設定'],
    ['audit', '操作紀錄']
  ], tab)}
  ${tab === 'audit' ? auditView() : unitView()}`;
}

/* ============================================================
   旅團設定
   ============================================================ */
function unitView() {
  const p = profile();
  const units = unitList();
  const s = settings();
  return `
  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">本旅團資料</div>
          <div class="card-sub">會顯示喺團章、輸出文件嘅抬頭</div></div></div>
        <div style="padding:18px">
          <div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">旅團編號</label><input class="input" id="u-code" value="${esc(p.code || currentUnit())}" ${can('admin.units') ? '' : 'disabled'}></div>
            <div class="field"><label class="label">簡稱</label><input class="input" id="u-short" value="${esc(p.short || '')}"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">名稱（中）</label><input class="input" id="u-name" value="${esc(p.name || '')}"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">名稱（English）</label><input class="input" id="u-nameen" value="${esc(p.nameEn || '')}"></div>
            <div class="field"><label class="label">地域</label><input class="input" id="u-region" value="${esc(p.region || '')}"></div>
            <div class="field"><label class="label">主辦機構</label><input class="input" id="u-sponsor" value="${esc(p.sponsor || '')}"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">團址</label><input class="input" id="u-address" value="${esc(p.address || '')}"></div>
            <div class="field"><label class="label">主色（棗紅）</label><input class="input" id="u-color" value="${esc(p.theme?.brand700 || '#7B2233')}"></div>
            <div class="field"><label class="label">年度團費</label><input class="input" id="u-fee" type="number" value="${s.feePerYear || 360}"></div>
            <div class="field"><label class="label">公開網址基底（可選）</label><input class="input" id="u-public" value="${esc(s.publicBaseUrl || '')}" placeholder="https://…/constitution.html?u={u}"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">單據相片 Drive 資料夾（同「財務 → 設定」同步）</label>
              <input class="input" id="u-receipt" value="${esc(s.receiptDrive || '')}" placeholder="https://drive.google.com/drive/folders/…">
              <div class="hint mt-4">申報相片會存入呢個資料夾（唔係上面「團員睇到嘅公開連結」嗰個旅團 Drive —— 兩樣嘢）。留空＝用後端預設。</div></div>
          </div>
          <div id="u-err" class="err mt-8"></div>
          <button class="btn btn-primary mt-16" data-act="save-unit" ${can('admin.units') ? '' : 'disabled'}>${icon('save', 16)} 儲存旅團資料</button>
        </div>
      </div>

      ${legacyTroopLinksNote()}

      <div class="card">
        <div class="card-head"><div><div class="card-title">公開資料（填嘢嘅位）</div>
          <div class="card-sub">旅團網站、關於我團、社交媒體、相簿、其他連結 —— 每項可以設「邊個睇到」</div></div>
          <button class="btn btn-sm" data-go="#/links">${icon('globe', 14)} 去睇一覽表</button></div>
        <div style="padding:16px 18px">
          ${renderPublicLinksEditor()}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">交換旅團（多旅團平台）</div>
          <div class="card-sub">每個旅團有自己嘅資料空間，互不影響</div></div>
          <button class="btn btn-xs" data-act="reload-registry">${icon('refresh', 13)} 重新載入 Registry</button></div>
        <div>
          ${units.map(u => `
            <div class="list-item">
              <span class="stat-ic">${icon('flag', 16)}</span>
              <div class="li-main">
                <div class="li-t">${esc(u.name || u.code)} ${u.code === currentUnit() ? '<span class="tag">目前</span>' : ''} ${u.local ? '<span class="tag">本地</span>' : ''}</div>
                <div class="li-s mono">${esc(u.code)}${u.dataPath ? ` · ${esc(u.dataPath)}` : ' · （本地旅團，冇資料檔）'}</div>
              </div>
              ${u.code === currentUnit() ? '' : `<button class="btn btn-xs btn-primary" data-switch="${esc(u.code)}">切換</button>`}
              ${isLocalUnit(u.code) ? `<button class="btn btn-xs btn-ghost" data-rmunit="${esc(u.code)}">${icon('trash', 13)}</button>` : ''}
            </div>`).join('')}
        </div>
        <div style="padding:14px 16px;border-top:1px solid var(--line-2)">
          ${isSuper()
            ? `${noteBox('<b>想開新旅團？</b>（只限超級管理員）最快嘅方法 B：喺 Vercel 加 5 個 '
                + '<code>TROOP_&lt;編號&gt;_*</code> 環境變數 → Redeploy，唔使改 Git。'
                + '（方法 A：喺 <code>data/units.json</code> ＋ <code>data/units/&lt;編號&gt;/</code> 加檔案，可以預載資料。）', 'info')}
              <div class="row gap-8 wrap mt-12">
                <button class="btn btn-sm btn-primary" data-go="#/docs/newunit">${icon('note', 15)} 開新旅團逐步教學（含變數範本）</button>
                <button class="btn btn-sm" data-act="env-template">${icon('copy', 15)} 即刻產生環境變數</button>
              </div>`
            : ''}
          <button class="btn btn-sm btn-block mt-12" data-act="add-local-unit">${icon('plus', 15)} 新增本地旅團（測試用，只存呢部機）</button>
        </div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">資料來源</div></div>
        <div style="padding:16px 18px">
          ${kv([
            ['目前旅團', esc(currentUnit())],
            ['資料檔', `<span class="mono xs">${esc(load().meta?.seedSource || '')}</span>`],
            ['儲存位置', `<span class="mono xs">venture82.unit.${esc(currentUnit())}.db.v2</span>`],
            ['更新時間', esc(load().meta?.updatedAt || '')]
          ])}
        </div>
      </div>
    </div>
  </div>`;
}

function auditView() {
  /* ★ 2026-09-24 團長：「操作紀錄不顯示超級管理員的紀錄」。
     超管係平台層（品牌通行帳號），唔屬於旅團團務 —— 佢嘅操作唔應該出現喺旅團嘅紀錄入面。
     舊紀錄冇 role 欄，就用操作者名兜底（超管帳號固定叫 sheep）。 */
  const logs = (load().auditLog || []).filter(l => l?.role !== 'super' && String(l?.by || '').toLowerCase() !== 'sheep');
  const hidden = (load().auditLog || []).length - logs.length;
  return `
  <div class="card">
    <div class="card-head"><div><div class="card-title">操作紀錄</div>
      <div class="card-sub">登入、改密碼、發布團章等都會記錄（最多 400 條）${hidden ? ` · 已隱去 ${hidden} 條平台管理員紀錄` : ''}</div></div></div>
    ${logs.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th style="width:150px">時間</th><th>動作</th><th>詳情</th><th>操作者</th></tr></thead>
      <tbody>${logs.map(l => `<tr>
        <td class="mono sm">${esc(l.at)}</td><td class="sm semibold">${esc(l.action)}</td>
        <td class="sm muted">${esc(l.detail || '')}</td><td class="sm mono">${esc(l.by || '')}</td></tr>`).join('')}</tbody>
    </table></div>` : empty('history', '未有紀錄')}
  </div>`;
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));

  /* 公開資料**填嘢嘅位**（社交媒體／相簿／網站／關於我團／其他連結）。
     ★ 團長 2026-09-24：「公開資料其實唔係要填嘢嘅，係方便了解有乜嘢而家正喺度公開」
     —— 所以填嘢放喺「旅團設定」，睇嘢（只讀一覽表）喺側邊欄「公開資料」。 */
  mountPublicLinksEditor(root);

  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;

    /* --- 旅團 --- */
    if (act === 'save-unit') {
      const v = k => root.querySelector(k)?.value.trim() || '';
      const p = profile();
      p.code = v('#u-code') || p.code;
      p.short = v('#u-short'); p.name = v('#u-name'); p.nameEn = v('#u-nameen');
      p.region = v('#u-region'); p.sponsor = v('#u-sponsor'); p.address = v('#u-address');
      p.theme = { ...(p.theme || {}), brand700: v('#u-color') };
      const db = load();
      db.unit = p;
      db.settings = { ...db.settings, feePerYear: Number(v('#u-fee')) || 360, publicBaseUrl: v('#u-public'), receiptDrive: v('#u-receipt').trim() };
      /* 年度團費：同時寫入逐年 map（本年度）—— 財務「設定」頁逐年度表用同一份 */
      try {
        const { scoutFYLabel } = fiscalLib;
        const fy = scoutFYLabel(new Date().toISOString().slice(0, 10), Number(db.settings.scoutFYStartMonth) || 4);
        db.settings.feePerYearMap = { ...(db.settings.feePerYearMap || {}), [fy]: Number(v('#u-fee')) || 360 };
      } catch { /* 年度 tag 計唔到都唔阻住儲存 */ }
      commit();
      toast('已儲存旅團資料', 'ok'); refresh(); return;
    }
    if (act === 'env-template') {
      if (!isSuper()) { toast('只有超級管理員可以開新旅團（要改 Vercel 設定）', 'err'); return; }
      const r = await modal({
        title: '產生環境變數（開新旅團）', sub: '方法 B：唔使改 Git，貼落 Vercel 就得',
        body: `<div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">旅團編號</label><input class="input" id="q-code" placeholder="0081"></div>
            <div class="field"><label class="label">旅團名稱</label><input class="input" id="q-name" placeholder="第八十一旅深資童軍團"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">/exec 網址</label><input class="input" id="q-exec" placeholder="https://script.google.com/macros/s/AKfy…/exec"></div>
            <div class="field" style="grid-column:1/-1"><label class="label">API Key</label><input class="input" id="q-key" placeholder="showApiKey() 複製嘅字串"></div>
          </div>
          <pre class="code mt-12" id="q-out">${esc(envUnitTemplate('0081'))}</pre>
          <div class="hint">貼落 Vercel → Settings → Environment Variables；之後要 <b>Redeploy</b> 先生效。</div>`,
        actions: [{ label: '關閉', class: 'btn', value: null },
          { label: '複製環境變數', class: 'btn-primary', onClick: async el => {
            const v = k => el.querySelector(k)?.value.trim() || '';
            const txt = envUnitTemplate(v('#q-code') || '0081', v('#q-name'), v('#q-exec'), v('#q-key'));
            const ok = await copyText(txt);
            toast(ok ? '已複製 —— 貼落 Vercel 環境變數' : '複製失敗，請手動選取', ok ? 'ok' : 'err');
            return false;   /* 唔關窗，方便再改 */
          } }]
      });
      void r; return;
    }
    if (act === 'reload-registry') {
      await loadRegistry(true);
      toast('已重新載入旅團 Registry', 'ok'); refresh(); return;
    }
    if (act === 'add-local-unit') {
      const r = await modal({
        title: '新增本地旅團（測試用）', sub: '只存喺呢部機，唔會寫入 data/ 檔案',
        body: `<div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">旅團編號</label><input class="input" id="q-code" placeholder="例：0099"></div>
            <div class="field"><label class="label">名稱</label><input class="input" id="q-name" placeholder="例：第 99 旅深資童軍團"></div>
          </div>`,
        actions: [{ label: '取消', class: 'btn', value: null },
          { label: '新增', class: 'btn-primary', onClick: el => ({
            code: el.querySelector('#q-code').value.trim(), name: el.querySelector('#q-name').value.trim()
          }) }]
      });
      if (!r?.code) return;
      saveLocalUnit({ code: r.code, name: r.name || r.code, local: true });
      audit('新增本地旅團', r.code);
      toast('已新增，切換後即可使用', 'ok'); refresh(); return;
    }


  }));

  root.querySelectorAll('[data-switch]').forEach(b => b.addEventListener('click', () => switchUnit(b.dataset.switch)));
  root.querySelectorAll('[data-rmunit]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '移除本地旅團', danger: true, okText: '確定移除', message: '只會移除清單項目，資料庫仍會留喺本機。' })) {
      removeLocalUnit(b.dataset.rmunit); toast('已移除', 'ok'); refresh();
    }
  }));
}

/* ---------- 彈窗表單 ---------- */
/* ★ 2026-11-12：頂欄「改密碼」掣直接開呢個彈窗。
   本來 main.js 係 go('#/admin/data')（指去資料管理頁，根本冇密碼表單），
   而家「系統」對執委封閉，如果唔改就會連自己密碼都改唔到。 */
export async function ownPasswordForm() {
  const r = await modal({
    title: '更改我嘅密碼',
    body: `<div class="field"><label class="label">目前密碼 <span class="req">*</span></label>
        <input class="input" id="q-old" type="password"></div>
      <div class="field mt-12"><label class="label">新密碼 <span class="req">*</span></label>
        <input class="input" id="q-p1" type="text"></div>
      <div class="field mt-12"><label class="label">再輸入一次 <span class="req">*</span></label>
        <input class="input" id="q-p2" type="text"></div>
      <div id="q-err" class="err mt-8"></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '更改', class: 'btn-primary', onClick: el => {
        const old = el.querySelector('#q-old').value, p1 = el.querySelector('#q-p1').value, p2 = el.querySelector('#q-p2').value;
        const err = el.querySelector('#q-err');
        if (!old) { err.textContent = '請輸入目前密碼'; err.style.display = 'block'; return false; }
        if (p1.length < 4) { err.textContent = '新密碼至少 4 個字元'; err.style.display = 'block'; return false; }
        if (p1 !== p2) { err.textContent = '兩次輸入唔一樣'; err.style.display = 'block'; return false; }
        return { old, p1 };
      } }]
  });
  if (!r) return;
  const res = await changeOwnPassword(r.old, r.p1);
  if (!res.ok) return toast(res.msg, 'err');
  toast('密碼已更改', 'ok');
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
