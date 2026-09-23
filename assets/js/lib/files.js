/* ============================================================
   files.js — 相片／檔案處理（手機影相、壓縮、預覽、儲存用量）
   冇後端都可以用：壓縮成 data URL 存喺瀏覽器，
   需要時可以匯出、或者跟「總表同步」送去 Google Sheet。
   ============================================================ */

export const IMG_MAX = 1400;        // 最長邊（px）
export const IMG_QUALITY = 0.72;    // JPEG 質素

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}

/** 由 File／Blob 讀成 data URL */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('讀取檔案失敗'));
    fr.onload = () => resolve(String(fr.result || ''));
    fr.readAsDataURL(file);
  });
}

export function isImage(file) {
  return !!(file && (/^image\//.test(file.type || '') || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(file.name || '')));
}

/**
 * 壓縮相片（canvas 重繪）。HEIC 或唔支援嘅格式會原樣回傳（連提示）。
 * @returns {Promise<{dataUrl,name,type,size,w,h,originalSize,compressed}>}
 */
export async function compressImage(file, { max = IMG_MAX, quality = IMG_QUALITY } = {}) {
  const originalSize = file.size || 0;
  const raw = await fileToDataUrl(file);
  if (!/^image\//.test(file.type || '') && !/^data:image\//.test(raw)) {
    return { dataUrl: raw, name: file.name || 'file', type: file.type || 'application/octet-stream', size: raw.length, originalSize, compressed: false };
  }
  try {
    const img = await loadImage(raw);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    // 白底（避免 PNG 透明位變黑）
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    // 太細嘅相唔好變大
    if (dataUrl.length > raw.length && /jpeg|jpg|png/i.test(file.type || '')) dataUrl = raw;
    return {
      dataUrl, name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg',
      type: 'image/jpeg', size: dataUrl.length, originalSize, w, h,
      compressed: dataUrl.length < raw.length
    };
  } catch (e) {
    // 例如 iPhone HEIC：瀏覽器畫唔到 → 原樣保存，等用戶自己處理
    return { dataUrl: raw, name: file.name || 'photo', type: file.type || 'image/*', size: raw.length, originalSize, compressed: false, unsupported: true };
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('無法讀取圖片'));
    img.src = src;
  });
}

/** 一次過處理多張相（手機影相／相簿） */
export async function compressAll(fileList, opts) {
  const out = [];
  for (const f of Array.from(fileList || [])) {
    try { out.push(await compressImage(f, opts)); } catch (e) { /* 跳過壞檔 */ }
  }
  return out;
}

/* ---------------- 儲存用量 ---------------- */

/** 目前 localStorage 用量（同埋相片佔幾多） */
export function storageUsage(db) {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!String(k).startsWith('venture82.')) continue;
      total += String(localStorage.getItem(k) || '').length + String(k).length;
    }
  } catch (e) { /* ignore */ }
  let photos = 0, photoCount = 0;
  const scan = (arr) => (arr || []).forEach(row => {
    (row.photos || []).forEach(p => { photos += String(p.dataUrl || '').length; photoCount++; });
    (row.attachments || []).forEach(p => { photos += String(p.dataUrl || '').length; photoCount++; });
  });
  if (db) { scan(db.transactions); scan(db.claims); scan(db.invItems); scan(db.invLoans); scan(db.notices); scan(db.members); }
  return { total, photos, photoCount, percent: Math.min(100, Math.round(total / (5 * 1024 * 1024) * 100)) };
}

/** 相片統計（每張大約幾大） */
export function photoStats(photos) {
  const list = photos || [];
  return { count: list.length, bytes: list.reduce((s, p) => s + String(p.dataUrl || '').length, 0) };
}

/* ---------------- 下載／匯出 ---------------- */

export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename || 'photo.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 匯出全部相片（逐張下載；瀏覽器限制冇 zip，所以隔開少少） */
export function downloadPhotos(photos, prefix = 'receipt') {
  const list = (photos || []).filter(p => p?.dataUrl);
  list.forEach((p, i) => setTimeout(() => downloadDataUrl(p.dataUrl, `${prefix}-${i + 1}-${p.name || 'photo.jpg'}`), i * 350));
  return list.length;
}

/** 壓縮過嘅相片轉細圖（列表用，唔會拖慢頁面） */
export function thumbUrl(photo, max = 240) {
  return photo?.dataUrl || '';
}
