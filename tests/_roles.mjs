/* ============================================================
   tests/_roles.mjs — 測試用「個人身份」名冊（取代舊嘅共用帳戶）
   ------------------------------------------------------------
   ★ 2026-09-24 團長定案：冇「領袖共用帳戶」／「執行委員會帳號」，
     所有嘢都以**個人身份**登入（登入代號：email → loginId → ymis）。
     舊測試全部寫 `auth.login('leader', 'leader', '8202')` ——
     呢個 helper 幫手種「個人帳號」，令舊測試字眼照用，
     但實際上驗緊新模型（改身份＝改權限，冇共用帳戶）。

   喺任何 jsdom／Node 測試開機（main.js 已 import、store 已 init）之後叫：
       import { seedRosterRoles } from './_roles.mjs';
       await seedRosterRoles(store, auth);
   ============================================================ */

export const ROLE_PW = { chief: '8201', leader: '8202', exco: '8203' };
export const ROLE_LOGIN = { chief: 'chief', leader: 'leader', exco: 'exco' };

/* 示範（mock）資料庫已經有 12 位示範團員 —— 直接借用，唔好加人（加人會撞其他測試嘅數） */
const DEFS = {
  chief: { name: '測試團長', email: 'chief@example.com' },
  leader: { name: '測試領袖', email: 'leader@example.com' },
  exco: { name: '測試執委', email: '' }
};

/**
 * 種入三個身份嘅個人帳號（幂等：已經有就重用，重設密碼）。
 * 另外加一位「練習團員」（唔係 fixture，畀測試改身份用）。
 * @param {object} store  已 init 嘅 store.js
 * @param {object} auth   auth.js
 * @returns {Promise<{chief:object, leader:object, exco:object}>}
 */
export async function seedRosterRoles(store, auth) {
  const out = {};
  for (const role of ['chief', 'leader', 'exco']) {
    const loginId = ROLE_LOGIN[role];
    let m = (store.load().members || []).find(x => String(x.loginId || '') === loginId);
    if (!m) {
      const d = DEFS[role];
      m = store.add('members', {
        name: d.name, identity: role, status: 'active',
        loginId, email: d.email || '', ymis: role === 'exco' ? '8203000000' : ''
      });
    }
    if (m.identity !== role) { m.identity = role; store.commit(); }
    const pw = ROLE_PW[role];
    const r = await auth.setMemberHubPassword(m.id, pw);
    if (!r.ok) throw new Error('種唔到測試帳號密碼（' + role + '）：' + r.msg);
    out[role] = m;
  }
  /* 練習用嘅普通團員（唔帶登入代號）—— 測試改資料／改身份時用佢，
     唔好改動 fixture 本身（改咗就唔係原本嗰個身份，後面嘅測試會誤判）。 */
  if (!(store.load().members || []).some(x => x.name === PRACTICE_NAME)) {
    store.add('members', { name: PRACTICE_NAME, identity: 'member', status: 'active' });
  }
  return out;
}

export const PRACTICE_NAME = '練習團員（測試）';
/** 名冊 fixture 嘅登入代號（揀測試對象時要避開佢哋） */
export const FIXTURE_LOGINS = Object.values(ROLE_LOGIN);

/** 用角色身份登入（測試最常用嘅一句） */
export async function loginAsRole(auth, role = 'leader') {
  return auth.login(role, ROLE_LOGIN[role], ROLE_PW[role]);
}
