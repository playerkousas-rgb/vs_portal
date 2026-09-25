/* ============================================================
   syncdialog.js — 「儲存到後端」嘅衝突確認對話框
   ------------------------------------------------------------
   團長 2026-09-20：
     「如果一個登記早走、一個登記遲到，就要警告用戶嗰一點因為唔同，
       所以冇儲存進後端，請再確認；如果佢再確認就確認洗掉，
       因為始終我而家係時間點較後，可能真係更改咗選項。」

   所以呢個框：
     · 列出每一格：邊個模組 › 邊筆紀錄 › 邊格；你嘅值 vs 後端嘅值
     · 預設**唔剔** ＝ 保留後端（呢啲格已經係後端版本，冇寫入你嘅）
     · 剔咗 ＝ 用你嘅蓋過去；「全部用我嘅」一掣搞掂
     · 關閉／取消 ＝ 保留後端（唔會再問；改動已經冇咗，等如你冇改過嗰格）
   ============================================================ */
import { modal, esc, icon, toast, toastAction, confirmDlg } from '../lib/util.js';
import { describeConflict } from '../lib/merge3.js';

/**
 * @param {object} p
 *   conflicts   remote.saveToBackend / loadFromBackend 回嘅 conflicts
 *   ctx         { local, remote }（搵名用）
 *   mode        'save'（已寫咗其餘、呢啲未寫） | 'login'（登入時發現上次未存嘅改動撞咗）
 *   remoteAt    後端最後儲存時間
 *   savedCount  今次已經寫入嘅（唔撞嘅）改動數
 * @returns {Promise<{useMine:string[]}|null>}
 */
