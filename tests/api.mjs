/* ============================================================
   tests/api.mjs — 測試 Vercel Serverless Function API
   驗證 Registry、Units 清單、Proxy 轉發與安全規則。
   ============================================================ */

import crypto from 'node:crypto';
import { getRegistry, getTrustedUnit, getProgressRegistryEntry, listPublicUnits, isTrustedExecUrl } from '../api/_registry.js';
import unitsHandler from '../api/units.js';
import proxyHandler from '../api/proxy.js';
import portalHandler from '../api/portal.js';
import { issueSuperSession, verifySuperSession } from '../api/_super-session.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n▌Serverless API & Registry 測試');

// 1. isTrustedExecUrl
ok('驗證正常 GAS /exec URL', isTrustedExecUrl('https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/exec'));
ok('擋住非 GAS URL', !isTrustedExecUrl('https://evil.com/exec'));
ok('擋住 GAS /dev URL', !isTrustedExecUrl('https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/dev'));

// 2. getRegistry & getTrustedUnit
/* 注意：data/units.json 而家得個 0082 名單（公開資料，冇後端冇 Key）。
   呢度再用環境變數開一個虛構旅團 TEST9 做 fixture，驗 env 嗰邊同合併。 */
const TEST_GAS = 'https://script.google.com/macros/s/AKfycbTESTonlyFixtureNotARealDeploymentId000000000/exec';
process.env.TROOP_TEST9_BACKEND = TEST_GAS;
process.env.TROOP_TEST9_APIKEY = 'test9_secret_key';
process.env.TROOP_TEST9_NAME = '測試旅深資童軍團';
process.env.TROOP_TEST8_BACKEND = TEST_GAS;
process.env.TROOP_TEST8_APIKEY = 'test8_secret_key';
process.env.TROOP_TEST8_NAME = '另一測試旅';

const reg = getRegistry();
ok('Registry 讀取到環境變數登記嘅旅團', !!reg.TEST9, Object.keys(reg).join(','));
ok('旅團包含 code 與名稱', reg.TEST9?.code === 'TEST9' && reg.TEST9?.name === '測試旅深資童軍團');
ok('檔案嘅 0082 只係公開名單（冇後端冇 Key）',
  !!reg['0082'] && !reg['0082'].backend?.gasUrl && !reg['0082'].backend?.apiKey, Object.keys(reg).join(','));

const trusted = getTrustedUnit('TEST9');
ok('getTrustedUnit 取得可信後端', !!trusted && !!trusted.gasUrl);
ok('getTrustedUnit 帶埋伺服器端 API Key', trusted?.apiKey === 'test9_secret_key');
ok('非白名單旅團回傳 null', getTrustedUnit('9999') === null);
ok('0082 冇登記就攞唔到後端（唔會再借用舊旅團）', getTrustedUnit('0082') === null);

