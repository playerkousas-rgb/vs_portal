/* ============================================================
   tests/pdftext.mjs — PDF 文字抽取＋試卷匯入解析（零依賴，純 Node）
   ------------------------------------------------------------
   驗證：
     1. inflateZlib 對 zlib（stored／fixed／dynamic）同 raw deflate 都解得到
     2. extractPdfLines / pdfToQuizText 對「Google Form 列印 PDF」格式
        （Type0 + Identity-H + ToUnicode + Flate 內容流）抽得到中文題目同選項
     3. parseQuizImport：
        a) Google Form PDF 抽出嚟嘅文字（有縮排、無編號）→ 題目＋選項
        b) 人手貼嘅有編號文字（舊格式）→ 一如以往
        c) CSV（舊格式）→ 一如以往
        d) 必填／頁碼／提交 等 垃圾行會被丟走
   ============================================================ */

import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { inflateZlib, extractPdfLines, pdfToQuizText, parseToUnicode } from '../assets/js/lib/pdftext.js';
import { parseQuizImport } from '../assets/js/views/quizzes.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const section = t => console.log('\n▌' + t);

/* ============================================================
   工具：砌一個好似 Chrome／Skia 列印出嚟嘅 PDF
   ============================================================ */
function flate(strOrBytes) {
  const bytes = typeof strOrBytes === 'string' ? Buffer.from(strOrBytes, 'utf8') : strOrBytes;
  return zlib.deflateSync(bytes);
}

/** 用 Type0/Identity-H 字型砌中文文字流：每個唔同字符派一個 2-byte code */
function makeCidFont(linesToDraw) {
  const map = new Map();          // char → code
  for (const l of linesToDraw) for (const ch of l.text) if (!map.has(ch)) map.set(ch, map.size + 1);
  const bfchars = [...map.entries()].map(([ch, code]) => {
    const u = ch.codePointAt(0);
    const hex = u > 0xFFFF
      ? [...ch].map(c => c.codePointAt(0).toString(16).padStart(4, '0')).join('')
      : u.toString(16).padStart(4, '0');
    return `<${code.toString(16).padStart(4, '0')}> <${hex}>`;
  }).join('\n');
  const toUni = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${Math.ceil(bfchars.length / 100) ? '' : ''}
beginbfchar
${bfchars}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const encode = text => [...text].map(ch => map.get(ch).toString(16).padStart(4, '0')).join('');
  return { toUni, encode };
}

/** 砌一份 PDF bytes。draw() 回傳內容流文字（用 F1＝CID 中文字、F2＝WinAnsi） */
function buildPdf({ content, toUniSrc }) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>';
  objs[4] = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+NotoSansTC-Regular /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>';
  const cData = flate(content);
  objs[5] = { dict: `<< /Length ${cData.length} >>`, data: cData };
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[7] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+NotoSansTC-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /W [1 [500]] >>';
  const uData = flate(toUniSrc);
  objs[8] = { dict: `<< /Length ${uData.length} >>`, data: uData };

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    const o = objs[i];
    if (typeof o === 'string') out += `${i} 0 obj\n${o}\nendobj\n`;
    else out += `${i} 0 obj\n${o.dict}\nstream\n` + o.data.toString('latin1') + '\nendstream\nendobj\n';
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ============================================================ */
section('1. inflateZlib：stored / fixed / dynamic / raw');
{
  const a = Buffer.from(inflateZlib(new Uint8Array(zlib.deflateSync(Buffer.from('A'.repeat(40) + 'BCDEF', 'latin1'), { level: 0 })))).toString('latin1');
  ok('stored 解得返', a === 'A'.repeat(40) + 'BCDEF', JSON.stringify(a.slice(0, 20)));
  const b = Buffer.from(inflateZlib(new Uint8Array(zlib.deflateSync(Buffer.from(('旅團格言日行一善。').repeat(80), 'utf8'))))).toString('utf8');
  ok('dynamic 解得返', b === ('旅團格言日行一善。').repeat(80), 'len=' + b.length);
  const c = Buffer.from(inflateZlib(new Uint8Array(zlib.deflateSync(Buffer.from('hello', 'latin1'))))).toString('latin1');
  ok('短字串（fixed huffman）解得返', c === 'hello', JSON.stringify(c));
  const rawIn = Buffer.from('raw-deflate-payload-1234567890'.repeat(4), 'latin1');
  const raw = zlib.deflateRawSync(rawIn);
  const d = Buffer.from(inflateZlib(new Uint8Array(raw))).toString('latin1');
  ok('raw deflate（冇 zlib header）都解到', d === rawIn.toString('latin1'), 'len=' + d.length);
}