export async function resolveConflictsDialog({ conflicts = [], ctx = {}, mode = 'save', remoteAt = '', savedCount = 0 } = {}) {
  if (!conflicts.length) return { useMine: [] };
  const rows = conflicts.map(c => ({ key: c.key, ...describeConflict(c, ctx) }));
  const when = String(remoteAt || '').slice(0, 19).replace('T', ' ');
  const intro = mode === 'login'
    ? `你上次有改動未儲存就離開咗。後端喺呢段時間有人儲存過${when ? `（${when}）` : ''}。
       唔撞嘅改動已經保留喺呢部機（記得撳「儲存到後端」）；下面 <b>${rows.length}</b> 格你同對方改咗<b>唔同嘅嘢</b>，
       暫時用咗後端版本 —— 要用返你嘅就剔佢。`
    : `後端喺你登入之後有人儲存過${when ? `（${when}）` : ''}。
       ${savedCount ? `你其餘 <b>${savedCount}</b> 項改動已經寫入後端；` : ''}但下面 <b>${rows.length}</b> 格你同對方改咗<b>唔同嘅嘢</b>，
       所以<b>未寫入</b>，請再確認：剔咗嘅會用你嘅蓋過去，冇剔嘅保留後端。`;

  const body = `
    <div class="note-box warn mb-12">${icon('alert', 15)}<div>${intro}</div></div>
    <div class="row gap-8 mb-8" style="justify-content:flex-end">
      <button class="btn btn-xs" type="button" data-all="1">${icon('check', 12)} 全部剔（用我嘅）</button>
      <button class="btn btn-xs" type="button" data-all="0">全部唔剔（保留後端）</button>
    </div>
    <div style="max-height:52vh;overflow:auto;border:1px solid var(--line-2);border-radius:10px">
    <table class="table table-compact" style="font-size:13px">
      <thead><tr>
        <th style="width:34px"></th>
        <th>邊度</th>
        <th>你（呢部機）</th>
        <th>後端（對方）</th>
      </tr></thead>
      <tbody>
        ${rows.map((r, i) => `<tr>
          <td class="center"><input type="checkbox" data-k="${esc(r.key)}" id="cf${i}" aria-label="用我嘅"></td>
          <td><label for="cf${i}" style="cursor:pointer">
            <div><b>${esc(r.module)}</b>${r.record ? ` › ${esc(r.record)}` : ''}</div>
            ${r.field ? `<div class="xs muted">${esc(r.field)}</div>` : ''}</label></td>
          <td style="color:var(--brand-700)"><b>${esc(r.mineText)}</b></td>
          <td class="muted">${esc(r.theirsText)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <div class="hint mt-8">${icon('shield', 13)} 剔咗 ＝ 你確認要用你嘅蓋過對方。冇剔 ＝ 保留對方嘅（你嗰格嘅改動會作廢）。</div>`;

  const r = await modal({
    title: mode === 'login' ? '上次未儲存嘅改動：有幾格同後端唔同' : `已儲存，但有 ${rows.length} 格同後端唔同 —— 請再確認`,
    sub: '同一格兩邊改咗唔同嘅值 —— 系統唔會自己揀，等你話事',
    wide: true,
    body,
    onMount: (el) => {
      el.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => {
        const on = b.dataset.all === '1';
        el.querySelectorAll('input[data-k]').forEach(x => { x.checked = on; });
      }));
    },
    actions: [
      { label: '保留後端嘅（全部）', class: 'btn', value: { useMine: [] } },
      { label: '確認：剔咗嘅用我嘅蓋過去', class: 'btn-primary',
        onClick: (el) => ({ useMine: Array.from(el.querySelectorAll('input[data-k]:checked')).map(x => x.dataset.k) }) }
    ]
  });
  return r || { useMine: [] };
}

/** 儲存結果 → 一句人話（toast 用）
 *  ★ 一定要講清楚「寫咗去邊」—— 團長回報「話已寫入但張 Sheet 完全冇嘢」，
 *  唔係冇寫入，係佢開 Sheet 睇嘅係**攤平報表分頁**（團員／帳目／物資…），
 *  而 saveDb 寫嘅係「資料庫」分頁（分段 JSON）。以前呢兩處要分開撳兩粒掣，
 *  所以睇落似「寫咗但完全冇嘢」。而家一次過做晒，而且訊息會講明寫咗去邊。 */
export function saveResultText(r) {
  if (!r) return '儲存失敗';
  if (!r.ok) return '儲存失敗：' + (r.error || '未知錯誤') + (r.hint ? `（${r.hint}）` : '');
  const bits = [];
  if (r.remoteChanged) {
    bits.push(`後端喺你登入後有人儲存過 —— 對方 ${r.theirs || 0} 項、你 ${r.mine || 0} 項${r.same ? `（${r.same} 項相同）` : ''}`);
  }
  if (r.conflicts?.length) {
    if (r.resolved) bits.push(`${r.resolved} 項已按你確認蓋過${r.kept ? `，${r.kept} 項保留後端` : ''}`);
    else bits.push(`${r.conflicts.length} 項衝突保留咗後端版本`);
    if (r.overrideOk === false) bits.push('（蓋過嗰次寫入失敗：' + (r.overrideError || '未知') + '）');
  }
  const where = [];
  if (r.bytes) where.push(`「資料庫」分頁 ${r.bytes >= 1048576 ? (r.bytes / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(r.bytes / 1024)) + ' KB'}`);
  if (r.parts) where.push(`分 ${r.parts} 件寫入`);
  if (r.reportOk === true) where.push(`報表分頁已更新（${r.reportCount ?? 0} 筆，團員／帳目…嗰啲分頁而家有嘢睇）`);
  else if (r.reportOk === false) where.push(`⚠ 報表分頁未更新（${r.reportMsg || '未知'}）—— 資料本身已經存到，去「總表同步」撳「更新報表分頁」再試`);
  bits.push('已儲存到後端 ✓' + (where.length ? `（${where.join(' · ')}）` : ''));
  return bits.join('；');
}

/* ============================================================
   成個 app 共用嘅兩個動作（頂部掣、總表同步頁、團章發佈、通告同步 …… 全部行呢度）
   ============================================================ */

/**
 * 「儲存到後端」—— 唯一寫入路：
 *   核對版本 → 三方比對 → 先寫唔撞嘅 → 撞嘅彈框問 → 確認咗先蓋
 * @returns {Promise<object>} remote.saveToBackend 嘅結果
 */
/**
 * 「收據」—— 寫入之後**即刻向後端再問一次**，證明啲嘢真係喺後端。
 * ------------------------------------------------------------
 * ★ 2026-09-24 團長：「我完全不知道他能不能寫進後端，要是能寫進為什麼讀不到」。
 *   以前撳完「儲存到後端」只會彈一個一閃就冇嘅 toast，講「已儲存到後端 ✓」，
 *   但冇任何嘢證明後端**真係**有嗰份嘢 —— 團長開 Google Sheet 見到空白，
 *   自然就覺得「根本冇寫到」。
 *   而家：寫完 → 問後端「你而家係咩版本、有幾多用戶／帳目」→
 *   同本機對一次 → 用一個對數表答你「對得上／對唔上」。
 */
export async function showSaveReceipt(r) {
  const remote = await import('../lib/remote.js');
  let v = null;
  try { v = await remote.verifyAgainstBackend(r?.version || ''); }
  catch (e) { v = null; }

  const okAll = !!v?.ok && !!v?.matched;
  const rows = (v?.rows || []).map(x => `<tr>
      <td>${esc(x.label)}</td>
      <td class="right mono">${x.local}</td>
      <td class="right mono">${x.backend === null ? '<span class="faint">（冇）</span>' : x.backend}</td>
      <td class="center">${x.same === null ? '—' : x.same ? '<span style="color:var(--ok);font-weight:700">✓</span>' : '<span style="color:var(--danger);font-weight:700">✗</span>'}</td>
    </tr>`).join('');

  const body = `
    ${v ? `
      <div class="note-box ${okAll ? '' : 'danger'} mb-12">${icon(okAll ? 'check' : 'alert', 15)}<div>
        <b>${okAll ? '已寫入後端，而且核對過 —— 後端而家同你部機一樣 ✓' : '寫入回傳成功，但核對嗰陣對唔上'}</b>
        <div class="xs mt-4">${okAll
          ? '即係：第二部機（甚至無痕視窗）登入就會見到呢一份。'
          : (v.ok
            ? '後端而家嘅版本／筆數同你部機唔同。多數係「寫完之後又有另一部機寫過」，或者後端讀取有問題（例如資料庫太大讀唔返）。'
            : `核對嗰陣讀唔到後端：${esc(v.error || '')}`)}
        </div>
      </div></div>
      <div class="kv mb-12">
        ${v.sheet ? `<div class="kv-row sm"><span>寫入緊嘅試算表</span><span><b>${esc(v.sheet)}</b></span></div>` : ''}
        <div class="kv-row sm"><span>後端版本</span><span class="mono xs">${esc(v.version || '（未知）')}</span></div>
        <div class="kv-row sm"><span>寫入嗰陣後端畀嘅版本</span><span class="mono xs">${esc(v.expectedVersion || '（未知）')}</span></div>
        <div class="kv-row sm"><span>後端最後更新</span><span>${esc(String(v.at || '').slice(0, 19).replace('T', ' '))}</span></div>
        <div class="kv-row sm"><span>寫入路線</span><span class="xs">${r?.mode === 'simple'
          ? '<b>逐表寫</b>（一個表一個請求 —— 壞一個表唔會連累其他表）'
          : '整份寫入（舊路線；後端 Code.gs 未更新到 v2.8.0）'}</span></div>
        ${v.bytes ? `<div class="kv-row sm"><span>後端資料庫大小</span><span>${esc(remote.fmtBytes(v.bytes))}</span></div>` : ''}
      </div>
      <div class="scroll-x">
        <table class="table table-compact">
          <thead><tr><th>資料</th><th class="right">呢部機</th><th class="right">後端</th><th class="center" style="width:60px">一樣？</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="hint mt-8">${icon('info', 13)}
        我哋點核對：寫完之後<b>即刻再問後端</b>「你而家係咩版本、有幾多用戶／帳目」，
        同呢部機對一次。版本一樣 ＋ 筆數一樣 ＝ 真係寫咗入去。
        ${v.sheet ? '如果你開 Google Sheet 睇唔到團員／帳目，請對一對上面個<b>試算表名</b>係唔係你開緊嗰張。' : ''}</div>
      ${okAll ? `<div class="note-box info mt-12">${icon('info', 15)}<div>
        <b>後端已經有呢份 —— 如果第二部機（或者無痕）睇到嘅仲係舊嘢：</b>
        <div class="xs mt-4">① 對一對上面個<b>試算表名</b>；② 第二部機係唔係揀咗另一個旅團編號（網址 <code>?u=</code>）；
        ③ 第二部機如果一早開住 app，佢<b>唔會自己刷新</b> —— 喺嗰部機撳頂部「<b>重新載入</b>」（或者重新登入）就會見到呢一份。</div>
      </div></div>` : ''}
    ` : `
      <div class="note-box warn mb-12">${icon('alert', 15)}<div>
        <b>寫入成功，但核對唔到（讀唔到後端）</b>
        <div class="xs mt-4">你嘅資料已經送出，後端亦冇報錯。不過而家讀唔到後端狀態，
        所以未能證明後端而家有乜 —— 可以遲啲去「系統 → 資料管理」撳「即刻核對」再驗一次。</div>
      </div></div>
    `}`;

  return modal({
    title: okAll ? '✓ 已寫入後端（已核對）' : '寫入後核對',
    sub: '「寫咗」同「寫咗去邊、後端有冇」係兩件事 —— 呢張收據答第二件',
    wide: true,
    body,
    actions: [
      { label: '去睇後端實況', class: 'btn', value: 'reality' },
      { label: '知道喇', class: 'btn-primary', value: true }
    ]
  }).then(choice => {
    if (choice === 'reality') {
      try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch { /* ignore */ }
      location.hash = '#/tables/sync';
    }
    return choice;
  });
}

export async function saveWithDialog({ silent = false, toastOk = true, receipt = false } = {}) {
  const remote = await import('../lib/remote.js');
  if (!remote.remoteConfigured()) {
    toast('未設定後端 —— 去「系統 → 資料管理 → 總表同步」', 'err');
    return { ok: false, reason: 'not_configured' };
  }
  const r = await remote.saveToBackend({ policy: 'ask', resolver: resolveConflictsDialog, silent });
  if (r.ok) {
    /* ★ 儲存成功之後，順手刷新埋「睇得明」嘅報表分頁（pushToMaster，帶 skipDb）。
       團長回報「佢話已寫入，但後端完全冇嘢」就係死喺呢度：
       saveDb 淨係寫「資料庫」分頁（分段 JSON，人睇唔明），
       而團員／帳目／物資…嗰啲攤平分頁要另外撳「更新報表分頁」先會填 ——
       所以撳完「儲存到後端」再開張 Google Sheet，睇到嘅係一片空白。
       而家一粒掣做齊兩處（仍然只有一條 db 寫入路：pushToMaster 帶 skipDb，唔會碰 db）。 */
    const backendReports = (r.reports && typeof r.reports === 'object') ? r.reports : null;
    if (backendReports && backendReports.ok === true) {
      /* v2.6.3 之後嘅 Code.gs 喺同一次請求入面已經刷新晒報表分頁 ——
         唔使再發第二次（慳一半 GAS 配額，亦都唔會出現「兩邊寫法唔同」）。 */
      const counts = backendReports.counts || {};
      r.reportOk = true;
      r.reportBy = 'backend';
      r.reportCount = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
      r.reportMsg = '';
    } else {
      /* 舊版 Code.gs（冇 reports）或者後端刷新失敗 → 前端自己補做一次 */
      try {
        const { pushToMaster } = await import('./tables.js');
        const rep = await pushToMaster({ silent: true });
        r.reportOk = !!rep?.ok;
        r.reportBy = 'frontend';
        r.reportMsg = rep?.ok ? '' : String(rep?.msg || rep?.error || (backendReports?.error || '未知'));
        r.reportCount = Number(rep?.total || 0);
      } catch (e) {
        r.reportOk = false;
        r.reportMsg = String(e?.message || e).slice(0, 120);
      }
    }
    if (toastOk || r.remoteChanged || r.conflicts?.length) toast(saveResultText(r), 'ok');
    /* 後端有對方改動 → 本機已經併入 → 畫面要重畫 */
    if (r.remoteChanged) { try { window.dispatchEvent(new CustomEvent('v82:refresh')); } catch { /* ignore */ } }
    /* ★ 2026-09-24：團長「我完全不知道他能不能寫進後端」——
       撳完掣一定要**俾證據**：寫完即刻問後端一次，用對數表答「寫咗去邊、後端有冇」。 */
    if (receipt) {
      try { await showSaveReceipt(r); } catch (e) { console.warn('[sync] 收據核對失敗', e); }
    }
  } else if (r.reason === 'no_base') {
    toastAction(r.error, '重新載入', () => reloadFromBackend({ force: false }), 'err');
  } else if (r.reason !== 'busy') {
    toast(saveResultText(r), 'err');
  }
  return r;
}

/**
 * 「由後端重新載入」：冇未儲存改動 → 直接載入；有 → 先確認會丟棄
 */
export async function reloadFromBackend({ force = false } = {}) {
  const remote = await import('../lib/remote.js');
  if (!remote.remoteConfigured()) { toast('未設定後端', 'err'); return { ok: false, reason: 'not_configured' }; }
  const { tryLoad } = await import('../lib/store.js');
  const pending = Number(tryLoad()?.sync?.pending || 0);
  let r;
  if (pending > 0) {
    if (!force) {
      const ok = await confirmDlg({
        title: '丟棄未儲存嘅改動？',
        message: `呢部機仲有 <b>${pending}</b> 項改動未儲存到後端。重新載入會<b>全部丟棄</b>，成份用返後端而家嗰份。<br><br>想保留就撳「取消」，再撳「儲存到後端」。`,
        okText: '丟棄並重新載入', cancelText: '取消', danger: true
      });
      if (!ok) return { ok: false, reason: 'cancelled' };
    }
    r = await remote.discardAndReload();
  } else {
    r = await remote.loadFromBackend();
  }
  if (r.ok) {
    toast(r.found === false ? '後端仲未有資料 —— 撳「儲存到後端」建立第一份' : '已由後端載入最新資料', 'ok');
    try { window.dispatchEvent(new CustomEvent('v82:refresh')); } catch { /* ignore */ }
  } else {
    toast('載入失敗：' + (r.error || '未知錯誤') + (r.hint ? `（${r.hint}）` : ''), 'err');
  }
  return r;
}
