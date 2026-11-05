// 메인(잠금) 화면: 비밀번호 확인 전에는 저장된 데이터를 읽지 않는다.
// 공용 비밀번호의 원문은 코드에 두지 않고 PBKDF2 해시만 둔다.
// 한계: 서버 인증이 아니라 브라우저 안의 잠금이므로, 저장 데이터 자체를 암호화하지는 않는다.

import { $ } from './util.js';

const SS_UNLOCKED = 'gpscall.unlocked';
const PASSWORD_SALT = '03a7f89dcc3a6a189621ac170b0e2a9c';
const PASSWORD_HASH = 'e06b5973811a0dc093f13031bf802101d3809e982da4d1ce45ca3ba5b195f418';
const PBKDF2_ITERATIONS = 600000;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

async function isCorrectPassword(password) {
  // 입력기·OS에 따라 달라질 수 있는 한글 조합 형태를 통일
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(PASSWORD_SALT), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toHex(new Uint8Array(bits)) === PASSWORD_HASH;
}

/** 지금 잠그고 메인 화면으로 돌아감 */
export function lockNow() {
  sessionStorage.removeItem(SS_UNLOCKED);
  location.reload();
}

/** 비밀번호를 확인할 때까지 기다림. 같은 탭에서는 닫기 전까지 다시 묻지 않음 */
export function requireUnlock() {
  return new Promise((resolve) => {
    const unlock = () => {
      document.body.classList.remove('locked');
      $('#gate').hidden = true;
      resolve();
    };
    localStorage.removeItem('gpscall.auth'); // v1.5.0에서 브라우저에 저장하던 비밀번호 해시 정리
    if (sessionStorage.getItem(SS_UNLOCKED) === PASSWORD_HASH) { unlock(); return; }

    const password = $('#gatePw');
    const error = $('#gateError');
    const submit = $('#gateSubmit');
    password.focus();

    if (!window.crypto?.subtle) {
      error.textContent = '보안 연결(https 또는 localhost)에서만 사용할 수 있습니다.';
      submit.disabled = true;
      return;
    }

    $('#gateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        if (await isCorrectPassword(password.value)) {
          sessionStorage.setItem(SS_UNLOCKED, PASSWORD_HASH);
          unlock();
        } else {
          error.textContent = '비밀번호가 맞지 않습니다.';
          password.select();
        }
      } finally {
        submit.disabled = false;
      }
    });
  });
}
