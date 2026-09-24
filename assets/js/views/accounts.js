/* ============================================================
   accounts.js — 帳號、密碼、權限、資料、旅團設定、示範資料
   規則（依實際需要）：
     超管：可改領袖、執委任何帳戶密碼，可開／刪帳戶
     領袖：可改自己同執委帳戶密碼，可開／刪執委帳戶
     執委：只可以改自己密碼
   超管帳戶：唔會出現在任何名單，任何人都唔可以改佢密碼。
   ============================================================ */

import { load, commit, collection, add, update, remove, exportAll, importAll, resetToSeed, wipe, audit, currentUnit, switchUnit, setUnitCode } from '../lib/store.js';
import {
  ROLES, accounts, accountById, can, canChangePasswordOf, canManageRole,
  createAccount, createAccountServer, changePassword, changeUsername, changeOwnPassword, setAccountActive, deleteAccount, deleteAccountServer, resetAccountPasswordServer, restoreAccountServer,
  current, currentRole, isSuper, isMe, displayName, RESERVED_USERNAMES, TEMP_PASSWORD,
  setMemberIdentity, setMemberHubPassword, canClaimChief, claimChief, openMemberAccount
} from '../lib/auth.js';
import { loginIdOf } from '../lib/model.js';
import { profile, settings, members, memberName, money, balance, tx, invItems, chief, identityOf, identityLabel, IDENTITIES, activeMembers } from '../lib/model.js';
import * as fiscalLib from '../lib/fiscal.js';
import { unitList, unitEntry, isLocalUnit, saveLocalUnit, removeLocalUnit, loadRegistry, registry } from '../lib/units.js';
import { envUnitTemplate } from '../lib/onboard.js';
import { esc, icon, modal, confirmDlg, toast, download, copyText, fmtDate, avatar, todayISO } from '../lib/util.js';
import { download as dlFile, toCSV, stamp } from '../lib/exporter.js';
import { go } from '../lib/router.js';
import { pageHead, tabs, empty, kv, stat, noteBox } from './ui.js';

let tab = 'accounts';

export function title() { return '帳號與系統'; }

const PASSWORD_RULES = [
  ['超級管理員（隱藏）', '可以改任何人嘅密碼。', '超管自己嘅密碼係固定嘅，冇人可以改。'],
  ['團長（每團一位）', '可以改自己、領袖、執委、團員嘅密碼；可以設定／轉移身份。', '唔可以改超管密碼；團長身份只可以轉移，唔可以直接改低。'],
  ['領袖', '可以改自己嘅密碼，亦可以改執委／團員嘅密碼；可以改身份（團長除外）。', '唔可以改其他領袖或團長嘅密碼。'],
  ['執委', '只可以改自己嘅密碼，可以改資料。', '唔可以改身份（＝唔可以改權限）。'],
  ['團員', '只可以改自己嘅密碼。', '只入團員入口（members.html）。']
];

export function render(params) {
  /* ★ 2026-09-24 團長：「權限總表由身份與帳號 移去 用戶與身份」→ 呢度唔再有 perms 分頁 */
  if (['accounts', 'data', 'unit', 'audit'].includes(params.id)) tab = params.id;
  return `
  ${pageHead({
    title: '帳號與系統',
    sub: `${profile().name || ''} · 目前身份：${displayName()}（${ROLES[currentRole()]?.name || ''}）· 一個人一個帳號（冇共用帳戶）`,
    actions: `${can('docs.view') ? `<button class="btn btn-sm" data-go="#/docs">${icon('note', 15)} 教學</button>` : ''}`
  })}
  ${tabs([
    ['accounts', '身份與帳號', activeMembers().length],
    ['unit', '旅團設定'],
    ['data', '資料管理'],
    ['audit', '操作紀錄']
  ], tab)}
  ${tab === 'unit' ? unitView()
    : tab === 'data' ? dataView()
    : tab === 'audit' ? auditView()
    : accountsView()}`;
}

