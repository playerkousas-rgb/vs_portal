import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { unzip, zipText, resolveZipPath } from '../assets/js/lib/zip.js';
import { readXlsx, detectHeaderRow, sheetToTsv, decodeXml } from '../assets/js/lib/xlsx.js';
import {
  readDocx, textToBlocks, classifyConstitutionBlock,
  parseConstitutionBlocks, applyConstitutionImport
} from '../assets/js/lib/doc-import.js';
import {
  autoMapFinanceHeaders, mappedFinanceTsv, parsePasted, partitionFinanceImport
} from '../assets/js/views/finance.js';
import { rowsFromSheet, planTableImport } from '../assets/js/views/tables.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content, method = 8] of files) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(content);
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x800), u16(method), u16(0), u16(0),
      u32(crc), u32(packed.length), u32(raw.length), u16(nameBytes.length), u16(0), nameBytes, packed
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(method), u16(0), u16(0),
      u32(crc), u32(packed.length), u32(raw.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return new Uint8Array(Buffer.concat([...locals, central, eocd]));
}

// ZIP: actual stored + deflate extraction, path resolution, CRC and memory guards.
const zip = makeZip([
  ['stored.txt', '本機遷移', 0],
  ['folder/deflated.txt', 'A'.repeat(4000), 8]
]);
const entries = await unzip(zip);
assert.equal(zipText(entries, 'stored.txt'), '本機遷移');
assert.equal(zipText(entries, 'folder/deflated.txt').length, 4000);
assert.equal(resolveZipPath('xl/workbook.xml', 'worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
assert.equal(resolveZipPath('xl/workbook.xml', '../docProps/core.xml'), 'docProps/core.xml');
assert.equal(resolveZipPath('xl/workbook.xml', '../../outside.xml'), '');
assert.equal(resolveZipPath('xl/workbook.xml', 'https://evil.example/sheet.xml'), '');
await assert.rejects(() => unzip(zip, { maxEntryBytes: 1000 }), /太大|安全上限/);
await assert.rejects(() => unzip(zip, { maxArchiveBytes: zip.byteLength - 1 }), /原檔超出安全上限/);
await assert.rejects(() => unzip(new Uint8Array(64 * 1024 * 1024 + 1)), /原檔超出安全上限/);
const tooManyEntries = new Uint8Array(Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(5001), u16(5001), u32(0), u32(0), u16(0)
]));
await assert.rejects(() => unzip(tooManyEntries), /entry 數量超出安全上限/);
await assert.rejects(() => unzip(zip, { maxEntries: 1 }), /entry 數量超出安全上限/);
await assert.rejects(() => unzip(makeZip([['same.txt', 'a'], ['same.txt', 'b']])), /重複|名稱無效/);
await assert.rejects(() => unzip(makeZip([['../escape.txt', 'x']])), /名稱無效/);
const corrupt = zip.slice();
const storedAt = Buffer.from(corrupt).indexOf(Buffer.from('本機遷移'));
corrupt[storedAt] ^= 1;
await assert.rejects(() => unzip(corrupt), /校驗失敗/);

// XLSX: relationships, shared/inline strings, date style, formula cached value, two sheets.
const workbookXml = `<?xml version="1.0"?><workbook xmlns:r="r"><workbookPr date1904="0"/><sheets>
  <sheet name="舊帳" sheetId="1" r:id="rId1"/><sheet name="名冊" sheetId="2" r:id="rId2"/>
</sheets></workbook>`;
const relsXml = `<?xml version="1.0"?><Relationships>
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>`;
const sharedXml = `<sst><si><t>日期</t></si><si><t>金額</t></si><si><r><t>王</t></r><r><t>小明</t></r></si></sst>`;
const stylesXml = `<styleSheet><numFmts count="0"></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
const sheet1Xml = `<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>項目</t></is></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>已核對</t></is></c></row>
  <row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2" t="inlineStr"><is><r><t>團</t></r><r><t>費</t></r></is></c><c r="C2"><v>1234.5</v></c><c r="D2" t="b"><v>1</v></c><c r="E2"><f>1+1</f><v>2</v></c></row>