/* ============================================================ */
section('2. Google Form 列印 PDF（中文 Type0 + Identity-H + ToUnicode）');
const LINES = [
  { x: 40, y: 780, text: '中華傳道會週會小測', op: 'TJ' },
  { x: 40, y: 752, text: '1. 旅團格言係咩？', op: 'Tj' },
  { x: 64, y: 730, text: '日行一善', op: 'Tj' },
  { x: 64, y: 712, text: '人生以服務為目的', op: 'Tj' },
  { x: 40, y: 690, text: '2. 你嘅小隊係邊個？', op: 'Tj' },
  { x: 64, y: 668, text: 'A 隊', op: 'Tj' },
  { x: 64, y: 650, text: 'B 隊', op: 'Tj' },
  { x: 40, y: 628, text: '3. 有咩意見想講？（可以留空）', op: 'Tj' },
  { x: 40, y: 606, text: '必填', op: 'Tj' }
];
{
  const cid = makeCidFont(LINES.concat([{ text: '（第一回）' }]));
  let content = 'q\n0.98 0 0 0.98 2 4 cm\n';
  /* 第一行：TJ array（有 kerning 數字），用 Td 定位 */
  content += `BT\n/F1 12 Tf\n40 780 Td\n[<${cid.encode('中華傳道會週會小測')}> 120 <${cid.encode('（第一回）')}>] TJ\nET\n`;
  /* 之後行：Tm + Tj */
  for (const l of LINES.slice(1)) {
    content += `BT\n/F1 12 Tf\n1 0 0 1 ${l.x} ${l.y} Tm\n<${cid.encode(l.text)}> Tj\nET\n`;
  }
  content += 'Q\n';
  /* WinAnsi literal string（有轉義括號）——Forms 版尾嘅 Google Forms 字樣 */
  content += `BT\n/F2 10 Tf\n1 0 0 1 40 580 Tm\n(Google \\(print\\) Forms) Tj\nET\n`;

  const pdfBytes = buildPdf({ content, toUniSrc: cid.toUni });
  /* 唔寫落 disk —— 全程喺記憶體度測，唔會留垃圾檔 */

  const r = extractPdfLines(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength));
  ok('extractPdfLines 成功', r.ok, r.error);
  ok('抽到 ' + (LINES.length + 1) + ' 行', r.lines.length === LINES.length + 1, '實際 ' + r.lines.length + '：' + JSON.stringify(r.lines.map(l => l.text)));
  ok('中文解碼啱（TJ 連 kerning）', r.lines[0]?.text === '中華傳道會週會小測（第一回）', JSON.stringify(r.lines[0]));
  ok('題目行解碼啱', r.lines[1]?.text === '1. 旅團格言係咩？', JSON.stringify(r.lines[1]));
  ok('literal string 解碼啱（轉義括號）', (r.lines[r.lines.length - 1]?.text || '').includes('(print)'), JSON.stringify(r.lines[r.lines.length - 1]));
  ok('選項行 x 位置有縮排', r.lines[2]?.x > r.lines[1]?.x, JSON.stringify([r.lines[1]?.x, r.lines[2]?.x]));
  ok('行由上至下', r.lines[1]?.y > r.lines[2]?.y);

  const q = pdfToQuizText(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength));
  ok('pdfToQuizText 成功', q.ok, q.error);
  const tl = q.text.split('\n');
  ok('標題冇縮排', tl[0] === '中華傳道會週會小測（第一回）', JSON.stringify(tl[0]));
  ok('選項行有兩格縮排', tl[2] === '  日行一善' && tl[3] === '  人生以服務為目的', JSON.stringify(tl.slice(2, 4)));
  ok('問題行冇縮排', tl[1] === '1. 旅團格言係咩？', JSON.stringify(tl[1]));

  /* parseQuizImport 食呢段文字 */
  const p = parseQuizImport(q.text);
  ok('解析成功', !p.error, p.error);
  ok('標題', p.title === '中華傳道會週會小測（第一回）', JSON.stringify(p.title));
  ok('3 條題目', p.questions.length === 3, JSON.stringify(p.questions.map(x => x.prompt)));
  ok('第 1 題 2 個選項（單選）', p.questions[0]?.options.length === 2 && p.questions[0]?.type === 'single', JSON.stringify(p.questions[0]));
  ok('第 1 題文字齊', p.questions[0]?.prompt === '1. 旅團格言係咩？', JSON.stringify(p.questions[0]?.prompt));
  ok('第 2 題 2 個選項', p.questions[1]?.options.join('|') === 'A 隊|B 隊', JSON.stringify(p.questions[1]?.options));
  ok('第 3 題冇選項（短答）', p.questions[2]?.type === 'short' && p.questions[2]?.options.length === 0, JSON.stringify(p.questions[2]));
  ok('「必填」垃圾行被丟走', !p.questions.some(x => /必填/.test(x.prompt)), JSON.stringify(p.questions.map(x => x.prompt)));
  ok('「Google (print) Forms」垃圾行被丟走', !p.questions.some(x => /Forms/i.test(x.prompt)));
}

