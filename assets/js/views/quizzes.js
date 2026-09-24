/* 試卷：執委新設／匯入（Google Form 題目／CSV），團員喺團員入口填 */
import { collection, find, add, update, remove } from '../lib/store.js';
import { memberName } from '../lib/model.js';
import { esc, icon, uid, todayISO, toast, confirmDlg } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can } from '../lib/auth.js';
import { pageHead, tabs, empty, noteBox, visSelect } from './ui.js';

let tab = 'list';

export function title() { return '試卷'; }
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

/* ---------- 題目文字解析 ----------
   三種食法：
   ① Google Form 列印 PDF 抽出嚟嘅文字（pdftext.js 會將選項行加兩格縮排）
   ② 人手貼嘅「1. 題目」＋「A. 選項」
   ③ CSV／TSV：題目,類型,選項（用 | 分隔）,必填 */
const QUIZ_JUNK = /^(?:[＊*]+\s*必填|必填|required|[＊*]+|提交|submit|清除表單|重新填寫|重新整理|取得連結|google[\s\S]{0,24}forms?|google[\s\S]{0,24}表單|docs\.google\.com\S*|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|電子郵件(?:地址)?|你(?:的|嘅)?電子郵件(?:地址)?|電郵地址|(?:區段|分區|章節)\s*\d+(?:\s*[/／]\s*共\s*\d+\s*個?(?:區段|分區)?)?|section\s+\d+(?:\s+of\s+\d+)?|從不提交密碼)\s*$/i;
const isNumberedQ = t => /^(?:\d+[.、)]|Q\d+[:：]?|題目[:：])/i.test(t);
const endsQuestion = t => /[?？]\s*$/.test(t);
const stripOptBullet = t => t.replace(/^(?:[([]?[A-Da-d][)\].、]\s*|[-•●○◯□■▪·◇◆]\s*)/, '').trim();
/* Google Form 列印 PDF 嘅說明／介紹行（2026-09-18 第 2 項要求）：
   「電子郵件地址」說明、「分區／區段」標題同介紹、版尾 Google 字眼……
   以前會被當成題目。真正嘅問題行通常有問號、有編號、或者帶「請填：」——
   呢個過濾器只會丟走又短、又冇問號、又唔係題目格式嘅 Forms 官方字眼。 */
const isFormsBoilerplate = t => {
  if (QUIZ_JUNK.test(t)) return true;
  if (endsQuestion(t) || isNumberedQ(t)) return false;
  const short = t.replace(/\s/g, '').length <= 50;
  if (short && /電子郵件|電郵地址|e-?mail/i.test(t) && !/[:：]/.test(t)) return true;
  if (short && /將不會公開|不會公開|唔會公開/.test(t)) return true;
  if (/^(?:區段|分區|章節|section)\s*\d/i.test(t)) return true;
  if (short && /google\s*(?:帳戶|account|表單|forms?)|此內容.{0,20}(?:google|建立)|未經.{0,8}google/i.test(t)) return true;
  if (/^\s*\d+\s*[/／]\s*\d+\s*$/.test(t)) return true;   // 「1/3」頁／區段進度
  return false;
};

