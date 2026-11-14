/* ============================================================
   safe-json.js — bounded JSON loader for public/read-only pages
   ------------------------------------------------------------
   Query-string sources are untrusted. Only same-origin URLs or cross-origin
   HTTPS are fetched; executable schemes, oversized responses, deep trees and
   prototype-pollution keys are rejected before callers merge/render data.
   ============================================================ */

import { safeHref } from './util.js';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function assertSafeJsonTree(value, { maxDepth = 60, maxNodes = 250000 } = {}) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++nodes > maxNodes) throw new Error('JSON 資料結構過大');
    if (current.depth > maxDepth) throw new Error('JSON 資料結構層數過深');
    const item = current.value;
    if (item === null || typeof item !== 'object') continue;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
      && Object.getPrototypeOf(item) !== null) throw new Error('JSON 包含不安全物件類型');
    for (const key of Object.keys(item)) {
      if (UNSAFE_KEYS.has(key)) throw new Error(`JSON 包含不安全欄位：${key}`);
      stack.push({ value: item[key], depth: current.depth + 1 });
    }
  }
  return true;
}

export async function loadSafeJson(url, { maxBytes = 4 * 1024 * 1024, allowExternalHttps = true } = {}) {
  const cap = Number(maxBytes);
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('JSON 安全上限不正確');
  const target = safeHref(url, { allowRelative: true, allowContact: false });
  if (target === '#') throw new Error('JSON 來源網址唔安全');

  const base = globalThis.location?.href || 'https://local.invalid/';
  const here = new URL(base);
  const parsed = new URL(target, here);
  if (parsed.origin !== here.origin && (!allowExternalHttps || parsed.protocol !== 'https:')) {
    throw new Error('跨網站 JSON 來源只接受 HTTPS');
  }

  const response = await fetch(target);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > cap) throw new Error(`JSON 內容超出 ${Math.round(cap / 1024 / 1024)}MB 安全上限`);
  const text = await response.text();
  const actual = typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length;
  if (actual > cap) throw new Error(`JSON 內容超出 ${Math.round(cap / 1024 / 1024)}MB 安全上限`);
  const parsedJson = JSON.parse(text);
  assertSafeJsonTree(parsedJson);
  return parsedJson;
}