/* ============================================================ */
section('3. parseQuizImport：人手貼（有編號）同 CSV — 舊格式唔可以壞');
{
  const p1 = parseQuizImport('標題：週會小測\n1. 旅團格言係？\nA. 準備\nB. 日行一善\n2. 你嘅小隊？');
  ok('編號格式：標題', p1.title === '週會小測', JSON.stringify(p1.title));
  ok('編號格式：2 題', p1.questions.length === 2, JSON.stringify(p1.questions));
  ok('編號格式：A/B 選項', p1.questions[0].options.join('|') === '準備|日行一善', JSON.stringify(p1.questions[0].options));
  ok('編號格式：第 2 題短答', p1.questions[1].type === 'short');

  const p2 = parseQuizImport('題目,類型,選項,必填\n旅團幾時創立?,short,,是\n鍾意邊個活動?,single,遠足|露營,否');
  ok('CSV：2 題', p2.questions.length === 2, JSON.stringify(p2.questions));
  ok('CSV：類型＋選項', p2.questions[1].type === 'single' && p2.questions[1].options.join('|') === '遠足|露營', JSON.stringify(p2.questions[1]));

  /* 多選關鍵字 */
  const p3 = parseQuizImport('1. 以下邊啲係核取方塊題目？\n甲\n乙\n丙');
  ok('「核取」關鍵字 → multi', p3.questions[0]?.type === 'multi', JSON.stringify(p3.questions[0]));
}

/* ============================================================ */
section('3.5 PDF 抽出文字：斷行題目、描述行、縮排選項');
{
  const text = [
    '中華小測（十月）',
    '這是十月嘅週會小測，請全部團員作答。',      // 描述（句號收尾 → 唔好黐落第一題）
    '1. 旅團格言係咩？',
    '  日行一善',
    '  人生以服務為目的',
    '今年旅團想去邊度宿營',                      // 題目斷咗開（第一截冇問號）
    '同埋預計幾多錢？',                          // 第二截有問號 → 兩截要接返埋
    '  大帽山營地',
    '  西貢灣仔營',
    '3. 有咩意見？'
  ].join('\n');
  const p = parseQuizImport(text);
  ok('斷行測試：解析成功', !p.error, p.error);
  ok('斷行測試：標題', p.title === '中華小測（十月）', JSON.stringify(p.title));
  ok('斷行測試：3 題', p.questions.length === 3, JSON.stringify(p.questions.map(q => q.prompt)));
  ok('斷行測試：描述行冇黐落第一題', p.questions[0]?.prompt === '1. 旅團格言係咩？', JSON.stringify(p.questions[0]?.prompt));
  ok('斷行測試：兩截題目接返埋', p.questions[1]?.prompt === '今年旅團想去邊度宿營 同埋預計幾多錢？', JSON.stringify(p.questions[1]?.prompt));
  ok('斷行測試：第 2 題 2 個選項', p.questions[1]?.options.join('|') === '大帽山營地|西貢灣仔營', JSON.stringify(p.questions[1]?.options));
}