export function parseQuizImport(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { title: '', questions: [], error: '空白內容' };
  const allLines = raw.split(/\r?\n/);
  const first = (allLines.find(l => l.trim()) || '').trim();
  const isCsv = (first.includes(',') || first.includes('\t')) && /題|question|title|類型|type/i.test(first);
  if (isCsv) {
    const lines = allLines.map(l => l.trim()).filter(Boolean);
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const split = row => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (c === '"') { q = !q; continue; }
        if (!q && c === delim) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    const head = split(lines[0]).map(h => h.toLowerCase());
    const iTitle = head.findIndex(h => /題|question|prompt|title/.test(h));
    const iType = head.findIndex(h => /類型|type/.test(h));
    const iOpts = head.findIndex(h => /選|option|choices/.test(h));
    const iReq = head.findIndex(h => /必|required/.test(h));
    const questions = [];
    lines.slice(1).forEach(row => {
      const cols = split(row);
      const prompt = cols[iTitle >= 0 ? iTitle : 0] || '';
      if (!prompt) return;
      const typeRaw = (cols[iType] || 'short').toLowerCase();
      let type = 'short';
      if (/多選|複選|核取|checkbox|multi/.test(typeRaw)) type = 'multi';
      else if (/單選|single|choice|radio|select/.test(typeRaw)) type = 'single';
      else if (/段落|長答|para|long/.test(typeRaw)) type = 'para';
      const opts = (cols[iOpts] || '').split(/[|;／、]/).map(s => s.trim()).filter(Boolean);
      questions.push({ id: uid('qq'), prompt, type, options: opts, required: /是|yes|1|true/i.test(cols[iReq] || '') });
    });
    if (!questions.length) return { title: '', questions, error: 'CSV 讀唔到題目（欄：題目,類型,選項,必填）' };
    return { title: '', questions, error: '' };
  }

  /* ---------- 純文字（PDF 抽出 或 人手貼） ---------- */
  const lines = allLines.map(l => {
    const m = l.match(/^\s+/);
    const indent = m && m[0].includes('\t') ? '  ' : (m ? ' '.repeat(Math.min(2, Math.ceil(m[0].length / 2) * 2)) : '');
    /* Forms 嘅必填星標：行頭／行尾嘅 * 都丟走 */
    return indent + l.trim().replace(/^[＊*]{1,2}\s*/, '').replace(/\s*[＊*]{1,2}$/, '');
  });
  const hasIndent = lines.some(l => /^ {2}\S/.test(l));

  const questions = [];
  let title = '';
  let cur = null;
  let pending = '';   // 題目斷行：等埋下一截

  const startQ = t => {
    /* 斷開嘅題目前半（pending）接返埋 —— 但如果前半以句號收尾，多數係描述，唔好黐埋 */
    const merged = pending && !/[。！？；;!?]$/.test(pending) && (pending + ' ' + t).length <= 120
      ? pending + ' ' + t : t;
    cur = { id: uid('qq'), prompt: merged, type: 'short', options: [], required: true };
    if (/核取|複選|多選|checkbox/i.test(cur.prompt)) cur.type = 'multi';
    questions.push(cur);
    pending = '';
  };
  const addOpt = t => {
    if (!cur) return;
    const clean = stripOptBullet(t);
    if (!clean) return;
    cur.options.push(clean);
    if (cur.type !== 'multi' && (/核取|複選|多選|checkbox/i.test(t) || /核取|複選|多選|checkbox/i.test(cur.prompt))) cur.type = 'multi';
    else if (cur.type === 'short' && cur.options.length > 1) cur.type = 'single';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    /* 「標題：xxx」／「試卷：xxx」直接入標題 */
    const tm = t.match(/^(?:標題|試卷)[:：]\s*(.+)/);
    if (tm) { if (!title) title = tm[1]; continue; }
    /* 垃圾行（必填／頁碼／提交／電郵地址說明／分區標題／Google Forms 版尾…）；
       問號結尾嘅照當題目 —— 2026-09-18 第 2 項要求 */
    if (!endsQuestion(t) && (isFormsBoilerplate(t) || /^\d{1,3}$/.test(t))) continue;
    const indented = hasIndent && /^ {2}\S/.test(line);

    /* PDF 抽出：縮排行＝揀緊嗰條題目嘅選項 */
    if (indented) {
      if (cur) addOpt(t);
      continue;
    }

    if (isNumberedQ(t) || endsQuestion(t)) { startQ(t); continue; }

    if (hasIndent) {
      const next = lines.slice(i + 1).find(x => x.trim());
      if (next && /^ {2}\S/.test(next)) { startQ(t); continue; }   // 下一行係選項 → 呢行係題目（可能冇問號）
      if (cur && !cur.options.length) { cur.prompt += ' ' + t; continue; }   // 題目斷行
      /* 未去到第一條題目之前嘅 body 行＝表單標題（第一行）或者其他介紹文字
         —— 介紹文字一律丟走，唔好畀佢黐落第一條題目度 */
      if (!cur) { if (!title) title = t; pending = ''; continue; }
      pending = t;                                                  // 可能係斷咗嘅題目前半，交畀 startQ 接
      continue;
    }

    /* 冇縮排資訊（人手貼）：一條題目後面跟住嘅連續短行當選項 */
    if (!cur) { if (!title) title = t; continue; }
    let j = i;
    const body = [];
    while (j < lines.length) {
      const x = lines[j].trim();
      if (!x || isFormsBoilerplate(x) || isNumberedQ(x) || endsQuestion(x)) break;
      body.push(x);
      j++;
    }
    if (body.length >= 2) { body.forEach(addOpt); i = j - 1; continue; }
    if (body.length === 1 && /^[([]?[A-Da-d][)\].、]\s*|^[-•●○◯□■▪·]/.test(body[0])) { addOpt(body[0]); i = j - 1; continue; }
    if (isFormsBoilerplate(t)) continue;                            // 分區之間嘅介紹文字：丟走
    if (!cur.options.length && cur.prompt.length + t.length < 120) { cur.prompt += ' ' + t; continue; }
    /* 唔識分類嘅行：略過 */
  }

  const qs = questions.filter(q => q.prompt.trim());
  if (!qs.length) {
    return { title, questions: qs, error: '讀唔到題目。可以：① 上載 Google Form 列印 PDF；② 貼「1. 題目」加「A. 選項」；③ 貼 CSV（題目,類型,選項,必填）。' };
  }
  return { title, questions: qs, error: '' };
}

