/* ============================================================
   backend-reality.js — 「後端實況」卡（只讀核對 ＋ 一寫一讀驗證）
   ------------------------------------------------------------
   ★ 2026-09-24 團長：「最大的問題還是我的資料同步不到，
     我完全不知道他能不能寫進後端，要是能寫進為什麼讀不到。」

   呢張卡就係為咗答呢句。佢**唔會自己寫任何嘢**，淨係做兩件事：

     ① 「即刻核對（淨係讀）」—— 問後端：你而家有幾多位用戶／幾多筆帳目？
        同呢部機對唔對得上？再用一句人話講結論。
        → 答到「後端有冇我啲嘢」。

     ② 「一寫一讀驗證」—— 喺資料庫 meta 寫一個記號，行**同一條**
        寫入路（saveToBackend）送出，再由後端讀返出嚟對個記號。
        對得上 ＝ 寫入同讀取兩條路都真係通。
        → 答到「到底寫唔寫得入、讀唔讀得出」。

   兩件事都唔會改任何正式紀錄（② 完咗會把記號清走）。

   邊度用到呢張卡：
     · 系統 → 資料管理（團長最常去嘅位）
     · 資料管理 → 總表同步（#/tables/sync）
   ============================================================ */

import { load } from '../lib/store.js';
import { esc, icon, modal, toast, copyText } from '../lib/util.js';
import { fmtBytes } from '../lib/remote.js';

/* 上次核對嘅結果（撳掣先至跑；呢度淨係畫返上次結果） */
let lastReality = null;
let realityRunning = false;
let lastProbe = null;
let probeRunning = false;

const LEVEL = {
  ok: ['b-ok', 'check', '對得上'],
  warn: ['b-warn', 'alert', '要處理'],
  bad: ['b-danger', 'alert', '斷咗']
};

function when(s) { return String(s || '').slice(0, 19).replace('T', ' '); }

