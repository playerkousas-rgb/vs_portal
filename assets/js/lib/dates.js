/* ============================================================
   dates.js — 日期工具（生日、週年紀算等）
   birthday 支援兩種寫法：
     "2006-06-10"  完整出生日期
     "06-10"       只知月日（未確定年份）
   ============================================================ */

export function pad2(n) { return String(n).padStart(2, '0'); }

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function nowStamp() {
  const d = new Date();
  return `${todayISO()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 解析生日 → { y, m, d, md:'MM-DD', hasYear, iso } */
export function parseBirthday(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return { y: +m[1], m: +m[2], d: +m[3], md: `${pad2(m[2])}-${pad2(m[3])}`, hasYear: true, iso: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` };
  }
  if ((m = s.match(/^(\d{1,2})-(\d{1,2})$/))) {
    return { y: null, m: +m[1], d: +m[2], md: `${pad2(m[1])}-${pad2(m[2])}`, hasYear: false, iso: `--${pad2(m[1])}-${pad2(m[2])}` };
  }
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) {
    return { y: +m[1], m: +m[2], d: +m[3], md: `${pad2(m[2])}-${pad2(m[3])}`, hasYear: true, iso: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` };
  }
  return null;
}

export function isValidBirthday(v) {
  const p = parseBirthday(v);
  if (!p) return !String(v || '').trim();
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return false;
  const probe = new Date(2000, p.m - 1, p.d);
  return probe.getMonth() === p.m - 1 && probe.getDate() === p.d;
}

/** 今年幾歲（未知出生年份 → null） */
export function ageFrom(birthday, at = todayISO()) {
  const p = parseBirthday(birthday);
  if (!p || !p.hasYear) return null;
  const [ay, am, ad] = String(at).slice(0, 10).split('-').map(Number);
  let age = ay - p.y;
  if (am < p.m || (am === p.m && ad < p.d)) age--;
  return age;
}

/** 距離下次生日幾日（0 = 今日生日）；未知年份都可以計算 */
export function daysUntilBirthday(birthday, at = todayISO()) {
  const p = parseBirthday(birthday);
  if (!p) return null;
  const [ay, am, ad] = String(at).slice(0, 10).split('-').map(Number);
  const make = (year) => new Date(year, p.m - 1, p.d);
  let next = make(ay);
  if (next < new Date(ay, am - 1, ad)) next = make(ay + 1);
  const today = new Date(ay, am - 1, ad);
  return Math.round((next - today) / 86400000);
}

/** 下一個生日嘅年份（用嚟計「將滿幾歲」） */
export function nextBirthdayYear(birthday, at = todayISO()) {
  const p = parseBirthday(birthday);
  if (!p || !p.hasYear) return null;
  const n = daysUntilBirthday(birthday, at);
  if (n === null) return null;
  const [ay, am, ad] = String(at).slice(0, 10).split('-').map(Number);
  const y = (am < p.m || (am === p.m && ad <= p.d)) ? ay : ay + 1;
  return y;
}

/** 將滿歲數 */
export function turningAge(birthday, at = todayISO()) {
  const p = parseBirthday(birthday);
  const y = nextBirthdayYear(birthday, at);
  if (!p || !p.hasYear || !y) return null;
  return y - p.y;
}

export function isBirthdayToday(birthday, at = todayISO()) {
  return daysUntilBirthday(birthday, at) === 0;
}