export function render(params) {
  if (['list', 'import'].includes(params.id)) tab = params.id;
  else if (params.id === 'new') return editor(null);
  else if (params.id && params.action === 'edit') return editor(find('quizzes', params.id));
  else if (params.id) return detail(params.id);
  return `
  ${pageHead({
    title: '試卷',
    sub: '新設試卷或匯入 Google 表單題目。團員喺「團員入口」填，唔使執委帳號。',
    actions: can('quiz.edit') ? `<button class="btn btn-sm btn-primary" data-go="#/quizzes/new">${icon('plus', 15)} 新設試卷</button>` : ''
  })}
  ${tabs([['list', '試卷', collection('quizzes').length], ['import', '匯入']], tab)}
  ${tab === 'import' ? importView() : listView()}`;
}

function listView() {
  const rows = collection('quizzes').slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!rows.length) return empty('note', '未有試卷', '新設，或者由 Google Form 匯入題目');
  return `<div class="card"><div class="scroll-x"><table class="table">
    <thead><tr><th>試卷</th><th>題數</th><th>已交</th><th>狀態</th></tr></thead>
    <tbody>${rows.map(q => `<tr data-open="${q.id}" style="cursor:pointer">
      <td><div class="semibold sm">${esc(q.title)}</div><div class="xs faint">${esc(q.note || '')}</div></td>
      <td>${(q.questions || []).length}</td>
      <td>${Object.keys(q.responses || {}).length}</td>
      <td>${q.status === 'closed' ? '<span class="badge b-grey">已關閉</span>' : '<span class="badge b-ok">開放</span>'}</td>
    </tr>`).join('')}</tbody></table></div></div>`;
}

const TYPE_LABEL = { short: '短答', para: '段落', single: '單選', multi: '多選' };

function importView() {
  return `<div class="card card-pad" style="max-width:760px">
    ${noteBox('<b>最方便：</b>喺 Google 表單右上 ⋮ →「列印」→ 另存 PDF，跟住喺下面<b>上載個 PDF</b>，'
      + '系統會自動抽出題目同選項（認唔出單選／多選會當「單選」，匯入後喺編輯器逐題改就得）。'
      + '亦可以貼 CSV／文字。', 'brand')}
    <div class="row gap-8 wrap mt-12">
      <label class="btn btn-primary" style="cursor:pointer">${icon('upload', 15)} 上載 Google Form PDF（或 .txt／.csv）
        <input type="file" accept=".pdf,.txt,.csv,text/plain,application/pdf" style="display:none" data-qz-upload></label>
      <span class="xs faint">唔会上載去邊度 —— PDF 喺你自己部機入面解析，只有抽出嘅文字會變成試卷。</span>
    </div>
    <div class="field mt-12"><label class="label">題目文字（可以改完再匯入）</label>
      <textarea class="textarea" id="qz-import" rows="12" placeholder="標題：週會小測&#10;1. 旅團格言係？&#10;A. 準備&#10;B. 日行一善&#10;2. 你嘅小隊？"></textarea>
      <div class="hint">CSV 欄：題目,類型（short／single／multi／para）,選項（用 | 分隔）,必填</div></div>
    <div id="qz-preview" class="mt-12"></div>
    <button class="btn btn-primary mt-12" data-act="do-import">${icon('upload', 15)} 匯入成新試卷</button>
  </div>`;
}

/** 匯入預覽：即時話畀你知會匯出幾多題、乜類型 */
function refreshImportPreview(root) {
  const box = root.querySelector('#qz-preview');
  if (!box) return;
  const parsed = parseQuizImport(root.querySelector('#qz-import')?.value || '');
  if (parsed.error) {
    box.innerHTML = `<div class="hint" style="color:var(--warn)">${icon('alert', 14)} ${esc(parsed.error)}</div>`;
    return;
  }
  box.innerHTML = `
    <div class="note-box ok">${icon('check', 15)}<div>讀到 <b>${parsed.questions.length}</b> 題${parsed.title ? ` · 標題：<b>${esc(parsed.title)}</b>` : ''}。撳「匯入成新試卷」就開得一張，入到去仲可以逐題改。</div></div>
    <ol class="sm mt-8" style="padding-left:20px;line-height:1.9">
      ${parsed.questions.map(q => `<li>${esc(q.prompt)}
        <span class="faint xs">（${TYPE_LABEL[q.type] || q.type}${q.options.length ? ` · ${q.options.length} 個選項：${q.options.join('／')}` : ''}）</span></li>`).join('')}
    </ol>`;
}

