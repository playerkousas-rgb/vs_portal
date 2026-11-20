#!/usr/bin/env node
/* Compare the full deployed artifacts, not just a version label. By default
 * read BADGE main from GitHub; --badge <checkout> uses a local checkout. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function identity(source) {
  const version = /\bconst\s+VS_GS_VERSION\s*=\s*['"](v\d+\.\d+)['"]/.exec(source)?.[1];
  if (!version) throw new Error('無法識別共用 GS 版本');
  return { version, hash: crypto.createHash('sha256').update(source).digest('hex') };
}
export function compare(a, b) {
  if (a.hash === b.hash) return 'identical';
  const parts = value => /^v(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const av = parts(a.version), bv = parts(b.version);
  if (!av || !bv) return 'unknown';
  for (let i = 0; i < 2; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? 'badge-newer' : 'portal-newer';
  return 'same-version-different-content';
}
function readMain(repo, file) {
  const commit = execFileSync('gh', ['api', `repos/playerkousas-rgb/${repo}/commits/main`, '--jq', '.sha'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`未能讀取 ${repo} main commit`);
  const data = JSON.parse(execFileSync('gh', ['api', `repos/playerkousas-rgb/${repo}/contents/${file}?ref=${commit}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`無法取得 ${repo} 完整 GS`);
  return { commit, text: Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8') };
}
function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--badge')) throw new Error('用法：npm run sync:check [-- --badge /path/to/vsbadge]');
  let badge, source, portalMain;
  if (args.length) {
    badge = fs.readFileSync(path.join(args[1], 'apps-script', 'Code.gs'), 'utf8');
    source = `BADGE checkout ${args[1]}`;
    console.log('本地模式未核對任何遠端 main；請自行確認兩個 checkout 最新。');
  } else {
    const remoteBadge = readMain('vsbadge', 'apps-script/Code.gs');
    portalMain = readMain('vs_portal', 'apps-script/UnifiedCode.gs');
    badge = remoteBadge.text;
    source = `BADGE main ${remoteBadge.commit}`;
  }
  const portal = fs.readFileSync(path.join(root, 'apps-script', 'UnifiedCode.gs'), 'utf8');
  const a = identity(badge), b = identity(portal), result = compare(a, b);
  console.log(`${source}: ${a.version} SHA-256 ${a.hash}`);
  console.log(`Portal 工作分支: ${b.version} SHA-256 ${b.hash}`);
  let staleOrCollision = false;
  if (portalMain) {
    const remote = identity(portalMain.text);
    console.log(`Portal main ${portalMain.commit}: ${remote.version} SHA-256 ${remote.hash}`);
    const relation = compare(remote, b);
    if (relation === 'badge-newer' || relation === 'same-version-different-content' || relation === 'unknown') {
      staleOrCollision = true;
      console.log('Portal main 較新或同版內容不同：先核對並整合，不能以本分支覆蓋。');
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', portalMain.commit, 'HEAD'], { cwd: root, stdio: 'ignore' });
    } catch {
      staleOrCollision = true;
      console.log('目前分支未確認包含最新 Portal main；請先 fetch 並整合，再決定版本。');
    }
  }
  const messages = {
    identical: '兩邊完整 GS byte-for-byte 一致。',
    'badge-newer': 'BADGE 版本較新：先讀完整 BADGE GS，再整合 Portal 功能並在最新版本上遞增。',
    'portal-newer': 'Portal 版本較新：BADGE 下次更新時應先以 Portal 的完整 GS 為基礎，再遞增版本。',
    'same-version-different-content': '相同版號但內容不同：不可當成對齊，必須先比較並整合，然後遞增版本。',
    unknown: '無法安全判斷版本先後，請人工檢查。'
  };
  if (staleOrCollision && result === 'identical') console.log('本地兩份雖然相同，仍未與較新或衝突的 Portal main 對齊。');
  else console.log(messages[result]);
  process.exitCode = result === 'identical' && !staleOrCollision ? 0 : 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`版本核對失敗：${error.message}`); process.exitCode = 3; }
}
