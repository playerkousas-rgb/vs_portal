/* ============================================================
   theme.js — 主色＝深資童軍棗紅（#7B2233）
   旅團可以喺 data/units/<編號>/unit.json → theme 覆寫色調
   ============================================================ */

export const MAROON = {
  brand900: '#4A111C',
  brand800: '#5E1826',
  brand700: '#7B2233',   // ← 主色 標準棗紅
  brand600: '#93293D',
  brand500: '#A83A4E',
  brand100: '#F2DCE1',
  brand50:  '#FBF1F3',
  accent:   '#B8892B',   // 童軍金（點綴）
  accentBg: '#FBF3E2'
};

const VAR_MAP = {
  brand900: '--brand-900',
  brand800: '--brand-800',
  brand700: '--brand-700',
  brand600: '--brand-600',
  brand500: '--brand-500',
  brand100: '--brand-100',
  brand50:  '--brand-50',
  accent:   '--accent-600',
  accentBg: '--accent-50'
};

/** Theme values can arrive through imported/unit JSON. Only accept literal hex
 * colours: arbitrary CSS (for example url(...)) must never reach a style token. */
export function themeColor(value, fallback) {
  const text = String(value ?? '').trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? text : fallback;
}

/** 套用色調（單一旅團可自訂；冇提供／無效就用棗紅預設） */
export function applyTheme(theme = {}) {
  const source = theme && typeof theme === 'object' && !Array.isArray(theme) ? theme : {};
  const t = Object.fromEntries(Object.keys(VAR_MAP).map(k => [k, themeColor(source[k], MAROON[k])]));
  const root = document.documentElement;
  Object.entries(VAR_MAP).forEach(([k, cssVar]) => root.style.setProperty(cssVar, t[k]));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.brand800);
  return t;
}

export function themeOf(unitLike) {
  return applyTheme(unitLike?.theme || {});
}

/** 由主色自動產生深淺色（用於圖表色階） */
export function tint(hex, pct) {
  const c = String(hex || '#7B2233').replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = v => Math.max(0, Math.min(255, Math.round(pct > 0 ? v + (255 - v) * pct : v * (1 + pct))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