function editor(q) {
  const d = q || { title: '', note: '', status: 'open', questions: [{ id: uid('qq'), prompt: '', type: 'short', options: [], required: true }] };
  const qs = d.questions && d.questions.length ? d.questions : [{ id: uid('qq'), prompt: '', type: 'short', options: [], required: true }];
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/quizzes">${icon('chevronL', 15)} 返回</button></div>
  ${pageHead({ title: q ? '編輯試卷' : '新設試卷' })}
  <div class="card card-pad" style="max-width:760px">
    <div class="field"><label class="label">名稱</label><input class="input" id="qz-title" value="${esc(d.title)}"></div>
    <div class="field mt-12"><label class="label">說明（團員睇到）</label><textarea class="textarea" id="qz-note" rows="3">${esc(d.note || '')}</textarea></div>
    <div class="grid g-2 mt-12" style="gap:12px">
      <div class="field"><label class="label">狀態</label>
        <select class="select" id="qz-status"><option value="open" ${d.status !== 'closed' ? 'selected' : ''}>開放填寫</option>
          <option value="closed" ${d.status === 'closed' ? 'selected' : ''}>關閉</option></select></div>
      <div class="field"><label class="label">邊個睇到</label>
        ${visSelect('quiz', contentVis(d, 'quiz'), 'id="qz-vis"')}
        <div class="hint mt-4">設「對外公開」＝ 免登入都睇到。去側邊欄<b>公開資料</b>可以一眼睇晒而家公開緊啲乜。</div></div>
    </div>
    <div class="mt-16 semibold sm">題目</div>
    <div id="qz-qs">${qs.map((item, i) => qRow(item, i)).join('')}</div>
    <button class="btn btn-sm mt-12" type="button" data-act="add-q">${icon('plus', 14)} 加題</button>
    <div class="row gap-8 mt-16" style="justify-content:flex-end">
      <button class="btn" data-go="#/quizzes">取消</button>
      <button class="btn btn-primary" data-act="save">${icon('save', 16)} 儲存</button>
    </div>
  </div>`;
}

function qRow(item, i) {
  return `<div class="card card-pad mt-12" data-qrow="${esc(item.id)}">
    <div class="row-between"><div class="xs faint">第 ${i + 1} 題</div>
      <button class="btn btn-xs btn-ghost" type="button" data-delq="${esc(item.id)}">刪</button></div>
    <input class="input mt-8" data-f="prompt" value="${esc(item.prompt)}" placeholder="題目">
    <div class="grid g-2 mt-8" style="gap:8px">
      <select class="select" data-f="type">
        ${[['short', '短答'], ['para', '段落'], ['single', '單選'], ['multi', '多選']].map(([k, l]) =>
          `<option value="${k}" ${item.type === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <label class="check"><input type="checkbox" data-f="req" ${item.required ? 'checked' : ''}> 必填</label>
    </div>
    <input class="input mt-8" data-f="opts" value="${esc((item.options || []).join(' | '))}" placeholder="選項（單選／多選：用 | 分隔）">
  </div>`;
}

function detail(id) {
  const q = find('quizzes', id);
  if (!q) return empty('alert', '搵唔到試卷');
  const resp = Object.entries(q.responses || {});
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/quizzes">${icon('chevronL', 15)} 返回</button></div>
  ${pageHead({
    title: q.title,
    sub: `${(q.questions || []).length} 題 · ${resp.length} 份回應`,
    actions: can('quiz.edit') ? `<button class="btn btn-sm" data-act="edit">${icon('edit', 15)} 編輯</button>
      <button class="btn btn-sm btn-danger" data-act="del">${icon('trash', 15)}</button>` : ''
  })}
  <div class="card card-pad mb-16 sm" style="white-space:pre-wrap">${esc(q.note || '')}</div>
  <div class="card"><div class="card-head"><div class="card-title">回應</div></div>
    ${resp.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th>團員</th><th>時間</th><th>答案摘要</th></tr></thead>
      <tbody>${resp.map(([mid, r]) => `<tr>
        <td class="semibold sm">${esc(r.name || memberName(mid))}</td>
        <td class="xs mono">${esc(r.at || '')}</td>
        <td class="xs">${esc(summarize(q, r.answers))}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">未有人交卷</div>'}
  </div>`;
}

function summarize(q, answers = {}) {
  return (q.questions || []).map(item => {
    const a = answers[item.id];
    const v = Array.isArray(a) ? a.join('、') : (a || '—');
    return `${item.prompt}: ${v}`;
  }).join(' ｜ ').slice(0, 240);
}

function collectQuestions(root) {
  return [...root.querySelectorAll('[data-qrow]')].map(row => {
    const type = row.querySelector('[data-f=type]')?.value || 'short';
    const opts = (row.querySelector('[data-f=opts]')?.value || '').split('|').map(s => s.trim()).filter(Boolean);
    return {
      id: row.dataset.qrow,
      prompt: row.querySelector('[data-f=prompt]')?.value.trim() || '',
      type, options: opts, required: !!row.querySelector('[data-f=req]')?.checked
    };
  }).filter(x => x.prompt);
}

export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => go('#/quizzes/' + el.dataset.open)));
  root.querySelector('[data-act="edit"]')?.addEventListener('click', () => go('#/quizzes/' + params.id + '/edit'));
  root.querySelector('[data-act="add-q"]')?.addEventListener('click', () => {
    const box = root.querySelector('#qz-qs');
    const id = uid('qq');
    box.insertAdjacentHTML('beforeend', qRow({ id, prompt: '', type: 'short', options: [], required: true }, box.children.length));
    bindDel(root);
  });
  bindDel(root);
  root.querySelector('[data-act="save"]')?.addEventListener('click', () => {
    const title = root.querySelector('#qz-title')?.value.trim();
    if (!title) { toast('請填名稱', 'err'); return; }
    const payload = {
      title, note: root.querySelector('#qz-note')?.value.trim() || '',
      status: root.querySelector('#qz-status')?.value || 'open',
      /* ★「邊個睇到」（五級）—— 試卷預設團員（要登入團員入口先填到）。 */
      vis: root.querySelector('#qz-vis')?.value || 'member',
      questions: collectQuestions(root), updatedAt: todayISO()
    };
    if (params.id && params.id !== 'new') {
      update('quizzes', params.id, payload); toast('已儲存', 'ok'); go('#/quizzes/' + params.id);
    } else {
      const rec = add('quizzes', { id: uid('qz'), responses: {}, createdAt: todayISO(), ...payload });
      toast('已新增試卷', 'ok'); go('#/quizzes/' + rec.id);
    }
  });
  root.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除試卷', danger: true, okText: '刪除', message: '確定刪除？回應會一齊刪。' })) {
      remove('quizzes', params.id); toast('已刪除', 'ok'); go('#/quizzes');
    }
  });
  root.querySelector('[data-act="do-import"]')?.addEventListener('click', () => {
    const parsed = parseQuizImport(root.querySelector('#qz-import')?.value || '');
    if (parsed.error) { toast(parsed.error, 'err'); return; }
    const rec = add('quizzes', {
      id: uid('qz'), title: parsed.title || '匯入試卷', note: '由 PDF／文字／CSV 匯入',
      status: 'open', questions: parsed.questions, responses: {}, createdAt: todayISO()
    });
    toast(`已匯入 ${parsed.questions.length} 題`, 'ok');
    go('#/quizzes/' + rec.id);
  });

  /* 上載 Google Form PDF／文字檔 —— 全部喺瀏覽器入面解析（零依賴，唔會傳去第二度） */
  root.querySelector('[data-qz-upload]')?.addEventListener('change', async e => {
    const input = e.target;
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      let text = '';
      if (/\.pdf$/i.test(f.name || '') || f.type === 'application/pdf') {
        const { pdfFileToQuizText } = await import('../lib/pdftext.js');
        const r = await pdfFileToQuizText(f);
        if (!r.ok) { toast(r.error || '讀唔到個 PDF', 'err'); input.value = ''; return; }
        text = r.text;
      } else {
        text = await f.text();
      }
      const ta = root.querySelector('#qz-import');
      if (ta) ta.value = text;
      refreshImportPreview(root);
      toast(`已讀取「${f.name}」，檢查下下面預覽啱唔啱`, 'ok');
    } catch (err) {
      toast('讀唔到檔案：' + (err?.message || err), 'err');
    }
    input.value = '';
  });

  /* 貼／改文字 → 即時更新預覽 */
  const ta = root.querySelector('#qz-import');
  if (ta) {
    let deb = null;
    ta.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => refreshImportPreview(root), 250); });
    refreshImportPreview(root);
  }
}

function bindDel(root) {
  root.querySelectorAll('[data-delq]').forEach(b => {
    b.onclick = () => b.closest('[data-qrow]')?.remove();
  });
}