/* ============================================================
   帳戶
   ============================================================ */
function accountsView() {
  const list = accounts();                     // 舊版個人帳戶（向下兼容）
  const all = activeMembers();
  const cnt = k => all.filter(m => identityOf(m) === k).length;
  const c = chief();
  const rows = ['chief', 'leader', 'exco', 'member'].map(k => `
      <div class="card">
        <div class="card-head">
          <div class="row gap-10">
            <span class="avatar" style="background:${ROLES[k].color}">${icon(k === 'chief' ? 'sparkle' : k === 'leader' ? 'flag' : 'users', 17)}</span>
            <div><div class="card-title">${ROLES[k].name}${k === 'chief' ? '（每團一位）' : ''}</div>
              <div class="card-sub">${ROLES[k].desc}</div></div>
          </div>
          ${k === 'chief' && !c && canClaimChief() ? `<button class="btn btn-xs btn-primary" data-act="claim-chief">${icon('sparkle', 13)} 認領</button>` : ''}
          ${k !== 'chief' && can('member.create') ? `<button class="btn btn-xs" data-go="#/members/new">${icon('plus', 13)} 新增</button>` : ''}
        </div>
        <div>
          ${all.filter(m => identityOf(m) === k).map(m => personRow(m)).join('') || empty('users', k === 'chief' ? '仲未設定團長（開戶嗰個就係團長）' : '未有人')}
        </div>
      </div>`).join('');

  return `
  <div class="grid g-4 mb-16">
    ${stat('團長', String(cnt('chief')), c ? c.name : '未設定')}
    ${stat('領袖', String(cnt('leader')), '電郵登入')}
    ${stat('執委', String(cnt('exco')), 'YMIS 登入')}
    ${stat('團員', String(cnt('member')), '入團員入口')}
  </div>

  ${noteBox(`<b>身份即帳號（2026-09-24 定案）：</b>唔會再有「領袖共用帳戶」或者「執行委員會帳號」——
    每個人都係名冊入面嘅<b>一條紀錄</b>，登入代號係佢自己嘅<b>電郵 / 自訂帳號 / YMIS</b>，
    密碼就係佢自己嗰個。要換權限＝去「用戶與身份」改<b>身份</b>（換屆唔使開新帳戶、唔使夾密碼）。
    <br>團長：每個旅團<b>永遠只有一位</b>，最高權限，可以轉移。`, 'brand')}
  <div class="mt-16"></div>

  ${!c && canClaimChief() ? `<div class="note-box warn mb-16">${icon('alert', 15)}<div>
    <b>仲未設定團長</b> —— 第一個設定嘅人（開戶嗰位）就係團長，之後可以轉移。
    <button class="btn btn-sm btn-primary mt-8" data-act="claim-chief">${icon('sparkle', 14)} 我係團長（認領身份）</button>
  </div></div>` : ''}

  <div class="grid g-2 mb-16">${rows}</div>

  ${list.length && can('admin.accounts') ? `<div class="card mb-16">
    <div class="card-head"><div><div class="card-title">舊版個人帳戶（向下兼容）</div>
      <div class="card-sub">2026-09-24 之前開落嘅帳戶。新做法唔會再開呢種帳戶 —— 改身份就得。</div></div></div>
    <div>${list.map(a => accountRow(a)).join('')}</div>
  </div>` : ''}

  <div class="card">
    <div class="card-head"><div><div class="card-title">密碼規則</div>
      <div class="card-sub">系統照以下規則執行，唔可以繞過</div></div></div>
    <div class="scroll-x">
      <table class="table table-compact">
        <thead><tr><th style="width:150px">身份</th><th>可以改邊個嘅密碼</th><th>限制</th></tr></thead>
        <tbody>${PASSWORD_RULES.map(([who, canDo, limit]) => `<tr>
          <td class="semibold">${esc(who)}</td><td class="sm">${esc(canDo)}</td><td class="sm muted">${esc(limit)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/** 名冊入面一個人嘅一行（帳號／身份管理用） */
function personRow(m) {
  const ident = identityOf(m);
  const accId = 'member:' + m.id;
  const editable = canChangePasswordOf(accId);
  const me = current()?.memberId === m.id;
  const login = loginIdOf(m);
  return `
  <div class="list-item">
    <span class="avatar avatar-sm" style="background:${ROLES[ident]?.color || '#7B2233'}">${esc(String(m.name || '').slice(-2))}</span>
    <div class="li-main">
      <div class="li-t">${esc(m.name)} ${me ? '<span class="tag">你</span>' : ''}${m.role ? ` <span class="xs faint">${esc(m.role)}</span>` : ''}</div>
      <div class="li-s">登入 <b class="mono">${esc(login || '（未設定 —— 去「編輯」填電郵／YMIS）')}</b>
        ${m.hubPw?.hash || m.hubPassword ? '' : ' · <span class="tag">未設密碼（首次 1234）</span>'}
        ${m.hubPwUpdatedAt ? ` · ${esc(m.hubPwUpdatedAt)} 改過密碼` : ''}</div>
    </div>
    <div class="row gap-4">
      ${editable ? `<button class="btn btn-xs" data-mpw="${m.id}">${icon('key', 13)} 密碼</button>` : ''}
      ${can('member.edit') ? `<button class="btn btn-xs btn-ghost" data-medit="${m.id}" title="編輯 / 改身份">${icon('edit', 13)}</button>` : ''}
      ${can('admin.chief') && ident !== 'chief' ? `<button class="btn btn-xs btn-ghost" data-mchief="${m.id}" title="設為團長（轉移）">${icon('sparkle', 13)}</button>` : ''}
    </div>
  </div>`;
}

function accountRow(a) {
  const editable = canChangePasswordOf(a.id);
  const me = isMe(a.id);
  return `
  <div class="list-item">
    <span class="avatar avatar-sm" style="background:${ROLES[a.role]?.color || '#7B2233'}">${esc(a.name.slice(-2))}</span>
    <div class="li-main">
      <div class="li-t">${esc(a.name)} ${me ? '<span class="tag">你</span>' : ''} ${a.active === false ? '<span class="tag" style="background:var(--danger-bg);color:var(--danger)">已停用</span>' : ''}</div>
      <div class="li-s">登入 <b class="mono">${esc(a.email || a.username)}</b>${a.title ? ` · ${esc(a.title)}` : ''}${a.memberId ? ` · 對應 ${esc(memberName(a.memberId))}` : ''}
        ${a.mustChangePw || a.defaultPw ? ` · <span class="tag">要改密碼</span>` : ''}${a.pwUpdatedAt ? ` · ${esc(a.pwUpdatedAt)} 改過密碼` : ''}</div>
    </div>
    <div class="row gap-4">
      ${editable ? `<button class="btn btn-xs" data-pw="${a.id}">${icon('key', 13)} 密碼</button>
        <button class="btn btn-xs btn-ghost" data-uname="${a.id}">${icon('user', 13)}</button>` : `<span class="xs faint">冇權限</span>`}
      ${canManageRole(a.role) && !me ? `
        <button class="btn btn-xs btn-ghost" data-toggle="${a.id}">${a.active === false ? '啟用' : '停用'}</button>
        <button class="btn btn-xs btn-ghost" data-del="${a.id}">${icon('trash', 13)}</button>` : ''}
    </div>
  </div>`;
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

      <div class="card">
        <div class="card-head"><div><div class="card-title">團員睇到嘅公開連結</div>
          <div class="card-sub">團員用 YMIS＋密碼入入口之後先見到（Drive、相簿、IG、FB、網頁）</div></div></div>
        <div style="padding:18px">
          ${[['drive', 'Google Drive'], ['album', '相簿'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['website', '網頁'], ['whatsapp', 'WhatsApp']].map(([k, l]) => `
            <div class="field mt-8"><label class="label">${esc(l)}</label>
              <input class="input" id="tl-${k}" value="${esc((s.troopLinks || {})[k] || '')}" placeholder="https://…"></div>`).join('')}
          <button class="btn btn-primary mt-16" data-act="save-links">${icon('save', 16)} 儲存公開連結</button>
          <div class="hint mt-8">留空就唔顯示嗰項。連結只喺團員登入後出現，外人掃 QR 未入密碼睇唔到。</div>
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

/* ============================================================
   資料管理
   ============================================================ */
/* ★ 2026-09-24 團長：「資料管理 只須要三樣嘢」
   ① 插入自己嘅 Sheet　② 總表同步　③ 儲存與備份
   其餘嘅嘢（重設、統計、改密碼、備份提醒）已經收埋或者搬走 ——
   呢一頁唔應該再係一個百寶袋。 */
function dataView() {
  const db = load();
  const s = db.sync || {};
  const pendAcc = s.pendingAccounts || 0;
  const wired = !!db.backend?.url;
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  return `
  <div class="note-box mb-16">${icon('cloud', 15)}<div>
    <b>呢一頁淨係三樣嘢。</b>設定一次之後，全團用同一套 —— 唔使每人自己set。
    <div class="xs mt-4">① <b>插入自己嘅 Sheet</b>＝把舊 Google Sheet 嘅資料搬入嚟　
      ② <b>總表同步</b>＝接駁後端（Apps Script）　
      ③ <b>儲存與備份</b>＝匯出／匯入 JSON</div>
    ${wired ? '' : '<div class="xs mt-4" style="color:var(--warn)">⚠ 未接駁後端 —— 資料而家只存喺呢部機嘅瀏覽器。</div>'}
  </div></div>

  <div class="grid g-3">
    <div class="card">
      <div class="card-head"><div><div class="card-title">① 插入自己嘅 Sheet</div>
        <div class="card-sub">把旅團現有嘅 Google Sheet 搬入嚟</div></div></div>
      <div style="padding:16px 18px" class="col gap-10">
        <p class="sm muted">貼上你嘅 Sheet 連結，揀邊個工作表對邊個表（團員／帳目／物資…），
          系統會自動對應欄位。對應唔到嘅欄位會留空，唔會亂填。</p>
        <button class="btn btn-block btn-primary" data-go="#/tables/source">${icon('link', 16)} 打開「插入自己嘅 Sheet」</button>
        <div class="hint">只做一次。之後改欄位去各自分頁撳「<b>欄位</b>」掣。</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><div class="card-title">② 總表同步</div>
        <div class="card-sub">接駁 Google Sheet 後端（Apps Script）</div></div></div>
      <div style="padding:16px 18px" class="col gap-10">
        <p class="sm muted">資料真正嘅家。<b>寫入後端只有一條路</b>：頂部嗰粒「<b>儲存到後端</b>」。
          其他任何時候，改動都只係暫存喺呢部機。</p>
        <div class="kv-row sm"><span>後端</span><span>${wired ? `<span class="badge b-ok">已接駁</span>` : `<span class="badge b-warn">未接駁</span>`}</span></div>
        <div class="kv-row sm"><span>未寫入後端</span><span>${s.pending ? `<b style="color:${pendAcc ? 'var(--danger)' : 'var(--warn)'}">${s.pending} 項</b>${pendAcc ? `（包括 <b>${pendAcc}</b> 個帳戶）` : ''}` : '<span class="badge b-ok">全部已儲存</span>'}</span></div>
        <button class="btn btn-block btn-primary" data-go="#/tables/sync">${icon('cloud', 16)} 打開「總表同步」</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><div class="card-title">③ 儲存與備份</div>
        <div class="card-sub">匯出／匯入 JSON、逐表 CSV</div></div></div>
      <div style="padding:16px 18px" class="col gap-10">
        <p class="sm muted">後端係資料嘅家；JSON 備份係<b>你自己嘅保險</b>。
          換機、換瀏覽器、或者後端出問題嗰陣用得著。</p>
        <div class="row gap-8 wrap">
          <button class="btn" data-act="export-json">${icon('download', 15)} 匯出全部（JSON）</button>
          <button class="btn" data-act="import-json">${icon('upload', 15)} 匯入備份</button>
        </div>
        <div class="row gap-8 wrap">
          <button class="btn btn-sm" data-act="export-csv">${icon('download', 14)} 帳目 CSV</button>
          <button class="btn btn-sm" data-act="export-members">${icon('download', 14)} 團員 CSV</button>
          <button class="btn btn-sm" data-go="#/tables/data">${icon('table', 14)} 逐表匯出</button>
        </div>
        <div class="xs faint">現有資料：團員 ${n(db.members)} · 帳目 ${n(db.transactions)} · 物資 ${n(db.invItems)} · 通告 ${n(db.notices)} · 會議 ${n(db.meetings)} · 帳戶 ${n(db.accounts)}</div>
        <details class="mt-8"><summary class="btn btn-xs">危險動作（重設／清空）</summary>
          <div class="row gap-8 wrap mt-8">
            <button class="btn btn-sm" data-act="reset-seed">${icon('refresh', 15)} 還原初始資料</button>
            <button class="btn btn-sm btn-danger" data-act="wipe">${icon('trash', 15)} 清空本旅團所有資料</button>
          </div>
          <div class="hint mt-8">「還原」會用 <code>${esc(db.meta?.seedSource || 'data/units/…/')}</code> 重新種入（本機改動會消失）；「清空」會留低空嘅資料庫。</div>
        </details>
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

  /* ★ 名冊個人操作（身份與帳號分頁）：密碼 / 編輯 / 設為團長 */
  root.querySelectorAll('[data-mpw]').forEach(b => b.addEventListener('click', async () => {
    const m = members().find(x => x.id === b.dataset.mpw);
    if (!m) return;
    const r = await modal({
      title: `設定密碼：${m.name}`, sub: '設定之後即刻生效',
      body: `<div class="field"><label class="label">新密碼（最少 4 個字）</label>
          <input class="input" id="sp1" type="password" autocomplete="new-password"></div>
        <div class="field mt-12"><label class="label">再輸入一次</label>
          <input class="input" id="sp2" type="password" autocomplete="new-password"></div>
        <div id="spErr" class="err mt-8"></div>`,
      actions: [{ label: '取消', class: 'btn', value: null },
        { label: '儲存', class: 'btn-primary', onClick: el => {
          const p1 = el.querySelector('#sp1').value, p2 = el.querySelector('#sp2').value;
          const box = el.querySelector('#spErr');
          if (p1.length < 4) { box.textContent = '最少 4 個字'; box.style.display = 'block'; return false; }
          if (p1 !== p2) { box.textContent = '兩次輸入唔一樣'; box.style.display = 'block'; return false; }
          return p1;
        } }]
    });
    if (!r) return;
    const res = await setMemberHubPassword(m.id, r);
    toast(res.ok ? '密碼已設定' : res.msg, res.ok ? 'ok' : 'err');
    refresh();
  }));
  root.querySelectorAll('[data-medit]').forEach(b => b.addEventListener('click', () => go('#/members/edit/' + b.dataset.medit)));
  root.querySelectorAll('[data-mchief]').forEach(b => b.addEventListener('click', async () => {
    const m = members().find(x => x.id === b.dataset.mchief);
    if (!m) return;
    const cur = chief();
    if (!(await confirmDlg({
      title: '轉移團長身份', okText: '確定轉移',
      message: `將團長身份轉移畀 <b>${esc(m.name)}</b>？` + (cur ? `<br>${esc(cur.name)} 會變返「領袖」。` : '')
    }))) return;
    const res = await setMemberIdentity(m.id, 'chief');
    toast(res.ok ? `已將團長身份轉移畀 ${m.name}` : res.msg, res.ok ? 'ok' : 'err');
    refresh();
  }));

  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;

    /* --- 身份 / 帳號 --- */
    if (act === 'claim-chief') {
      const s = current();
      const me = s?.memberId ? members().find(x => x.id === s.memberId) : null;
      const r = await modal({
        title: '認領團長身份', sub: '每個旅團永遠只有一位團長（最高權限，可以轉移）',
        body: me
          ? `<p class="sm">你係 <b>${esc(me.name)}</b>。確定之後你就係團長。</p>`
          : `<div class="field"><label class="label">姓名</label><input class="input" id="ccName"></div>
             <div class="field mt-12"><label class="label">電郵（之後用呢個登入）</label><input class="input" id="ccEmail" type="email"></div>`,
        actions: [{ label: '取消', class: 'btn', value: null },
          { label: '確定', class: 'btn-primary', onClick: el => {
            if (me) return { name: me.name };
            const name = el.querySelector('#ccName')?.value.trim() || '';
            if (!name) return false;
            return { name, email: el.querySelector('#ccEmail')?.value.trim() || '' };
          } }]
      });
      if (!r) return;
      const info = me ? { name: me.name } : r;
      const res = await claimChief(info);
      toast(res.ok ? '已設定團長身份' : res.msg, res.ok ? 'ok' : 'err');
      refresh(); return;
    }
    if (act === 'add-account') return addAccountForm('exco');

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
    if (act === 'save-links') {
      const v = k => root.querySelector(k)?.value.trim() || '';
      const db = load();
      db.settings = {
        ...(db.settings || {}),
        troopLinks: {
          drive: v('#tl-drive'), album: v('#tl-album'), instagram: v('#tl-instagram'),
          facebook: v('#tl-facebook'), website: v('#tl-website'), whatsapp: v('#tl-whatsapp')
        }
      };
      commit();
      toast('已儲存團員公開連結', 'ok'); refresh(); return;
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

    /* --- 資料 --- */
    if (act === 'export-json') {
      dlFile(`ecportal_${currentUnit()}_備份_${stamp()}.json`, exportAll(), 'application/json');
      toast('已匯出備份', 'ok'); audit('匯出備份'); return;
    }
    if (act === 'import-json') {
      const r = await modal({
        title: '匯入備份', sub: '會覆蓋目前旅團所有資料',
        body: `<div class="field"><label class="label">貼上備份 JSON</label>
            <textarea class="textarea" id="q-json" style="min-height:180px;font-family:var(--mono);font-size:12px" placeholder='{"schema":2,…}'></textarea></div>
          <div id="q-err" class="err mt-8"></div>
        `,
        actions: [{ label: '取消', class: 'btn', value: null },
          { label: '匯入', class: 'btn-primary', onClick: el => el.querySelector('#q-json').value }]
      });
      if (!r) return;
      try {
        importAll(r);
        toast('已匯入，重新載入…', 'ok');
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        toast('匯入失敗：' + e.message, 'err');
      }
      return;
    }
    if (act === 'export-csv') {
      toCSV({
        filename: `帳目_${currentUnit()}_${stamp()}.csv`,
        headers: ['日期', '類型', '項目', '金額', '分類', '方式', '經手人', '單據', '備註'],
        rows: tx().map(t => [t.date, t.type === 'income' ? '收入' : '支出', t.item, t.amount, t.category || '', t.method || '', t.byName || '', t.receipt ? '有' : '', t.note || ''])
      });
      toast('已匯出 CSV', 'ok'); return;
    }
    if (act === 'export-members') {
      toCSV({
        filename: `團員_${currentUnit()}_${stamp()}.csv`,
        headers: ['姓名', '英文名', '生日', '職位', '電話', '電郵', '入團', '狀態'],
        rows: members().map(m => [m.name, m.eng || '', m.birthday || '', m.role || '', m.phone || '', m.email || '', m.join || '', m.status])
      });
      toast('已匯出 CSV', 'ok'); return;
    }
    if (act === 'reset-seed') {
      if (await confirmDlg({
        title: '還原初始資料', danger: true, okText: '確定還原',
        message: '本機所有改動會消失，還原做 <b>data/</b> 檔案嘅初始內容，並會登出。建議先匯出備份。'
      })) {
        await resetToSeed();
        toast('已還原，重新載入…', 'ok');
        setTimeout(() => { location.href = location.pathname + location.search; }, 700);
      }
      return;
    }
    if (act === 'wipe') {
      if (await confirmDlg({
        title: '清空本旅團資料', danger: true, okText: '確定清空',
        message: '所有團員、帳目、物資、團章改動會<b>全部清空</b>。'
      })) {
        wipe(); toast('已清空', 'ok');
        setTimeout(() => location.reload(), 600);
      }
      return;
    }
    if (act === 'own-pw') return ownPasswordForm();

  }));

  /* --- 帳戶逐個 --- */
  root.querySelectorAll('[data-add-role]').forEach(b => b.addEventListener('click', () => addAccountForm(b.dataset.addRole)));

  root.querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', () => passwordForm(b.dataset.pw)));
  root.querySelectorAll('[data-uname]').forEach(b => b.addEventListener('click', () => usernameForm(b.dataset.uname)));
  root.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.toggle;
    const acc = accountById(id);
    const r2 = setAccountActive(id, acc.active === false);
    if (!r2.ok) return toast(r2.msg, 'err');
    toast(acc.active === false ? '已啟用帳戶' : '已停用帳戶', 'ok'); refresh();
  }));
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const acc = accountById(b.dataset.del);
    if (await confirmDlg({
      title: '刪除帳戶', danger: true, okText: '確定刪除',
      message: `確定刪除 <b>${esc(acc?.name || '')}</b>（${esc(acc?.username || '')}）？佢將唔可以再登入。`
    })) {
      {
        const serverResult = await deleteAccountServer(acc);
        if (!serverResult.ok) return toast(serverResult.msg, 'err');
      }
      const r2 = deleteAccount(b.dataset.del);
      if (!r2.ok) return toast(r2.msg, 'err');
      toast('已刪除帳戶', 'ok'); refresh();
    }
  }));

  root.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
    const r2 = await restoreAccountServer({ email: b.dataset.restore }, '1234');
    if (!r2.ok) return toast(r2.msg, 'err');
    toast('帳戶已復原，預設密碼 1234，首次登入要改密碼', 'ok'); refresh();
  }));

  root.querySelectorAll('[data-switch]').forEach(b => b.addEventListener('click', () => switchUnit(b.dataset.switch)));
  root.querySelectorAll('[data-rmunit]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmDlg({ title: '移除本地旅團', danger: true, okText: '確定移除', message: '只會移除清單項目，資料庫仍會留喺本機。' })) {
      removeLocalUnit(b.dataset.rmunit); toast('已移除', 'ok'); refresh();
    }
  }));
}

/* ---------- 彈窗表單 ---------- */
async function addAccountForm(role) {
  const list = members().filter(m => m.status !== 'alumni');
  const r = await modal({
    title: `新增${ROLES[role].name}帳戶`, sub: '登入頁只可以揀「領袖」或「執委」身份',
    body: `<div class="grid g-2" style="gap:12px">
        <div class="field"><label class="label">姓名 / 顯示名 <span class="req">*</span></label>
          <input class="input" id="q-name" placeholder="例：陳大文"></div>
        <div class="field"><label class="label">職位</label>
          <input class="input" id="q-title" placeholder="例：司庫"></div>
        <div class="field"><label class="label">${role === 'leader' ? '電郵（登入用）' : '電郵／帳號'} <span class="req">*</span></label>
          <input class="input" id="q-user" placeholder="${role === 'leader' ? '例：scouter@example.com' : '電郵或帳號'}"></div>
        <div class="field"><label class="label">密碼（留空＝${TEMP_PASSWORD}）</label>
          <input class="input" id="q-pass" placeholder="留空＝首次 ${TEMP_PASSWORD}，要改"></div>
        <div class="field" style="grid-column:1/-1"><label class="label">對應團員（可選）</label>
          <select class="select" id="q-member"><option value="">— 唔關聯 —</option>
            ${list.map(m => `<option value="${m.id}">${esc(m.name)}${m.role ? `（${esc(m.role)}）` : ''}</option>`).join('')}</select></div>
      </div>
      <div id="q-err" class="err mt-8"></div>
      <div class="hint mt-8">帳號唔可以用 <code>${RESERVED_USERNAMES.join(' / ')}</code>。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '新增帳戶', class: 'btn-primary', onClick: el => {
        const name = el.querySelector('#q-name').value.trim();
        const username = el.querySelector('#q-user').value.trim();
        const password = el.querySelector('#q-pass').value;
        if (!name) { el.querySelector('#q-err').textContent = '請填姓名'; el.querySelector('#q-err').style.display = 'block'; return false; }
        return { name, username, password, title: el.querySelector('#q-title').value.trim(), memberId: el.querySelector('#q-member').value };
      } }]
  });
  if (!r) return;
  const res = await createAccountServer({ role, ...r });
  if (!res.ok) return (await modal({ title: '新增失敗', body: `<p class="sm">${esc(res.msg)}</p>`, actions: [{ label: '關閉', class: 'btn-primary', value: null }] }));
  toast('已新增帳戶', 'ok');
  refresh();
}