/* ---------------- 卡本身 ---------------- */
export function realityCard() {
  const d = lastReality;
  const p = lastProbe;
  const pend = Number(load()?.sync?.pending || 0);
  const pendAcc = Number(load()?.sync?.pendingAccounts || 0);

  const head = `
  <div class="card mb-16"><div class="card-head">
    <div><div class="card-title">${icon('cloud', 15)} 後端實況</div>
      <div class="card-sub">你部機有乜 vs 後端而家有乜 —— 一眼睇到「寫唔寫得入、讀唔讀得出」（只讀，唔會改你嘅資料）</div></div>
    ${realityRunning ? '<span class="badge b-info"><span class="dot"></span>核對緊…</span>'
      : d ? `<span class="badge ${LEVEL[d.verdict?.level]?.[0] || 'b-grey'}"><span class="dot"></span>${LEVEL[d.verdict?.level]?.[2] || ''}</span>` : ''}
  </div>
  <div style="padding:12px 16px" class="sm muted">`;

  const actions = `
    <div class="row gap-8 mt-12 wrap">
      <button class="btn btn-sm" data-act="reality-write-read">${icon('check', 15)} 測試接線寫入＋讀回</button>
      <button class="btn btn-sm btn-primary" data-act="reality-check">${icon('refresh', 15)} 即刻核對（淨係讀）</button>
      <button class="btn btn-sm" data-act="reality-probe">${icon('shield', 15)} 一寫一讀驗證</button>
      ${d ? `<button class="btn btn-sm" data-act="reality-copy">${icon('copy', 15)} 複製結果</button>` : ''}
    </div>
    <div class="hint mt-8">「<b>即刻核對</b>」淨係讀（唔會寫任何嘢），會話你知後端而家有幾多用戶／帳目，同你部機差幾多。<br>
      「<b>一寫一讀驗證</b>」會寫一個記號落後端再讀返出嚟對 —— 對得上就證明<b>寫入同讀取都真係通</b>（用完會清走個記號）。</div>`;

  if (!d) {
    return head + `
      <div class="row gap-8 wrap" style="align-items:center">
        <span class="grow">唔知啲嘢有冇寫入後端？撳一下，佢會直接話你知<b>後端而家有乜、同你部機差幾多</b>。</span>
      </div>
      ${actions}
    </div></div>`;
  }

  const v = d.verdict || {};
  const [cls, ic] = LEVEL[v.level] || ['b-grey', 'info'];
  const rows = (d.rows || []).map(r => {
    const tick = r.same === null ? '<span class="faint">—</span>'
      : r.same ? `<span style="color:var(--ok);font-weight:700">✓</span>`
        : `<span style="color:var(--danger);font-weight:700">✗</span>`;
    return `<tr>
      <td>${esc(r.label)}</td>
      <td class="right mono">${r.local}</td>
      <td class="right mono">${r.backend === null ? '<span class="faint">（冇資料）</span>' : r.backend}</td>
      <td class="center">${tick}</td>
    </tr>`;
  }).join('');

  const junkRows = Number(d.staleRows || 0);
  const staging = Number(d.stagingRows || 0);
  const versionSets = Number(d.versions || 0);
  const baseV = String(load()?.sync?.lastSyncedVersion || '');
  const facts = [
    d.sheet ? ['寫入緊嘅試算表', `「${esc(d.sheet)}」`] : null,
    d.backendVersion ? ['後端版本', esc(d.backendVersion)] : null,
    /* ★ v2.8.1：分得出「真係空」定「有行但讀唔到」 */
    (d.mode || d.simpleRows || d.blobRows) ? ['儲存模式＋正本行數',
      `${d.mode === 'simple' ? '逐表寫' : d.mode === 'blob' ? '整份寫入（舊路線）' : d.mode ? esc(d.mode) : '（後端太舊，未回報）'}`
      + ((d.simpleRows || d.blobRows) ? ` · 「資料表」${Number(d.simpleRows || 0)} 行＋「資料庫」${Number(d.blobRows || 0)} 行` : '')] : null,
    (d.broken || []).length ? ['讀唔到嘅表', `<b style="color:var(--danger)">${esc(d.broken.join('、'))}</b>（其餘表唔受影響）`] : null,
    ['接線方式', d.route === 'proxy' ? '平台伺服器端（/api/proxy）' : d.route === 'direct' ? '你自己貼嘅 /exec' : '—'],
    ['後端最後更新', esc(when(d.at)) || '（未知）'],
    /* 「後端版本 ≠ 呢部機對上一次同步嘅版本」＝ 有第二部機寫過（呢個係正常，但要講） */
    d.version && baseV ? ['後端版本係咪呢部機上次同步嗰個', d.version === baseV
      ? '<span class="badge b-ok">係</span>'
      : '<span class="badge b-warn">唔係 —— 有另一部機寫過</span>'] : null,
    ['後端資料庫大小', d.bytes ? fmtBytes(d.bytes) : '—'],
    /* ★「新儲嘅讀唔到」嘅經典死因：資料庫分頁有幾套版本段／垃圾行 */
    versionSets > 1 || junkRows > 0 ? ['「資料庫」分頁嘅版本段',
      `<b style="color:var(--warn)">${versionSets} 套（其中 ${junkRows} 行係舊段）</b>`] : null,
    staging > 0 ? ['暫存垃圾行', `<b style="color:var(--warn)">${staging} 行</b>`] : null,
    ['呢部機未寫入', pend ? `<b style="color:${pendAcc ? 'var(--danger)' : 'var(--warn)'}">${pend} 項${pendAcc ? `（包括 ${pendAcc} 個帳戶）` : ''}</b>` : '<span class="badge b-ok">全部已儲存</span>']
  ].filter(Boolean);

  return head + `
    <div class="note-box ${v.level === 'ok' ? '' : v.level === 'warn' ? 'warn' : 'danger'} mb-12">${icon(v.level === 'ok' ? 'check' : 'alert', 15)}<div>
      <b>${esc(v.title || '')}</b>
      <div class="xs mt-4">${esc(v.detail || '')}</div>
    </div></div>

    <div class="kv mb-12">${facts.map(([k, val]) => `<div class="kv-row sm"><span>${k}</span><span>${val}</span></div>`).join('')}</div>

    <div class="scroll-x">
      <table class="table table-compact">
        <thead><tr><th>資料</th><th class="right">呢部機</th><th class="right">後端</th><th class="center" style="width:60px">一樣？</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${(versionSets > 1 || junkRows > 0 || staging > 0) ? `<div class="note-box warn mt-12">${icon('alert', 15)}<div>
      <b>「資料庫」分頁累積咗垃圾 —— 呢個正正係「新儲嘅完全讀唔到」嘅死因。</b>
      <div class="xs mt-4">而家讀取會自動淨揀最新一套完整段，所以暫時讀到；但分頁會越嚟越大，
      遲早讀寫一齊死。去「總表同步」撳<b>「修復後端」</b>清走（只刪舊段同垃圾行，最新一套資料一行都唔會掂）。</div>
    </div></div>` : ''}

    ${d.verdict?.level === 'ok' ? `<div class="note-box info mt-12">${icon('info', 15)}<div>
      <b>如果第二部機（或者無痕）睇到嘅仲係舊嘢 —— 照呢個次序 check：</b>
      <div class="xs mt-4">① 上面個<b>試算表名</b>係唔係你開緊嗰張（平台登記嘅 /exec 有可能指咗去第二張表）；<br>
        ② 第二部機係唔係揀咗<b>另一個旅團編號</b>（網址 ?u=）；<br>
        ③ 第二部機如果一早開住 app，佢<b>唔會自己刷新</b> —— 撳頂部「<b>重新載入</b>」（或者重新登入）就會拉到呢一份；<br>
        ④ 上面「後端版本係咪呢部機上次同步嗰個」若果係「唔係」＝ 仲有第三部機寫過。</div>
    </div></div>` : ''}

    ${p ? `<div class="note-box ${p.matched ? '' : 'danger'} mt-12">${icon(p.matched ? 'check' : 'alert', 15)}<div>
      <b>一寫一讀驗證：${p.matched ? '成功 —— 寫入同讀取都通 ✓' : '失敗'}</b>
      <div class="xs mt-4">${esc(probeText(p))}</div>
    </div></div>` : ''}

    ${actions}
  </div></div>`;
}