// Portal SSO：網址 query 不再可偽造身份；只接受上游伺服器簽署的短期 assertion。
{
  const response = () => ({
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(s) { this.statusCode = s; return this; },
    json(v) { this.body = v; return this; }
  });
  const forged = response();
  await portalHandler({ method: 'GET', query: { u: 'TEST9', role: 'leader', src: 'https://portal.example.test', ymis: 'victim' }, headers: { host: 'vs.example.test' } }, forged);
  ok('Portal GET query 就算偽造准許來源／高權角色／YMIS 都唔會產票',
    forged.statusCode === 405 && !forged.body?.portalToken, JSON.stringify(forged.body));

  const unsigned = response();
  await portalHandler({ method: 'POST', body: { assertion: 'fake.fake' }, headers: { host: 'vs.example.test', 'x-forwarded-proto': 'https' } }, unsigned);
  ok('Portal 未簽署 assertion fail closed', unsigned.statusCode === 403 && !unsigned.body?.portalToken, JSON.stringify(unsigned.body));

  const purposeKey = (root, purpose) => crypto.createHmac('sha256', root).update(purpose).digest('hex');
  const purposeSig = (root, purpose, value) => crypto.createHmac('sha256', purposeKey(root, purpose))
    .update(value).digest('base64url');
  const payload = {
    typ: 'central-sso-assertion', u: 'TEST9', role: 'leader', sub: 'YMIS-9001', name: '可信領袖',
    iss: 'central-travel-system', aud: 'vs-portal:branch:TEST9',
    iat: Date.now(), exp: Date.now() + 60_000, jti: crypto.randomUUID()
  };
  const body64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = purposeSig(process.env.TROOP_TEST9_APIKEY, 'vs-portal-central-assertion-v1', body64);
  const assertion = body64 + '.' + sig;
  const accepted = response();
  await portalHandler({ method: 'POST', body: { assertion, role: 'super', sub: 'attacker' }, headers: { host: 'vs.example.test', 'x-forwarded-proto': 'https' } }, accepted);
  ok('Portal 有效短期 assertion 先會產票，身份只取簽署內容',
    accepted.statusCode === 200 && accepted.body?.ok === true && accepted.body?.role === 'leader'
      && accepted.body?.subject === 'YMIS-9001' && !!accepted.body?.portalToken,
    JSON.stringify(accepted.body));
  const [exchangeBody, exchangeSig] = String(accepted.body?.portalToken || '').split('.');
  const exchangePayload = JSON.parse(Buffer.from(exchangeBody, 'base64url').toString('utf8'));
  const expectedExchangeSig = purposeSig(process.env.TROOP_TEST9_APIKEY,
    'vs-portal-branch-exchange-v1', exchangeBody);
  const expectedExchangeJti = crypto.createHmac('sha256', purposeKey(process.env.TROOP_TEST9_APIKEY,
    'vs-portal-branch-exchange-jti-v1')).update(`TEST9\n${payload.jti}`).digest('base64url');
  ok('Portal 只發 60 秒、指定支部用途的 exchange token（唔係 app session）',
    accepted.body?.exchangeRequired === true && exchangePayload.typ === 'central-sso-exchange'
      && exchangePayload.u === 'TEST9' && exchangePayload.exp - exchangePayload.iat <= 60_000
      && exchangePayload.iss === 'vs-portal' && exchangePayload.aud === 'unified-gas:branch:TEST9'
      && exchangePayload.src === 'central-travel-system' && exchangePayload.jti === expectedExchangeJti
      && exchangeSig === expectedExchangeSig && Array.isArray(exchangePayload.scope));

  const test8Payload = {
    ...payload, u: 'TEST8', aud: 'vs-portal:branch:TEST8',
    sub: 'YMIS-8001', name: '另一支部領袖', jti: crypto.randomUUID()
  };
  const test8Body = Buffer.from(JSON.stringify(test8Payload)).toString('base64url');
  const wrongBranchSig = purposeSig(process.env.TROOP_TEST9_APIKEY,
    'vs-portal-central-assertion-v1', test8Body);
  const wrongBranch = response();
  await portalHandler({ method: 'POST', body: { assertion: `${test8Body}.${wrongBranchSig}` },
    headers: { host: 'vs.example.test', 'x-forwarded-proto': 'https' } }, wrongBranch);
  ok('同一 APIKEY 派生的 assertion key 仍按支部隔離，TEST9 不可冒充 TEST8',
    wrongBranch.statusCode === 403 && wrongBranch.body?.reason === 'assertion_invalid');

  const test8Sig = purposeSig(process.env.TROOP_TEST8_APIKEY,
    'vs-portal-central-assertion-v1', test8Body);
  const accepted8 = response();
  await portalHandler({ method: 'POST', body: { assertion: `${test8Body}.${test8Sig}` },
    headers: { host: 'vs.example.test', 'x-forwarded-proto': 'https' } }, accepted8);
  const [exchange8Body, exchange8Sig] = String(accepted8.body?.portalToken || '').split('.');
  const expected8Sig = purposeSig(process.env.TROOP_TEST8_APIKEY,
    'vs-portal-branch-exchange-v1', exchange8Body);
  const crossBranchExchangeSig = purposeSig(process.env.TROOP_TEST9_APIKEY,
    'vs-portal-branch-exchange-v1', exchange8Body);
  ok('用途派生 exchange key 按支部隔離，purpose token 只可由目標 Unified GAS 驗證',
    accepted8.statusCode === 200 && exchange8Sig === expected8Sig && exchange8Sig !== crossBranchExchangeSig);

  const replay = response();
  await portalHandler({ method: 'POST', body: { assertion }, headers: { host: 'vs.example.test', 'x-forwarded-proto': 'https' } }, replay);
  ok('Portal 同一 jti assertion 不可在同一服務實例重放', replay.statusCode === 403 && replay.body?.reason === 'assertion_replayed', JSON.stringify(replay.body));
}