async function passwordForm(id) {
  const acc = accountById(id);
  if (!acc) return;
  const me = isMe(id);
  const r = await modal({
    title: me ? '更改我嘅密碼' : '更改密碼',
    sub: `${ROLES[acc.role].name} · ${esc(acc.name)}（${esc(acc.username)}）`,
    body: `<div class="field"><label class="label">新密碼 <span class="req">*</span></label>
        <input class="input" id="q-p1" type="text" autocomplete="new-password" placeholder="至少 4 個字元"></div>
      <div class="field mt-12"><label class="label">再輸入一次 <span class="req">*</span></label>
        <input class="input" id="q-p2" type="text" autocomplete="new-password"></div>
      <div id="q-err" class="err mt-8"></div>
      <div class="hint mt-12">${me ? '改完之後下次登入要用新密碼。' : `你係以「${ROLES[currentRole()]?.name}」身份改呢個帳戶嘅密碼。`}</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '更改密碼', class: 'btn-primary', onClick: el => {
        const p1 = el.querySelector('#q-p1').value, p2 = el.querySelector('#q-p2').value;
        const err = el.querySelector('#q-err');
        if (p1.length < 4) { err.textContent = '密碼至少需要 4 個字元'; err.style.display = 'block'; return false; }
        if (p1 !== p2) { err.textContent = '兩次輸入唔一樣'; err.style.display = 'block'; return false; }
        return p1;
      } }]
  });
  if (!r) return;
  if (!me) {
    const serverRes = await resetAccountPasswordServer(acc, r);
    if (!serverRes.ok) return toast(serverRes.msg, 'err');
    toast('密碼已重設，對方下次登入要改密碼', 'ok'); refresh(); return;
  }
  const res = await changePassword(id, r);
  if (!res.ok) return toast(res.msg, 'err');
  toast('密碼已更改', 'ok');
  refresh();
}

async function ownPasswordForm() {
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

async function usernameForm(id) {
  const acc = accountById(id);
  if (!acc) return;
  const r = await modal({
    title: '更改登入帳號', sub: `${ROLES[acc.role].name} · ${esc(acc.name)}`,
    body: `<div class="field"><label class="label">新帳號</label>
        <input class="input" id="q-user" value="${esc(acc.username)}"></div>
      <div class="hint mt-8">只改登入名稱，密碼維持不變。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => el.querySelector('#q-user').value }]
  });
  if (!r) return;
  const res = changeUsername(id, r);
  if (!res.ok) return toast(res.msg, 'err');
  toast('登入帳號已更改', 'ok');
  refresh();
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