function probeText(p) {
  if (!p) return '';
  if (!p.ok && p.error) return `${p.error}${p.hint ? `　${p.hint}` : ''}`;
  if (p.matched) {
    return `我哋寫咗個記號落後端（${p.nonce}），再讀返出嚟 —— 後端回嘅記號一模一樣。`
      + `寫入 ${p.writeMs}ms、讀取 ${p.readMs}ms${p.sheet ? `；寫入緊「${p.sheet}」` : ''}。`
      + `即係：呢部機啲嘢**真係寫到入後端，亦讀得返**。`
      + (p.cleanedUp ? '（記號已經清走）' : (p.cleanupError ? `（⚠ 記號未清到：${p.cleanupError}）` : ''));
  }
  return `寫入話成功（版本 ${p.savedVersion || '?'}），但讀返出嚟搵唔到我哋個記號`
    + `${p.seen ? `（後端嗰個係 ${p.seen}）` : '（後端完全冇記號）'}。`
    + `呢個正正就係「寫到但讀唔到」—— 多數係資料庫太大（讀取撞 4.5MB 上限）`
    + `或者後端 Code.gs 太舊。去「總表同步」撳「檢查後端」睇詳細。`;
}

/** 純文字版結果（複製去 WhatsApp／電郵畀管理員） */
export function realityText() {
  const d = lastReality;
  if (!d) return '';
  const tag = { ok: '[對得上]', warn: '[要處理]', bad: '[斷咗]' };
  const lines = [
    `深資童軍管理系統 後端實況（旅團 ${d.unit || load()?.unitCode || ''}）`,
    `${tag[d.verdict?.level] || ''} ${d.verdict?.title || ''}`,
    d.verdict?.detail || '',
    d.sheet ? `寫入緊嘅試算表：${d.sheet}` : '',
    `後端版本：${d.backendVersion || '（後端太舊／未回報）'}　接線：${d.route || '-'}`,
    (d.mode || d.simpleRows || d.blobRows)
      ? `儲存模式：${d.mode === 'simple' ? '逐表寫' : d.mode === 'blob' ? '整份寫入' : d.mode}　正本行數：資料表 ${Number(d.simpleRows || 0)} 行＋資料庫 ${Number(d.blobRows || 0)} 行${(d.broken || []).length ? `　讀唔到：${d.broken.join('、')}` : ''}`
      : '',
    `後端最後更新：${when(d.at) || '（未知）'}　大小：${d.bytes ? fmtBytes(d.bytes) : '-'}`,
    '',
    '資料　　　　本機　後端',
    ...(d.rows || []).map(r => `${r.label}　${r.local}　${r.backend === null ? '-' : r.backend}　${r.same === null ? '' : r.same ? '✓' : '✗'}`),
    '',
    `呢部機未寫入：${Number(load()?.sync?.pending || 0)} 項` +
      `${Number(load()?.sync?.pendingAccounts || 0) ? `（包括 ${load().sync.pendingAccounts} 個帳戶）` : ''}`
  ];
  if (lastProbe) lines.push('', '一寫一讀驗證：' + probeText(lastProbe));
  return lines.filter(l => l !== undefined).join('\n');
}

