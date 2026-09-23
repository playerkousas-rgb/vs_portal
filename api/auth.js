// api/auth.js — 超級管理員登入（伺服器端核對）
//
// ============================================================
//  設定：Vercel → Settings → Environment Variables
// ------------------------------------------------------------
//      SUPER_KEY = 你嘅密碼
//
//  一個變數，填平台品牌通行密碼，搞掂。改密碼 = 改個值 → Redeploy。
//  隱藏超管帳戶固定叫 sheep；SUPER_USER 不是可配置的普通帳戶。
//
// ============================================================
//  點解要伺服器端核對
// ------------------------------------------------------------
//  以前密碼寫死喺 assets/js/lib/auth.js，而呢個係**靜態網站** ——
//  嗰個檔會原原本本送到每個訪客嘅瀏覽器，repo 又係 public，
//  等於密碼貼咗出街。
//
//  而家密碼只喺呢度（伺服器端）出現，永遠唔會落瀏覽器。
//  環境變數冇設 → 超管登入完全關閉（fail closed，唔會靜靜地放行）。
//
// ============================================================
//  ⚠️ 保護到乜、保護唔到乜（一定要知）
// ------------------------------------------------------------
//  保護到：**密碼**。冇人可以由公開 repo 讀到佢。
//
//  保護唔到：**「超管」呢個身份本身**。個 App 係靜態網站，
//  isSuper() 只係讀 localStorage —— 識開 DevTools 嘅人可以人手寫
//  {"role":"super"} 落去，照樣見到超管先至見到嘅畫面。
//  而家超管淨係 gate UI（MOCK tab、開新旅團教學同掣），冇一個真正嘅
//  伺服器端特權操作，所以暫時冇實質損失。
//  將來超管如果要做真正敏感嘅嘢（改 registry、清後端、讀人哋旅團），
//  嗰個操作本身一定要放喺伺服器端，並且自己再核對一次 SUPER_KEY。
// ============================================================

import crypto from 'node:crypto';

export const config = { maxDuration: 15 };

/* Scout System 品牌級隱藏超管：固定身份，唯一密碼由 Vercel SUPER_KEY 提供。 */
export const SUPER_ADMIN = 'sheep';

/* 環境變數要喺**請求嗰陣**先讀，唔好喺 module 頂層讀死：
   頂層讀嘅話，Vercel 上面如果變數係部署之後先加，舊 instance 會一路用舊值。 */
function cfg() {
  return {
    /* SUPER_KEY 係平台唯一嘅 SUPER 備援登入密碼；唔拆成多個環境變數。 */
    key: String(process.env.SUPER_KEY || ''),
    user: SUPER_ADMIN
  };
}

/* 極簡速率限制。**注意**：Vercel serverless 每個 instance 各自計數，
   所以呢個只係擋「同一個 instance 上面嘅連環爆」，唔係真正嘅全局限流。 */
const hits = new Map();
const failures = new Map();
const ACCOUNT_FAIL_LIMIT = 5;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;

function rateLimited(key, max = 8, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function accountLockState(user) {
  const now = Date.now();
  const state = failures.get(user);
  if (!state) return { failed: 0, lockedUntil: 0 };
  if (state.lockedUntil && state.lockedUntil <= now) {
    failures.delete(user);
    return { failed: 0, lockedUntil: 0 };
  }
  return state;
}

function registerFailure(user) {
  const state = accountLockState(user);
  state.failed += 1;
  if (state.failed >= ACCOUNT_FAIL_LIMIT) state.lockedUntil = Date.now() + ACCOUNT_LOCK_MS;
  failures.set(user, state);
  return state;
}

function clearFailures(user) { failures.delete(user); }

function send(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

/** 常數時間比對（唔好用 === ：長度同首幾個字元會洩漏資訊） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: '只接受 POST' });
  }

  const settings = cfg();
  const { key, user: wantUser } = settings;

  /* fail closed：SUPER_KEY 冇設 → 超管登入成條路關閉。 */
  if (!key) {
    return send(res, 503, {
      ok: false, disabled: true,
      error: '超級管理員登入未啟用（伺服器未設 SUPER_KEY）',
      hint: '喺 Vercel → Settings → Environment Variables 加 SUPER_KEY = 你嘅密碼，再 Redeploy。'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '請求格式錯誤' });

  const requestIp = String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || 'unknown')
    .split(',')[0].trim().slice(0, 80);
  const rateKey = `super:${requestIp}:${String(body.user || '').trim().toLowerCase().slice(0, 120)}`;
  if (rateLimited(rateKey)) {
    return send(res, 429, { ok: false, error: '試太多次，請 5 分鐘後再試' });
  }

  const user = String(body.user || '').trim().toLowerCase();
  const password = String(body.password || '');
  const lock = accountLockState(user);
  if (lock.lockedUntil > Date.now()) {
    return send(res, 423, { ok: false, error: '帳號暫時鎖定，請 15 分鐘後再試' });
  }

  /* username 錯同密碼錯要回**同一句**訊息，
     否則人可以用嚟確認邊個 username 存在。 */
  if (!safeEqual(user, wantUser) || !safeEqual(password, key)) {
    const next = registerFailure(user);
    try { console.log(JSON.stringify({ svc: 'ecportal-auth', result: 'failed', user, failed: next.failed })); } catch { /* ignore */ }
    return send(res, 401, { ok: false, error: '帳號或密碼不正確' });
  }

  clearFailures(user);
  /* ⚠️ 只 log metadata。密碼一律唔入 log。 */
  try { console.log(JSON.stringify({ svc: 'ecportal-auth', result: 'ok', user })); } catch { /* ignore */ }
  /* 只回「啱」。密碼唔會回。 */
  return send(res, 200, { ok: true, user: wantUser });
}
