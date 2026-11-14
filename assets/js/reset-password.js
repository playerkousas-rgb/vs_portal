import { postBackend, beFromQuery } from './lib/gateway.js';

const q = new URLSearchParams(location.search);
const unit = q.get('unit') || '';
const token = q.get('token') || '';
const form = document.querySelector('#resetForm');
const msg = document.querySelector('#message');

if (!unit || !token) {
  msg.textContent = '重設連結資料不完整，請重新申請。';
  form.querySelector('button[type="submit"]').disabled = true;
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  msg.textContent = '';
  const password = document.querySelector('#password').value;
  const confirm = document.querySelector('#confirm').value;
  if (password.length < 4) { msg.textContent = '密碼最少要 4 位'; return; }
  if (password !== confirm) { msg.textContent = '兩次密碼不一致'; return; }
  const result = await postBackend({ action: 'authResetByToken', unit, token, newPassword: password },
    { unit, execUrl: beFromQuery(), timeoutMs: 60000 });
  const data = result.json || {};
  if (!result.ok || data.success === false) {
    msg.textContent = data.error || result.error || '連結無效或已過期';
    return;
  }
  form.innerHTML = '<div class="note-box success">密碼已重設。請返回系統，用新密碼登入。</div>';
});
