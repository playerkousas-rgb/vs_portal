/* ============================================================
   doc-import.js — Google Docs 團章遷移（.docx／純文字／Markdown）
   ------------------------------------------------------------
   Google Docs 可「檔案 → 下載 → Microsoft Word (.docx)」。本模組只在
   瀏覽器讀 OOXML 段落，不執行巨集、圖片或外部連結；亦支援直接貼文字。
   ============================================================ */

import { unzip, zipText } from './zip.js';
import { decodeXml } from './xlsx.js';

const MAX_DOCUMENT_TEXT = 8 * 1024 * 1024;
const MAX_DOCUMENT_BLOCKS = 5000;
const MAX_BLOCK_TEXT = 100000;

function attr(tag, name) {
  const escaped = String(name).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const m = String(tag || '').match(new RegExp(`(?:^|\\s)(?:\\w+:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return decodeXml(m ? (m[1] ?? m[2] ?? '') : '');
}
function paragraphText(xml) {
  return String(xml || '')
    .replace(/<(?:\w+:)?tab\b[^>]*\/?\s*>/gi, '\t')
    .replace(/<(?:\w+:)?br\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi, (_, value) => decodeXml(value))
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export async function readDocx(input) {
  const entries = await unzip(input, {
    wanted: name => name === 'word/document.xml' || name === 'word/styles.xml',
    maxEntryBytes: 20 * 1024 * 1024,
    maxTotalBytes: 25 * 1024 * 1024
  });
  const documentXml = zipText(entries, 'word/document.xml');
  const blocks = [];
  let textBytes = 0;
  for (const m of documentXml.matchAll(/<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/gi)) {
    const body = m[2] || '';
    const text = paragraphText(body);
    if (!text) continue;
    if (text.length > MAX_BLOCK_TEXT) throw new Error('Word 內有單一段落超出安全上限');
    if (blocks.length >= MAX_DOCUMENT_BLOCKS) throw new Error('Word 段落數量超出安全上限；請分開文件匯入');
    textBytes += text.length;
    if (textBytes > MAX_DOCUMENT_TEXT) throw new Error('Word 文字內容超出安全上限；請分開文件匯入');
    const styleTag = body.match(/<(?:\w+:)?pStyle\b([^>]*)\/?\s*>/i)?.[1] || '';
    const style = attr(styleTag, 'val');
    const outlineTag = body.match(/<(?:\w+:)?outlineLvl\b([^>]*)\/?\s*>/i)?.[1] || '';
    const outline = Number(attr(outlineTag, 'val'));
    const headingMatch = style.match(/(?:heading|標題)\s*([1-9])/i);
    const level = headingMatch ? Number(headingMatch[1])
      : (Number.isFinite(outline) && outline >= 0 ? outline + 1 : 0);
    blocks.push({
      text,
      style,
      level,
      list: /<(?:\w+:)?numPr\b/i.test(body)
    });
  }
  if (!blocks.length) throw new Error('Word 檔案入面搵唔到可讀文字段落');
  return { blocks, source: 'docx' };
}

export function textToBlocks(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (src.length > MAX_DOCUMENT_TEXT) throw new Error('文字內容超出安全上限；請分開文件匯入');
  const blocks = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_BLOCK_TEXT) throw new Error('有單一段落超出安全上限');
    if (blocks.length >= MAX_DOCUMENT_BLOCKS) throw new Error('段落數量超出安全上限；請分開文件匯入');
    const md = line.match(/^(#{1,6})\s+(.+)$/);
    const numbered = line.match(/^((?:\d+|[一二三四五六七八九十百]+)[.、)]\s*)(.+)$/);
    blocks.push({
      text: md ? md[2].trim() : line.replace(/^[-*•]\s+/, ''),
      style: md ? `Heading${md[1].length}` : '',
      level: md ? md[1].length : 0,
      list: /^[-*•]\s+/.test(line) || !!numbered
    });
  }
  return blocks;
}

const CHAPTER_RE = /^(?:第\s*[0-9一二三四五六七八九十百零〇]+\s*章|chapter\s+[0-9ivxlcdm]+\b|附則\b)/i;
const ARTICLE_RE = /^(?:第\s*[0-9一二三四五六七八九十百零〇]+\s*條|article\s+[0-9ivxlcdm]+\b|[0-9]+(?:\.[0-9]+)*[.、)]\s*)/i;
const PREAMBLE_RE = /^(?:序言|前言|preamble|introduction)\s*[:：]?$/i;
const APPENDIX_RE = /^(?:(?:附件|附錄)(?:\s*[A-Za-z0-9一二三四五六七八九十百零〇]+)?\s*[:：]?\s*$|(?:appendix|schedule)\b)/i;
const TITLE_STYLE_RE = /title|標題/i;

function uid(prefix, index) { return `${prefix}-${String(index + 1).padStart(3, '0')}`; }
function mostlyEnglish(text) {
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  const han = (String(text).match(/[\u3400-\u9fff]/g) || []).length;
  return latin > han * 2 && latin >= 4;
}
function bilingualValue(text, language) {
  const raw = String(text || '').trim();
  if (language === 'en') return { zh: '', en: raw };
  if (language === 'zh') return { zh: raw, en: '' };
  const split = raw.split(/\s+(?:\||｜|／)\s+/).map(s => s.trim()).filter(Boolean);
  if (split.length >= 2) {
    const firstEn = mostlyEnglish(split[0]);
    const secondEn = mostlyEnglish(split.slice(1).join(' '));
    if (firstEn !== secondEn) return firstEn
      ? { zh: split.slice(1).join(' ／ '), en: split[0] }
      : { zh: split[0], en: split.slice(1).join(' / ') };
  }
  return mostlyEnglish(raw) ? { zh: '', en: raw } : { zh: raw, en: '' };
}
function complementary(existing, incoming) {
  return !!existing && !!incoming && ((existing.zh && !existing.en && !incoming.zh && incoming.en)
    || (existing.en && !existing.zh && !incoming.en && incoming.zh));
}
function fillBilingual(target, value) {
  if (value.zh && !target.zh) target.zh = value.zh;
  if (value.en && !target.en) target.en = value.en;
  return target;
}

export function classifyConstitutionBlock(block, { mode = 'auto' } = {}) {
  const text = String(block?.text || '').trim();
  const level = Number(block?.level || 0);
  if (!text) return 'ignore';
  if (PREAMBLE_RE.test(text)) return 'preamble-heading';
  if (APPENDIX_RE.test(text)) return 'appendix';
  if (CHAPTER_RE.test(text)) return 'chapter';
  if (ARTICLE_RE.test(text)) return 'article';
  if (mode !== 'numbering') {
    if (TITLE_STYLE_RE.test(String(block?.style || '')) && !/heading/i.test(String(block?.style || ''))) return 'title';
    if (level === 1 && /heading/i.test(String(block?.style || ''))) return 'chapter';
    if (level === 2) return 'article';
    if (level >= 3 || block?.list) return 'item';
  }
  return 'paragraph';
}

/**
 * 將來源段落變成本系統團章層級。mode:
 *   auto = 編號優先、Heading 1/2 後備；styles = Heading 優先；numbering = 只認第X章/條。
 */
export function parseConstitutionBlocks(input, { mode = 'auto', language = 'zh', roles = null } = {}) {
  const blocks = (Array.isArray(input) ? input : textToBlocks(input)).filter(b => String(b?.text || '').trim());
  const title = { zh: '', en: '' };
  const preamble = { zh: '', en: '' };
  const chapters = [];
  const appendices = [];
  const warnings = [];
  let currentChapter = null;
  let currentArticle = null;
  let currentAppendix = null;
  let inPreamble = false;
  let seenStructure = false;

  const ensureChapter = () => {
    if (!currentChapter) {
      currentChapter = { id: uid('imp-ch', chapters.length), heading: bilingualValue('第一章　總則', language), articles: [] };
      chapters.push(currentChapter);
    }
    return currentChapter;
  };

  blocks.forEach((block, index) => {
    const text = String(block.text || '').trim();
    const role = roles && roles[index] ? roles[index] : classifyConstitutionBlock(block, { mode });
    const previousRole = index > 0
      ? (roles && roles[index - 1] ? roles[index - 1] : classifyConstitutionBlock(blocks[index - 1], { mode }))
      : '';
    if (role === 'ignore') return;
    if (role === 'title' || (!seenStructure && !title.zh && !title.en && index < 3 && role === 'paragraph')) {
      const value = bilingualValue(text, language);
      if (!title.zh && !title.en) Object.assign(title, value);
      else if (previousRole === 'title' && complementary(title, value)) fillBilingual(title, value);
      else warnings.push(`「${text.slice(0, 28)}」亦標示為標題；已保留第一個團章標題`);
      return;
    }
    if (role === 'preamble-heading') { inPreamble = true; return; }
    if (role === 'appendix') {
      const value = bilingualValue(text, language);
      if (previousRole === 'appendix' && currentAppendix && complementary(currentAppendix.heading, value)) {
        fillBilingual(currentAppendix.heading, value); return;
      }
      seenStructure = true; inPreamble = false; currentChapter = null; currentArticle = null;
      currentAppendix = { id: uid('imp-apx', appendices.length), heading: value, blocks: [] };
      appendices.push(currentAppendix); return;
    }
    if (role === 'chapter') {
      const value = bilingualValue(text, language);
      if (previousRole === 'chapter' && currentChapter && complementary(currentChapter.heading, value)) {
        fillBilingual(currentChapter.heading, value); return;
      }
      seenStructure = true; inPreamble = false; currentAppendix = null; currentArticle = null;
      currentChapter = { id: uid('imp-ch', chapters.length), heading: value, articles: [] };
      chapters.push(currentChapter); return;
    }
    if (role === 'article') {
      const value = bilingualValue(text, language);
      if (previousRole === 'article' && currentArticle && !(currentArticle.items || []).length && complementary(currentArticle, value)) {
        fillBilingual(currentArticle, value); return;
      }
      seenStructure = true; inPreamble = false; currentAppendix = null;
      const chapter = ensureChapter();
      currentArticle = { id: uid(`imp-art-${chapters.length}`, chapter.articles.length), ...value, items: [] };
      chapter.articles.push(currentArticle); return;
    }
    if (inPreamble && !seenStructure) {
      const value = bilingualValue(text, language);
      if (value.zh) preamble.zh += (preamble.zh ? '\n' : '') + value.zh;
      if (value.en) preamble.en += (preamble.en ? '\n' : '') + value.en;
      return;
    }
    if (role === 'item' && currentArticle) {
      const value = bilingualValue(text, language);
      const last = currentArticle.items?.[currentArticle.items.length - 1];
      if (previousRole === 'item' && last && complementary(last, value)) fillBilingual(last, value);
      else currentArticle.items.push({ id: uid(`imp-item-${chapters.length}-${currentChapter.articles.length}`, currentArticle.items.length), level: Math.max(1, Number(block.level || 1) - 2), ...value });
      return;
    }
    if (currentAppendix) {
      currentAppendix.blocks.push({ id: uid(`imp-block-${appendices.length}`, currentAppendix.blocks.length), ...bilingualValue(text, language) });
      return;
    }
    if (currentArticle) {
      const value = bilingualValue(text, language);
      if (previousRole === 'article' && !(currentArticle.items || []).length && complementary(currentArticle, value)) {
        fillBilingual(currentArticle, value);
      } else {
        const last = currentArticle.items?.[currentArticle.items.length - 1];
        if (previousRole === 'paragraph' && last && complementary(last, value)) fillBilingual(last, value);
        else currentArticle.items.push({ id: uid(`imp-item-${chapters.length}-${currentChapter.articles.length}`, currentArticle.items.length), level: 1, ...value });
      }
      return;
    }
    /* 未有「條」但已入章：普通段落保留成條文，唔會靜靜掉資料。 */
    if (currentChapter || seenStructure) {
      const chapter = ensureChapter();
      currentArticle = { id: uid(`imp-art-${chapters.length}`, chapter.articles.length), ...bilingualValue(text, language), items: [] };
      chapter.articles.push(currentArticle);
      warnings.push(`「${text.slice(0, 28)}」冇辨認到條文編號，已當成新條文`);
      return;
    }
    const value = bilingualValue(text, language);
    if (value.zh) preamble.zh += (preamble.zh ? '\n' : '') + value.zh;
    if (value.en) preamble.en += (preamble.en ? '\n' : '') + value.en;
  });

  if (!title.zh && !title.en) Object.assign(title, bilingualValue(language === 'en' ? 'Constitution' : '團章', language));
  if (!chapters.length && (preamble.zh || preamble.en)) {
    warnings.push('來源冇辨認到章／條；文字暫時放喺序言，請先檢查欄位對應');
  }
  return {
    title, preamble, chapters, appendices, warnings,
    sourceCount: blocks.length,
    articleCount: chapters.reduce((n, ch) => n + ch.articles.length, 0),
    itemCount: chapters.reduce((n, ch) => n + ch.articles.reduce((m, a) => m + (a.items || []).length, 0), 0),
    blocks
  };
}

export function applyConstitutionImport(current, parsed, { strategy = 'replace' } = {}) {
  const base = JSON.parse(JSON.stringify(current || {}));
  const incoming = JSON.parse(JSON.stringify(parsed || {}));
  if (strategy === 'append') {
    base.chapters = [...(base.chapters || []), ...(incoming.chapters || [])];
    base.appendices = [...(base.appendices || []), ...(incoming.appendices || [])];
    if (!base.preamble?.zh && !base.preamble?.en) base.preamble = incoming.preamble || { zh: '', en: '' };
    return base;
  }
  return {
    ...base,
    title: incoming.title || base.title,
    preamble: incoming.preamble || { zh: '', en: '' },
    chapters: incoming.chapters || [],
    appendices: incoming.appendices || [],
    updated: new Date().toISOString().slice(0, 10)
  };
}