/* ---------------- 掣 ---------------- */
export function mountRealityCard(root) {
  const btns = root.querySelectorAll('[data-act]');

  root.querySelectorAll('[data-act="reality-check"]').forEach(b => b.addEventListener('click', async () => {
    if (realityRunning) return;
    realityRunning = true;
    const old = b.innerHTML;
    b.disabled = true; b.textContent = '核對緊…';
    try {
      const remote = await import('../lib/remote.js');
      lastReality = await remote.backendReality();
      toast(lastReality.verdict?.title || '已核對', lastReality.verdict?.level === 'ok' ? 'ok' : 'warn');
    } catch (e) {
      lastReality = {
        ok: false, rows: [],
        verdict: { level: 'bad', title: '核對失敗', detail: String(e?.message || e) }
      };
      toast('核對失敗：' + (e?.message || e), 'err');
    } finally {
      realityRunning = false;
      b.disabled = false; b.innerHTML = old;
      try { window.dispatchEvent(new CustomEvent('v82:refresh')); } catch { /* ignore */ }
    }
  }));

  root.querySelectorAll('[data-act="reality-write-read"]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    const old = b.innerHTML;
    b.textContent = '測試緊…';
    try {
      const remote = await import('../lib/remote.js');
      const r = await remote.testReadWrite();
      await modal({
        title: r.ok ? '✓ 寫入和讀回都成功' : '⚠ 接線讀寫失敗',
        body: `<div class="note-box ${r.ok ? '' : 'danger'}"><div>${esc(r.ok ? r.message : (r.error || '未知原因'))}</div></div>
          ${r.sheet ? `<p class="sm">試算表：${esc(r.sheet)}</p>` : ''}
          ${r.version ? `<p class="sm">後端：${esc(r.version)}</p>` : ''}
          ${r.hint ? `<p class="sm">${esc(r.hint)}</p>` : ''}
          <p class="xs muted">此測試不碰帳戶或資料庫；成功後仍須儲存一筆正式資料，再用新裝置讀回驗收。</p>`,
        actions: [{ label: '知道了', class: 'btn-primary', value: true }]
      });
    } finally { b.disabled = false; b.innerHTML = old; }
  }));

  root.querySelectorAll('[data-act="reality-probe"]').forEach(b => b.addEventListener('click', async () => {
    if (probeRunning) return;
    const remote = await import('../lib/remote.js');
    const yes = await modal({
      title: '一寫一讀驗證',
      sub: '證明「寫入後端」同「由後端讀返」兩條路都通',
      body: `<p class="sm">會做三件事：</p>
        <ol class="sm" style="padding-left:18px;line-height:1.9">
          <li>喺資料庫 meta 寫一個<b>記號</b>（唔係正式紀錄，唔會影響團員／帳目）</li>
          <li>行<b>同一條</b>寫入路（頂部「儲存到後端」嗰條）送出</li>
          <li>再由後端<b>讀返</b>成份資料庫出嚟，核對個記號一唔一樣</li>
        </ol>
        <p class="sm">對得上 ＝ <b>寫入同讀取都真係通</b>。完咗會自動清走個記號（會多寫一次）。</p>
        <div class="note-box warn mt-8">${icon('alert', 15)}<div class="sm">
          <b>注意：</b>呢個動作會<b>真的寫入後端兩次</b>（寫記號 ＋ 清記號）。
          如果你有改動未寫入，佢會連埋一齊寫上去。</div></div>`,
      actions: [{ label: '取消', class: 'btn', value: false }, { label: '開始驗證', class: 'btn-primary', value: true }]
    });
    if (!yes) return;
    probeRunning = true;
    const old = b.innerHTML;
    b.disabled = true; b.textContent = '驗證緊…';
    try {
      lastProbe = await remote.syncProbe({ cleanup: true });
      lastReality = await remote.backendReality();
      await modal({
        title: lastProbe.matched ? '✓ 寫入同讀取都通' : '⚠ 有嘢唔對',
        body: `<div class="note-box ${lastProbe.matched ? '' : 'danger'} mb-12">${icon(lastProbe.matched ? 'check' : 'alert', 15)}<div>
            <b>${lastProbe.matched ? '後端收得到我哋寫嘅嘢，我哋亦讀得返' : '驗證失敗'}</b></div></div>
          <p class="sm">${esc(probeText(lastProbe))}</p>`,
        actions: [{ label: '知道喇', class: 'btn-primary', value: true }]
      });
    } catch (e) {
      toast('驗證失敗：' + (e?.message || e), 'err');
    } finally {
      probeRunning = false;
      b.disabled = false; b.innerHTML = old;
      try { window.dispatchEvent(new CustomEvent('v82:refresh')); } catch { /* ignore */ }
    }
  }));

  root.querySelectorAll('[data-act="reality-copy"]').forEach(b => b.addEventListener('click', async () => {
    const txt = realityText();
    if (!txt) { toast('未核對過 —— 先撳「即刻核對」', 'warn'); return; }
    if (await copyText(txt)) toast('已複製後端實況（可以直接貼畀平台管理員）', 'ok');
    else {
      await modal({
        title: '後端實況',
        body: `<pre class="sm" style="white-space:pre-wrap">${esc(txt)}</pre>`,
        actions: [{ label: '知道喇', class: 'btn-primary', value: true }]
      });
    }
  }));

  void btns;
}
