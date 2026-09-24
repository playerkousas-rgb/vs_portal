/* ============================================================
   notice-fields.js — 通告「活動詳情」欄位（單一來源）
   ------------------------------------------------------------
   為咩要有呢張清單：通告要填嘅資料來來去去都係嗰幾樣。
   以前散落喺編輯器／詳情頁／公開頁／分享文字／列印／總表同步
   六個地方，加一個欄位就要改六處。而家全部讀呢張清單。

   參考實際通告（露營、訓練班、週年活動都係嗰幾樣）得出嘅欄位組合：
     日期、截止、地點、集合時間及地點、解散時間及地點、
     內容／程序、服裝、費用、名額、查詢
   加欄位：喺下面陣列加一行，六個地方自動跟（連總表分頁都會多一欄）。
   ============================================================ */

export const NOTICE_INFO_FIELDS = [
  { key: 'eventDate', label: '活動日期', type: 'date' },
  { key: 'deadline', label: '報名截止', type: 'date' },
  { key: 'venue', label: '活動地點', type: 'text', wide: true, ph: '例：西貢創興水上活動中心' },
  { key: 'assembly', label: '集合時間及地點', type: 'text', wide: true, ph: '例：0830 團址地下' },
  { key: 'dismissal', label: '解散時間及地點', type: 'text', wide: true, ph: '例：1630 團址地下' },
  { key: 'programme', label: '內容／程序', type: 'text', wide: true, ph: '例：覆誓、頒發年度獎項、宿營、營火會、夜行' },
  { key: 'dress', label: '服裝', type: 'text', ph: '例：整齊制服 及 戶外制服' },
  { key: 'fee', label: '費用', type: 'text', ph: '例：$280（已包括 $70 津貼）' },
  { key: 'quota', label: '名額', type: 'number', ph: '0 = 不限' },
  { key: 'enquiry', label: '查詢', type: 'text', ph: '例：6107 0452 莫先生' }
];

/** 一張通告有值嘅詳情 [ [欄位名, 顯示值], … ]（空嘅唔會出現） */
export function noticeInfoRows(n) {
  const out = [];
  NOTICE_INFO_FIELDS.forEach(f => {
    const raw = n?.[f.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    if (f.key === 'quota') return out.push([f.label, `${raw} 人`]);
    out.push([f.label, String(raw)]);
  });
  return out;
}

/** 總表同步用：呢啲欄位會寫入「通告」分頁（點路徑寫法，同 schema 一致） */
export const NOTICE_SYNC_KEYS = NOTICE_INFO_FIELDS.map(f => f.key);