</sheetData></worksheet>`;
const sheet2Xml = `<worksheet><sheetData><row r="3"><c r="B3" t="s"><v>2</v></c></row></sheetData></worksheet>`;
const xlsx = makeZip([
  ['xl/workbook.xml', workbookXml, 8], ['xl/_rels/workbook.xml.rels', relsXml, 8],
  ['xl/sharedStrings.xml', sharedXml, 8], ['xl/styles.xml', stylesXml, 8],
  ['xl/worksheets/sheet1.xml', sheet1Xml, 8], ['xl/worksheets/sheet2.xml', sheet2Xml, 0]
]);
const book = await readXlsx(xlsx);
assert.deepEqual(book.sheets.map(s => s.name), ['舊帳', '名冊']);
assert.deepEqual(book.sheets[0].rows[0].slice(0, 4), ['日期', '項目', '金額', '已核對']);
assert.deepEqual(book.sheets[0].rows[1].slice(0, 5), ['2024-01-01', '團費', '1234.5', 'TRUE', '2']);
assert.equal(book.sheets[1].rows[2][1], '王小明');
assert.equal(detectHeaderRow([['舊帳說明'], book.sheets[0].rows[0], book.sheets[0].rows[1]]), 1);
assert.match(sheetToTsv(book.sheets[0]), /^日期\t項目\t金額/m);
assert.equal(decodeXml('ok &#x110000; &#0;'), 'ok � �');
const oneSheetBook = '<workbook xmlns:r="r"><sheets><sheet name="惡意" r:id="rId1"/></sheets></workbook>';
const oneSheetRels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
const hostileXlsx = sheetXml => makeZip([
  ['xl/workbook.xml', oneSheetBook], ['xl/_rels/workbook.xml.rels', oneSheetRels],
  ['xl/worksheets/sheet1.xml', sheetXml]
]);
await assert.rejects(() => readXlsx(hostileXlsx('<worksheet><sheetData><row r="1000000000"><c r="A1000000000"><v>1</v></c></row></sheetData></worksheet>')), /行號超出安全上限/);
await assert.rejects(() => readXlsx(hostileXlsx('<worksheet><sheetData><row r="1"><c r="ZZZ1"><v>1</v></c></row></sheetData></worksheet>')), /欄號超出安全上限/);
const externalSheetBook = '<workbook xmlns:r="r"><sheets><sheet name="外連" r:id="rId1"/></sheets></workbook>';
const externalSheetRels = '<Relationships><Relationship Id="rId1" Target="https://evil.example/sheet.xml" TargetMode="External"/></Relationships>';
await assert.rejects(() => readXlsx(makeZip([
  ['xl/workbook.xml', externalSheetBook], ['xl/_rels/workbook.xml.rels', externalSheetRels]
])), /搵唔到可讀工作表/);

// Finance-specific mapping: arbitrary source columns become the standard parser input.
const sourceHeaders = ['交易日', '收支', '內容名稱', '銀碼', '說明'];
const financeMap = autoMapFinanceHeaders(sourceHeaders);
assert.deepEqual(financeMap, ['日期', '類型', '項目', '金額', '備註']);
const mapped = mappedFinanceTsv([
  sourceHeaders,
  ['2024-04-01', '收入', '團費', 'HK$1,200', '四月'],
  ['2024-04-02', '支出', '文具', '50', '']
], { headerRow: 0, mapping: financeMap });
const parsedFinance = parsePasted(mapped);
assert.equal(parsedFinance.length, 2);
assert.equal(parsedFinance[0].amount, 1200);
assert.equal(parsedFinance[1].type, 'expense');
const financePlan = partitionFinanceImport([...parsedFinance, { ...parsedFinance[0] }], [parsedFinance[1]]);
assert.equal(financePlan.accepted.length, 1);
assert.equal(financePlan.duplicates.length, 2);

// Generic table mapping validates required fields and skips duplicate source/existing rows.
const fields = [
  { key: 'name', label: '姓名', type: 'text', required: true },
  { key: 'phone', label: '電話', type: 'text' },
  { key: 'score', label: '分數', type: 'number' }
];
const sheet = { rows: [['甲', '91234567', '10'], ['', '90000000', '5'], ['甲', '91234567', '10']] };
const genericRows = rowsFromSheet(sheet, { 0: 'name', 1: 'phone', 2: 'score' }, fields);
const genericPlan = planTableImport(genericRows, [{ name: '乙', phone: '98888888', score: 8 }], fields);
assert.equal(genericPlan.accepted.length, 1);
assert.equal(genericPlan.invalid.length, 1);
assert.equal(genericPlan.duplicates.length, 1);

// DOCX: actual deflate extraction, styles, bilingual adjacency, hierarchy and append/replace.
const documentXml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>第八十二旅深資童軍團章</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Constitution of Venture Scout Unit 82</w:t></w:r></w:p>
  <w:p><w:r><w:t>序言</w:t></w:r></w:p><w:p><w:r><w:t>本團自治。</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章　總則</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter I General</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第一條　本團名稱</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Article I Name</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>（一）中文名稱</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>English name</w:t></w:r></w:p>
  <w:p><w:r><w:t>附件 A</w:t></w:r></w:p><w:p><w:r><w:t>Appendix A</w:t></w:r></w:p>
  <w:p><w:r><w:t>附件內容</w:t></w:r></w:p>
</w:body></w:document>`;
const docx = makeZip([
  ['word/document.xml', documentXml, 8],
  ['word/styles.xml', '<w:styles xmlns:w="w"></w:styles>', 8]
]);
const doc = await readDocx(docx);
assert.equal(doc.blocks.length, 13);
const tooManyParagraphs = `<w:document xmlns:w="w"><w:body>${'<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(5001)}</w:body></w:document>`;
await assert.rejects(() => readDocx(makeZip([['word/document.xml', tooManyParagraphs]])), /段落數量超出安全上限/);
assert.equal(classifyConstitutionBlock(doc.blocks[4]), 'chapter');
assert.equal(classifyConstitutionBlock({ text: '附件 A' }), 'appendix');
const parsedDoc = parseConstitutionBlocks(doc.blocks, { language: 'auto', mode: 'auto' });
assert.equal(parsedDoc.title.zh, '第八十二旅深資童軍團章');
assert.equal(parsedDoc.title.en, 'Constitution of Venture Scout Unit 82');
assert.equal(parsedDoc.chapters.length, 1);
assert.equal(parsedDoc.chapters[0].heading.en, 'Chapter I General');
assert.equal(parsedDoc.articleCount, 1);
assert.equal(parsedDoc.chapters[0].articles[0].en, 'Article I Name');
assert.equal(parsedDoc.itemCount, 1);
assert.equal(parsedDoc.chapters[0].articles[0].items[0].en, 'English name');
assert.equal(parsedDoc.appendices.length, 1);
assert.equal(parsedDoc.appendices[0].heading.en, 'Appendix A');
assert.equal(parsedDoc.appendices[0].blocks.length, 1);

const current = { title: { zh: '舊團章', en: '' }, preamble: { zh: '', en: '' }, chapters: [{ id: 'old', heading: { zh: '舊章', en: '' }, articles: [] }], appendices: [], history: [{ version: '1.0' }] };
const appended = applyConstitutionImport(current, parsedDoc, { strategy: 'append' });
assert.equal(appended.chapters.length, 2);
assert.deepEqual(appended.history, current.history);
const replaced = applyConstitutionImport(current, parsedDoc, { strategy: 'replace' });
assert.equal(replaced.chapters.length, 1);
assert.equal(replaced.title.zh, parsedDoc.title.zh);
assert.deepEqual(replaced.history, current.history);

const markdownBlocks = textToBlocks('# 團章\n## 第一章 總則\n1. 條文\n- 子項');
assert.equal(markdownBlocks[0].level, 1);
assert.equal(markdownBlocks[3].list, true);

console.log('✓ ZIP / XLSX / DOCX native migration tests passed');
