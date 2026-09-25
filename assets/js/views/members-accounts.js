/* ============================================================
   members-accounts.js — 「用戶與身份 → 身份與帳號」分頁
   ------------------------------------------------------------
   ★ 2026-09-24 團長定案：
     ①「身份與系統」改名做「**系統**」（淨係留 旅團設定／資料管理／操作紀錄）
     ②「**身份與帳號**」成個分頁搬入「**用戶與身份**」

   點解放喺呢個檔案而唔係塞入 members.js：
     members.js 已經成 900 行（名冊／個人頁／編輯器／生日表／權限總表），
     再塞多一個分頁會令「睇名冊」嘅人同「管帳號」嘅人互相踩。
     呢度淨係負責「身份＝帳號」嗰一版，由 members.js 喺 mount 嗰陣掛上。

   規則（依實際需要）：
     超管：可改領袖、執委任何帳戶密碼，可開／刪帳戶
     領袖：可改自己同執委帳戶密碼，可開／刪執委帳戶
     執委：只可以改自己密碼
     超管帳戶：唔會出現在任何名單，任何人都唔可以改佢密碼。
   ============================================================ */

import { load } from '../lib/store.js';
import {
  ROLES, accounts, accountById, can, canChangePasswordOf, canManageRole,
  createAccountServer, changePassword, changeUsername, setAccountActive,
  deleteAccount, deleteAccountServer, resetAccountPasswordServer,
  current, currentRole, isMe, displayName, RESERVED_USERNAMES, TEMP_PASSWORD,
  setMemberIdentity, setMemberHubPassword, canClaimChief
} from '../lib/auth.js';
import {
  loginIdOf, members, memberName, chief, identityOf, activeMembers
} from '../lib/model.js';
import { esc, icon, modal, confirmDlg, toast } from '../lib/util.js';
import { go } from '../lib/router.js';
import { pageHead, tabs, empty, stat, noteBox } from './ui.js';

/* 「用戶與身份」四個分頁 —— 名冊／身份與帳號／權限總表／生日表。
   由 members.js 同呢度共用（tabs() 掣由 main.js 全域綁去 #/members/<tab>）。 */
export function memberTabs(tab = 'list') {
  return tabs([
    ['list', '用戶名冊'],
    ['accounts', '身份與帳號', activeMembers().length],
    ['perms', '權限總表'],
    ['birthdays', '生日表']
  ], tab);
}

const PASSWORD_RULES = [
  ['超級管理員（隱藏）', '可以改任何人嘅密碼。', '超管自己嘅密碼係固定嘅，冇人可以改。'],
  ['團長（每團一位）', '可以改自己、領袖、執委、團員嘅密碼；可以設定／轉移身份。', '唔可以改超管密碼；團長身份只可以轉移，唔可以直接改低。'],
  ['領袖', '可以改自己嘅密碼，亦可以改執委／團員嘅密碼；可以改身份（團長除外）。', '唔可以改其他領袖或團長嘅密碼。'],
  ['執委', '只可以改自己嘅密碼，可以改資料。', '唔可以改身份（＝唔可以改權限）。'],
  ['團員', '只可以改自己嘅密碼。', '只入團員入口（members.html）。']
];

/* ============================================================
   身份與帳號
   ============================================================ */
export function identityTabView() {
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
  ${pageHead({
    title: '身份與帳號',
    sub: `${load()?.unit?.name || ''} · 目前身份：${displayName()}（${ROLES[currentRole()]?.name || ''}）· 一個人一個帳號（冇共用帳戶）`,
    actions: `${can('docs.view') ? `<button class="btn btn-sm" data-go="#/docs">${icon('note', 15)} 教學</button>` : ''}`
  })}
  ${memberTabs('accounts')}

  <div class="grid g-4 mb-16">
    ${stat('團長', String(cnt('chief')), c ? c.name : '未設定')}
    ${stat('領袖', String(cnt('leader')), '電郵登入')}
    ${stat('執委', String(cnt('exco')), 'YMIS 登入')}
    ${stat('團員', String(cnt('member')), '入團員入口')}
  </div>

  ${noteBox(`<b>身份即帳號（2026-09-24 定案）：</b>唔會再有「領袖共用帳戶」或者「執行委員會帳號」——
    每個人都係名冊入面嘅<b>一條紀錄</b>，登入代號係佢自己嘅<b>電郵 / 自訂帳號 / YMIS</b>，
    密碼就係佢自己嗰個。要換權限＝喺「用戶名冊」改<b>身份</b>（換屆唔使開新帳戶、唔使夾密碼）。
    <br>團長：每個旅團<b>永遠只有一位</b>，最高權限，可以轉移。
    <div class="xs mt-8 faint">⚠ 呢度<b>改密碼／改身份</b>之後，一定要撳頂部「<b>儲存到後端</b>」——
    未寫入後端之前，對方喺第二部機（甚至第二個視窗）都<b>登唔到</b>。</div>`, 'brand')}
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
   mount（由 members.js 喺 render 呢一版嗰陣呼叫）
   ============================================================ */
export function mountAccountsTab(root, refresh) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));

  /* 名冊個人操作（身份與帳號分頁）：密碼 / 編輯 / 設為團長 */
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
    toast(res.ok ? '密碼已設定 —— 記得撳頂部「儲存到後端」，否則第二部機登唔到' : res.msg, res.ok ? 'ok' : 'err');
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

  /* 注意：data-act="claim-chief"（認領團長）**唔喺呢度綁** ——
     members.js 嘅 mount 已經全域綁咗同一個動作（而且 modal 一模一樣），
     重覆綁會彈兩次對話框。呢度淨係綁呢一版自己先有嘅「新增舊版帳戶」。 */
  root.querySelectorAll('[data-act="add-account"]').forEach(b => b.addEventListener('click', () => addAccountForm('exco', refresh)));

  /* 舊版個人帳戶逐個 */
  root.querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', () => passwordForm(b.dataset.pw, refresh)));
  root.querySelectorAll('[data-uname]').forEach(b => b.addEventListener('click', () => usernameForm(b.dataset.uname, refresh)));
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
      const serverResult = await deleteAccountServer(acc);
      if (!serverResult.ok) return toast(serverResult.msg, 'err');
      const r2 = deleteAccount(b.dataset.del);
      if (!r2.ok) return toast(r2.msg, 'err');
      toast('已刪除帳戶', 'ok'); refresh();
    }
  }));
}

/* ---------- 彈窗表單 ---------- */
async function addAccountForm(role, refresh) {
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

async function passwordForm(id, refresh) {
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

async function usernameForm(id, refresh) {
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
