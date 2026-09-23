#!/usr/bin/env node
/* ============================================================
   build-gas.mjs — 由 gasTemplate() 產生 apps-script/Code.gs
   ------------------------------------------------------------
   single source of truth = assets/js/lib/gastemplate.js
   （旅客下載嘅 Code.gs、app 內顯示嘅原始碼、repo 內 apps-script/Code.gs 三邊一定一致）
   用法：npm run build:gas
   ============================================================ */
import fs from 'node:fs';
import url from 'node:url';
import path from 'node:path';
import { gasTemplate } from '../assets/js/lib/gastemplate.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, 'apps-script', 'Code.gs');
const code = gasTemplate();
fs.writeFileSync(out, code, 'utf8');
console.log(`apps-script/Code.gs 已更新（${code.length} bytes）`);
