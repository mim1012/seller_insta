'use strict';
const { execFile } = require('child_process');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function runAdb(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message = [err.message, stderr && stderr.trim()].filter(Boolean).join('\n');
        reject(err);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function adbPrefix(adbSerial) {
  const serial = String(adbSerial || '').trim();
  return serial ? ['-s', serial] : [];
}

async function resetMobileData(config = {}) {
  const waitSeconds = Math.max(1, Number(config.waitSeconds) || 8);
  const prefix = adbPrefix(config.adbSerial);
  await runAdb(prefix.concat(['shell', 'svc', 'data', 'disable']));
  await sleep(waitSeconds * 1000);
  await runAdb(prefix.concat(['shell', 'svc', 'data', 'enable']));
  await sleep(waitSeconds * 1000);
  return { ok: true, message: '모바일 데이터 재연결 완료' };
}

async function listDevices() {
  const out = await runAdb(['devices']);
  const devices = out.split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0])
    .map(([serial, status]) => ({ serial, status }));
  return { ok: true, devices };
}

module.exports = { resetMobileData, listDevices };