/* ============================================================ */
section('3.7 Google Form 列印雜線：電郵地址／分區介紹唔可以當題目（2026-09-18 第 2 項）');
{
  const text = [
    '中華小測（十一月版）',
    '',                                     // ← 空行（表單說明）
    '* 必填',
    '電子郵件地址',                          // ← Forms 官方欄位說明（以前被當成題目）
    '你的電子郵件地址將不會公開，因為這份表單不要求登入。',   // ← 說明行
    '區段 1 共 2 個區段',                    // ← 分區標題
    '(請細心閱讀以下露營守則，然後作答。)',    // ← 分區介紹（以前會黐落第一題）
    '1. 旅團格言係咩？',
    '  日行一善',
    '  人生以服務為目的',
    '2. 邊個係你嘅小隊長？',
    '  陳大文',
    '  李小明',
    '區段 2 共 2 個區段',
    '以下係意見調查部分。',                  // ← 第二個分區嘅介紹
    '3. 有咩意見？',
    'Google 表單',                           // ← 版尾
    '此內容既非建立，也未經 Google 認可'
  ].join('\n');
  const p = parseQuizImport(text);
  ok('Forms 列印：解析成功', !p.error, p.error);
  ok('Forms 列印：啱啱 3 條題目（雜線全部丟走）', p.questions.length === 3, JSON.stringify(p.questions.map(q => q.prompt)));
  ok('Forms 列印：標題由第一行嚟', p.title === '中華小測（十一月版）', JSON.stringify(p.title));
  ok('Forms 列印：第一題冇黐住分區介紹', p.questions[0]?.prompt === '1. 旅團格言係咩？', JSON.stringify(p.questions[0]?.prompt));
  ok('Forms 列印：冇任何「電郵」雜線入咗題目', !p.questions.some(q => /電子郵件|電郵/.test(q.prompt)), JSON.stringify(p.questions.map(q => q.prompt)));
  ok('Forms 列印：冇「區段／分區」入咗題目', !p.questions.some(q => /區段|分區/.test(q.prompt)), JSON.stringify(p.questions.map(q => q.prompt)));
  ok('Forms 列印：冇 Google 字眼入咗題目', !p.questions.some(q => /Google/i.test(q.prompt)));

  /* 真問題唔可以誤殺：問號結尾／有冒號嘅「電郵」問題要保留 */
  const p2 = parseQuizImport('1. 你嘅電郵地址係咩？\n2. 請填聯絡電郵:');
  ok('唔好誤殺真問題（有問號／冒號嘅電郵題）', p2.questions.length === 2, JSON.stringify(p2.questions.map(q => q.prompt)));
}

/* ============================================================ */
section('4. ToUnicode CMap：bfrange');
{
  const src = `beginbfrange
<0020> <007E> <0020>
<0100> <0103> [<4E00> <4E01> <4E02> <4E03>]
endbfrange`;
  const m = parseToUnicode(src);
  ok('bfrange base（ASCII 對位）', m.get(0x41) === 'A' && m.get(0x30) === '0', JSON.stringify(m.get(0x41)));
  ok('bfrange array', m.get(0x100) === '一' && m.get(0x102) === '丂' && m.get(0x103) === '七', JSON.stringify([m.get(0x100), m.get(0x102), m.get(0x103)]));
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