// 代理憑證來源：API Key 只供 server 路由，唔可以代替用戶 session；舊 Key 亦不可蓋過 Registry Key。
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  const callUrls = [];
  globalThis.fetch = async (url, init) => {
    const sent = JSON.parse(init.body);
    calls.push(sent);
    callUrls.push(String(url));
    if (sent.action === 'authWhoAmI') {
      return { status: 200, text: async () => JSON.stringify({ ok: true, success: true,
        account: { id: 'YMIS-9001', ymis: 'YMIS-9001', role: 'leader' } }) };
    }
    return { status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  try {
    const makeResponse = () => ({ statusCode: 0, setHeader() { return this; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } });
    const anonymous = makeResponse();
    await proxyHandler({ method: 'POST', body: { action: 'saveTables', unit: 'TEST9', apiKey: 'outdated', tables: { members: [] } } }, anonymous);
    ok('行政資料不可用 API Key 代替登入', anonymous.statusCode === 401 && anonymous.body?.code === 'session_required');

    const response = makeResponse();
    await proxyHandler({ method: 'POST', body: { action: 'saveTables', unit: 'TEST9', apiKey: 'outdated', apikey: 'outdated',
      sessionToken: 'opaque-user-session', tables: { members: [] } } }, response);
    const authProbe = calls.find(x => x.action === 'authWhoAmI');
    const forwarded = calls.find(x => x.action === 'saveTables');
    ok('代理先由同一 GS session 對回可信身份', authProbe?.sessionToken === 'opaque-user-session' && authProbe?.apiKey === 'test9_secret_key');
    ok('舊瀏覽器 Key 不會蓋過 Registry Key', response.body?.success === true && forwarded?.apiKey === 'test9_secret_key' && !forwarded?.apikey);

    process.env.SUPER_KEY = 'proxy-super-session-test-secret';
    const superTicket = issueSuperSession('sheep');
    const beforeSuper = calls.length;
    const superResponse = makeResponse();
    await proxyHandler({ method: 'POST', body: { action: 'saveTables', unit: 'TEST9',
      sessionToken: superTicket.token, tables: { members: [] } } }, superResponse);
    const superForwarded = calls.at(-1);
    const superUrl = new URL(callUrls.at(-1));
    ok('平台 super 行政路徑不會把平台 session 當支部用戶票轉發',
      superResponse.body?.success === true && calls.length === beforeSuper + 1
        && superForwarded?.sessionToken === undefined && superForwarded?.unified_super === true
        && superForwarded?.on_behalf === 'sheep');

    const signatureKey = crypto.createHmac('sha256', 'test9_secret_key').update('vsbadge-troop-sig-v1').digest('hex');
    const expectedSig = (raw, ts, nonce, action = 'saveTables') => crypto.createHmac('sha256', signatureKey)
      .update([action, String(ts), String(nonce), crypto.createHash('sha256').update(raw).digest('hex')].join('\n'))
      .digest('hex');
    const { sig: innerSig, sig_ts: innerTs, sig_nonce: innerNonce, ...unsignedSuperBody } = superForwarded;
    const innerOk = innerSig === expectedSig(JSON.stringify(unsignedSuperBody), innerTs, innerNonce);
    const outerOk = superUrl.searchParams.get('sig') === expectedSig(JSON.stringify(superForwarded),
      superUrl.searchParams.get('sts'), superUrl.searchParams.get('snonce'));
    ok('平台 super 只以該支部 Registry Key 簽 server-to-server 行政請求',
      superForwarded?.apiKey === 'test9_secret_key' && innerOk && outerOk);

    const accountResponse = makeResponse();
    await proxyHandler({ method: 'POST', body: { action: 'authDeleteAccount', unit: 'TEST9',
      sessionToken: superTicket.token, targetUsername: 'old@example.test' } }, accountResponse);
    const accountForwarded = calls.at(-1);
    const accountUrl = new URL(callUrls.at(-1));
    const { sig: accountInnerSig, sig_ts: accountInnerTs, sig_nonce: accountInnerNonce,
      ...unsignedAccountBody } = accountForwarded;
    const accountInnerOk = accountInnerSig === expectedSig(JSON.stringify(unsignedAccountBody),
      accountInnerTs, accountInnerNonce, 'authDeleteAccount');
    const accountOuterOk = accountUrl.searchParams.get('sig') === expectedSig(JSON.stringify(accountForwarded),
      accountUrl.searchParams.get('sts'), accountUrl.searchParams.get('snonce'), 'authDeleteAccount');
    ok('平台 super 的支部帳戶操作亦轉成完整 HMAC request，不會把 Vercel session 當 GAS session',
      accountResponse.body?.success === true && accountForwarded?.sessionToken === undefined
        && accountForwarded?.unified_super === true && accountForwarded?.action === 'authDeleteAccount'
        && accountInnerOk && accountOuterOk);
    delete process.env.SUPER_KEY;
  } finally {
    delete process.env.SUPER_KEY;
    globalThis.fetch = originalFetch;
  }
}

// 正式站的 backendReady 必須有網址 *及* API Key；單靠 status 不能寫入。
process.env.TROOP_NOKEY_BACKEND = TEST_GAS;
ok('有 /exec 但未設 API Key 不顯示「可同步」', listPublicUnits().NOKEY?.backendReady === false);
delete process.env.TROOP_NOKEY_BACKEND;

// 3. listPublicUnits
const pub = listPublicUnits();
ok('公開清單包含登記咗嘅旅團', !!pub.TEST9);
ok('公開清單絕不外洩 gasUrl / apiKey，亦冇另一套 Portal secret 欄',
  pub.TEST9.gasUrl === undefined && pub.TEST9.apiKey === undefined
    && pub.TEST9.portalOrigin === undefined && pub.TEST9.portalSecret === undefined
    && pub.TEST9.portalSessionSecret === undefined);

// 4. unitsHandler
let resStatus = 0;
let resHeaders = {};
let resJson = null;
const mockRes = {
  setHeader(k, v) { resHeaders[k] = v; return this; },
  status(s) { resStatus = s; return this; },
  json(obj) { resJson = obj; return this; }
};
unitsHandler({ method: 'GET' }, mockRes);
ok('unitsHandler 回傳 HTTP 200', resStatus === 200);
ok('unitsHandler 回傳 units 物件', !!resJson?.units?.TEST9);

// 5. 純環境變數開新旅團（唔改 Git 都開得）
{
  const GAS = 'https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec';
  process.env.TROOP_0081_BACKEND = GAS;
  process.env.TROOP_0081_APIKEY = 'troop_key_81';
  process.env.TROOP_0081_NAME = '第八十一旅深資童軍團';
  process.env.TROOP_0081_NOTICE = GAS;
  /* 舊分離變數即使殘留亦不可改送第二個進度後端。 */
  process.env.TROOP_0081_PROGRESSBACKEND = TEST_GAS;
  process.env.TROOP_0081_PROGRESSAPIKEY = 'must_be_ignored';

  const envPub = listPublicUnits();
  ok('淨係設 env 都開到新旅團（0081 出現喺公開清單）', !!envPub['0081'], Object.keys(envPub).join(','));
  ok('旅團名由 TROOP_<id>_NAME 讀（冇填就「第 0081 旅」）', envPub['0081'].name === '第八十一旅深資童軍團', envPub['0081'].name);
  ok('公開清單一樣唔外洩 gasUrl / apiKey / progress key',
    envPub['0081'].gasUrl === undefined && envPub['0081'].apiKey === undefined && envPub['0081'].progressApiKey === undefined);
  ok('公開清單標示「伺服器端已備妥進度後端」（前端唔使填）', envPub['0081'].progressServerSide === true);
  const progressEntry = getProgressRegistryEntry('0081');
  ok('進度固定沿用同一 BACKEND／APIKEY，毋須亦冇第二組進度變數',
    progressEntry.backend === GAS && progressEntry.apiKey === 'troop_key_81');
  ok('公開清單標示通告可以直接送去總表', envPub['0081'].noticeReady === true);
  ok('env 旅團一樣通過白名單驗證（proxy 用得到）', !!getTrustedUnit('0081')?.gasUrl);

  delete process.env.TROOP_0081_BACKEND;
  delete process.env.TROOP_0081_APIKEY;
  delete process.env.TROOP_0081_NAME;
  delete process.env.TROOP_0081_NOTICE;
  delete process.env.TROOP_0081_PROGRESSBACKEND;
  delete process.env.TROOP_0081_PROGRESSAPIKEY;
  ok('刪走 env 之後就唔再出現（唔會殘留）', !listPublicUnits()['0081']);
}

// 6. 新旅團申請 → 經 proxy 送去 ADMIN 系統（中央收件匣）
{
  const ADMIN = 'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';
  const proxyRes = () => {
    const r = { statusCode: 0, headers: {}, body: null };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (o) => { r.body = o; return r; };
    return r;
  };
  const calls = [];
  let upstreamJson = { success: true, message: '申請已提交' };
  let upstreamRaw = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    calls.push({ target: String(target), init });
    const text = upstreamRaw !== null ? upstreamRaw : JSON.stringify(upstreamJson);
    return {
      ok: true, status: 200,
      text: async () => text,
      json: async () => JSON.parse(text)
    };
  };
  const post = async (body) => {
    const res = proxyRes();
    await proxyHandler({ method: 'POST', body }, res);
    return res;
  };

  const good = await post({
    action: 'submitRegistration', troopId: '0100', troopName: '第一百旅深資童軍團',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec',
    apiKey: 'K1', contact: 'a@b.hk', note: '想埋進度', mainSystemUrl: 'https://ecportal.vercel.app'
  });
  const sent = JSON.parse(calls[0]?.init?.body || '{}');
  ok('提交申請 → 用同源 proxy 轉發（申請人唔使直接打 GAS）', calls.length === 1 && calls[0].target === ADMIN, calls[0]?.target);
  ok('收件匣目的地由伺服器端固定（前端改唔到）',
    (await post({ action: 'submitRegistration', troopId: '0100', troopName: 'X', apiKey: 'K1',
      adminUrl: 'https://evil.example.com/exec',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }))
      && calls[calls.length - 1].target === ADMIN);
  ok('轉發 payload 帶 appType=82venture ＋ appName（同 VSBADGE 共用收件匣，可以分辨）',
    sent.appType === '82venture' && sent.appName === '深資童軍管理系統', JSON.stringify({ appType: sent.appType, appName: sent.appName }));
  ok('轉發 payload 帶齊旅團編號／名稱／後端／API Key／聯絡人／主系統網址',
    sent.troopId === '0100' && sent.troopName === '第一百旅深資童軍團'
    && /\/exec$/.test(sent.scriptUrl) && sent.apiKey === 'K1' && sent.contact === 'a@b.hk'
    && sent.mainSystemUrl === 'https://ecportal.vercel.app' && /^\d{4}-\d{2}-\d{2}T/.test(sent.at || ''));
  ok('收件匣回 JSON → proxy 當送到（success:true，唔聲稱有回執）',
    good.statusCode === 200 && good.body?.success === true && good.body?.receipt === false);
  const beforeIncomplete = calls.length;
  const incomplete = await post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' });
  ok('server 亦拒絕缺 API Key 的不完整申請，不會轉發去收件匣',
    incomplete.statusCode === 400 && incomplete.body?.reason === 'registration_invalid'
      && calls.length === beforeIncomplete, JSON.stringify(incomplete.body));
  /* 收件匣唔會回執：回 HTML／空白都要當送到（ADMIN 系統收到就 OK） */
  const htmlPage = await (upstreamRaw = '<html>已收到</html>', post({ action: 'submitRegistration', troopId: '0100', troopName: 'X', apiKey: 'K1',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣唔回 JSON（HTML／空白）→ 照當送到（唔會誤報失敗）',
    htmlPage.statusCode === 200 && htmlPage.body?.success === true, JSON.stringify(htmlPage.body));
  const blank = await (upstreamRaw = ' ', post({ action: 'submitRegistration', troopId: '0100', troopName: 'X', apiKey: 'K1',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣回空白 → 同樣當送到', blank.statusCode === 200 && blank.body?.success === true);
  /* 但收件匣真係話收唔到，就照當失敗 */
  upstreamRaw = null;
  const refused = await (upstreamJson = { success: false, error: '唔收呢類申請' },
    post({ action: 'submitRegistration', troopId: '0100', troopName: 'X', apiKey: 'K1',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣明確回 success:false → 當失敗（唔會呃申請人）',
    refused.statusCode === 502 && /唔收呢類申請/.test(refused.body?.error || ''), JSON.stringify(refused.body));
  upstreamJson = { success: true, message: '申請已提交' };

  /* ★ 2026-09-25 團長：「加個求救制，有咩大問題 SEND 去問 ADMIN，當回報問題處理」—— 同 submitRegistration 一條路 */
  const issue = await post({
    action: 'submitIssue', troopId: '0082', title: '同步啲掣唔知點排', desc: '成頁啲掣好亂，唔知邊個打邊個',
    severity: '高', name: '團長', contact: 'leader@example.hk',
    from: '管理系統', issueUrl: 'https://example.com/app#/tables/sync', at: '2026-09-25T10:00:00.000Z'
  });
  const issuePayload = JSON.parse(calls[calls.length - 1]?.init?.body || '{}');
  ok('submitIssue → 送同一個中央收件匣（目的地固定）', calls[calls.length - 1]?.target === ADMIN, calls[calls.length - 1]?.target);
  ok('求救 payload 對正 ADMIN「問題回報」合約（type=issue ＋ sourceApp=82venture）',
    issuePayload.type === 'issue' && issuePayload.sourceApp === '82venture', JSON.stringify({ type: issuePayload.type, sourceApp: issuePayload.sourceApp }));
  ok('求救 payload 帶齊標題／詳情／嚴重度／旅團號／姓名／Email（轉寄用）', issuePayload.title === '同步啲掣唔知點排'
    && issuePayload.desc === '成頁啲掣好亂，唔知邊個打邊個' && issuePayload.severity === '高'
    && issuePayload.troopId === '0082' && issuePayload.name === '團長'
    && issuePayload.contact === 'leader@example.hk', JSON.stringify(issuePayload));
  ok('求救收件匣回 JSON → proxy 當送到（success:true）', issue.statusCode === 200 && issue.body?.success === true, JSON.stringify(issue.body));

  /* 連線唔通 → 失敗 */
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('boom'); e.name = 'TimeoutError'; throw e; };
  const down = await post({ action: 'submitRegistration', troopId: '0100', troopName: 'X', apiKey: 'K1',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' });
  ok('連線／逾時 → 回 504（呢個先算送唔到）', down.statusCode === 504, JSON.stringify(down.body));
  globalThis.fetch = realFetch2;
  ok('proxy 只接受 POST', (await (async () => {
    const r = proxyRes(); await proxyHandler({ method: 'GET' }, r); return r;
  })()).statusCode === 405);
  ok('唔喺白名單嘅 action 會被擋',
    (await post({ action: 'deleteEverything', troopId: '0082' })).statusCode === 400);
  globalThis.fetch = realFetch;
}

/* ============================================================
   4. api/auth.js —— 超管核對搬上伺服器端（2026-09-20）
   ------------------------------------------------------------
   以前密碼寫死喺 assets/js/lib/auth.js，而呢個係靜態網站 ——
   個檔會原原本本送到每個訪客嘅瀏覽器，repo 又係 public。
   而家：核對喺伺服器端做，密碼只存喺 Vercel 嘅 SUPER_KEY。
   ============================================================ */
console.log('\n▌超管核對（api/auth.js：SUPER_KEY、fail closed）');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const authHandler = (await import('../api/auth.js')).default;

  const res4 = () => {
    const r = { statusCode: 0, headers: {}, body: null };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (o) => { r.body = o; return r; };
    return r;
  };
  const realLog = console.log;
  const call = async (body, method = 'POST') => {
    const r = res4();
    console.log = () => {};
    try { await authHandler({ method, body }, r); } finally { console.log = realLog; }
    return r;
  };

  const PW = 'test-super-pw-2026';

  /* ---- 原始碼守門：前端唔可以再有任何超管秘密 ---- */
  const authSrc = fs.readFileSync(path.join(ROOT, 'assets/js/lib/auth.js'), 'utf8');

  /* 舊後門嘅形狀：「密碼變數直接同一個寫死嘅純數字字串比對」，
     例如 `p === <四位數>` 或者 `String(password) === <四位數>`。
     `\\)*` 係要吞埋 `String(password)` 嗰個收掣括號。

     呢條 regex 淨係認**寫死嘅數字字面量**，所以唔會誤傷
     `|| p === TEMP_PASSWORD`（嗰個係變數，係正常嘅「初始密碼要強制改」邏輯）。

     ⚠️ 刻意用「形狀」而唔係用真密碼做斷言 —— 真密碼**唔應該出現喺 repo
     任何地方，連測試檔都唔應該有**。之前呢個 repo 就係咁樣漏咗。 */
  const BACKDOOR_RE = /(?:\bp\b|\bpassword\b)\s*\)*\s*===\s*'\d{3,8}'/;

  /* 先驗條 regex 本身認唔認得出後門 —— 一條永遠 pass 嘅掃描等於冇掃描。 */
  ok('掃描用嘅 regex 認得出舊後門（唔係一條永遠 pass 嘅假斷言）',
    BACKDOOR_RE.test("|| p === '0000';") && BACKDOOR_RE.test("String(password) === '0000'"));
  ok('掃描用嘅 regex 唔會誤傷合法嘅 TEMP_PASSWORD 比對',
    !BACKDOOR_RE.test('p === TEMP_PASSWORD') && !BACKDOOR_RE.test('String(password) === TEMP_PASSWORD'));

  ok('★ auth.js 已經冇寫死嘅後門密碼', !BACKDOOR_RE.test(authSrc));
  ok('★ auth.js 已經冇寫死嘅超管 hash', !/652debbfdc29dd091325028855c281a08a50f91fcd0eb269444ff4eb5338645e/.test(authSrc));
  ok('★ auth.js 冇任何 salt／hash 欄位留低', !/SUPER\s*=\s*\{[^}]*\b(salt|hash)\b/s.test(authSrc));
  ok('auth.js 改為叫伺服器端核對', /fetch\('api\/auth'/.test(authSrc) && /verifySuperServer/.test(authSrc));

  /* ★ 掃描範圍係**成個 repo**，唔淨止 assets/。
     原因：改嘢嗰陣真密碼一度由 auth.js 搬咗去 tests/_authstub.mjs ——
     如果只掃 assets/ 就會「綠燈通過」而密碼照樣留喺公開 repo。 */
  const SCAN_SKIP = new Set(['.git', 'node_modules', '.vercel', 'dist', 'build']);
  const repoFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SCAN_SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|gs|json|md|html)$/.test(e.name)) repoFiles.push(p);
    }
  })(ROOT);

  /* 掃描器自己要豁免：呢個檔入面有「後門長成點」嘅樣本字串。 */
  const SELF = path.join(ROOT, 'tests/api.mjs');
  ok('★ 成個 repo（唔淨止 assets/）都搵唔到寫死嘅後門密碼', (() => {
    const hits = repoFiles.filter(f => f !== SELF && BACKDOOR_RE.test(fs.readFileSync(f, 'utf8')));
    if (hits.length) console.log('      漏咗喺：' + hits.map(f => path.relative(ROOT, f)).join(', '));
    return hits.length === 0;
  })(), `掃咗 ${repoFiles.length - 1} 個檔（掃描器自己豁免）`);

  ok('★ 成個 repo 都搵唔到舊嗰個超管 hash', (() => {
    const OLD_HASH = '652debbf' + 'dc29dd091325028855c281a08a50f91fcd0eb269444ff4eb5338645e';
    const hits = repoFiles.filter(f => f !== SELF && fs.readFileSync(f, 'utf8').includes(OLD_HASH));
    if (hits.length) console.log('      漏咗喺：' + hits.map(f => path.relative(ROOT, f)).join(', '));
    return hits.length === 0;
  })());

  ok('★ 測試 fixture 都唔用返真密碼（秘密唔應該喺 repo 任何地方）', (() => {
    const stub = fs.readFileSync(path.join(ROOT, 'tests/_authstub.mjs'), 'utf8');
    return /TEST_SUPER_PASSWORD\s*=\s*'[^']*'/.test(stub) && !/'\d{3,8}'/.test(stub);
  })());

  /* ---- fail closed：SUPER_KEY 冇設 → 成條路關閉 ---- */
  delete process.env.SUPER_KEY;
  const off = await call({ user: 'sheep', password: PW });
  ok('★ 未設 SUPER_KEY → 503 ＋ disabled（fail closed，唔會靜靜地放行）',
    off.statusCode === 503 && off.body?.disabled === true && off.body?.ok === false, JSON.stringify(off.body));
  ok('關閉嗰陣嘅提示教管理員點做（講明 SUPER_KEY）',
    /SUPER_KEY/.test(String(off.body?.hint || '')));

  /* ---- 正常核對：一個環境變數，填明文密碼 ---- */
  process.env.SUPER_KEY = PW;
  const good = await call({ user: 'sheep', password: PW });
  ok('★ SUPER_KEY = 密碼，密碼啱 → 200', good.statusCode === 200 && good.body?.ok === true,
    JSON.stringify(good.body));
  ok('★ 成功登入簽發有 expiry 嘅短期超管 HMAC session',
    !!good.body?.sessionToken && good.body?.sessionExpiresAt > Date.now()
      && verifySuperSession(good.body.sessionToken)?.role === 'super', JSON.stringify(good.body));
  ok('★ 超管 session 被竄改後 fail closed',
    verifySuperSession(String(good.body?.sessionToken || '') + 'x') === null);
  ok('★ 回應唔會洩漏密碼', !JSON.stringify(good.body).includes(PW), JSON.stringify(good.body));
  const firstSuperTicket = good.body?.sessionToken;

  const bad = await call({ user: 'sheep', password: 'wrong-password' });
  ok('密碼錯 → 401', bad.statusCode === 401 && bad.body?.ok === false, JSON.stringify(bad.body));

  const wrongUser = await call({ user: 'not-sheep', password: PW });
  ok('用戶名錯 → 401（同一句訊息，唔會確認邊個 username 存在）',
    wrongUser.statusCode === 401 && String(wrongUser.body?.error) === String(bad.body?.error));

  /* BUILD §2：同一帳號連續 5 次失敗後鎖 15 分鐘；鎖定訊息唔暴露帳號是否存在。 */
  for (let i = 0; i < 5; i++) await call({ user: 'attacker', password: 'wrong-password' });
  const locked = await call({ user: 'attacker', password: 'wrong-password' });
  ok('連續 5 次失敗後帳號鎖定', locked.statusCode === 423 && /15 分鐘/.test(locked.body?.error || ''), JSON.stringify(locked.body));

  /* 改密碼 = 改個環境變數值，即刻生效 */
  process.env.SUPER_KEY = 'a-brand-new-password';
  ok('★ 改咗 SUPER_KEY → 舊密碼即刻入唔到',
    (await call({ user: 'sheep', password: PW })).statusCode === 401);
  ok('★ 改咗 SUPER_KEY → 舊超管 session 同步失效', verifySuperSession(firstSuperTicket) === null);
  const freshSuper = await call({ user: 'sheep', password: 'a-brand-new-password' });
  ok('★ 改咗 SUPER_KEY → 新密碼即刻入到並簽發新 session',
    freshSuper.statusCode === 200 && verifySuperSession(freshSuper.body?.sessionToken)?.role === 'super');

  /* sheep 係品牌固定隱藏超管，不接受 SUPER_USER 改名或另造入口。 */
  process.env.SUPER_USER = 'myboss';
  ok('隱藏超管帳戶固定係 sheep',
    (await call({ user: 'myboss', password: 'a-brand-new-password' })).statusCode === 401
    && (await call({ user: 'sheep', password: 'a-brand-new-password' })).statusCode === 200);
  delete process.env.SUPER_USER;

  ok('GET 唔接受（只接受 POST）', (await call({}, 'GET')).statusCode === 405);

  delete process.env.SUPER_KEY;
}

console.log(`\n──────── API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
