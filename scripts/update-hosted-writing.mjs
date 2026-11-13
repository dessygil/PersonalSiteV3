import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { syncDevto } from '../server/devto.mjs';

const expectedOrigin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
const sitePaths = new Set(['/api/sync-status', '/api/articles', '/api/sync-devto']);
let config;
let terminalSettings;
try {
  if (process.stdin.isTTY) {
    terminalSettings = execFileSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
    execFileSync('stty', ['-echo'], { stdio: 'inherit' });
  }
  console.log('Ready for Site access JSON on stdin (input is hidden).');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line.length > 16384) throw new Error('Site access input is too large.');
      try { config = JSON.parse(line); } catch { throw new Error('Expected valid Site access JSON on stdin.'); }
      break;
    }
  } finally {
    input.close();
    if (terminalSettings) {
      execFileSync('stty', [terminalSettings], { stdio: 'inherit' });
      terminalSettings = undefined;
    }
  }
  if (!config || typeof config.url !== 'string' || typeof config.token !== 'string' ||
      !config.token || config.token.length > 4096 || /\s/.test(config.token)) {
    throw new Error('Expected this Site URL and its service access token.');
  }
  let url;
  try { url = new URL(config.url); } catch { throw new Error('Expected a valid Site URL.'); }
  if (url.origin !== expectedOrigin || url.username || url.password) throw new Error('Site origin does not match this updater.');
  const origin = url.origin;
  async function site(path, options = {}) {
    if (!sitePaths.has(path)) throw new Error('Unsupported Site API path.');
    const response = await fetch(origin + path, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'OAI-Sites-Authorization': `Bearer ${config.token}`, ...options.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Site ${path} returned HTTP ${response.status}. No credentials were logged.`);
    }
    try { return await response.json(); } catch { throw new Error(`Site ${path} did not return valid JSON.`); }
  }
  const before = await site('/api/sync-status');
  const existing = await site('/api/articles');
  const result = await syncDevto({ existing });
  const saved = await site('/api/sync-devto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Des-Sync': 'devto-v1', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ ...result, expectedLastSyncedAt: before.lastSyncedAt }),
  });
  const verified = await site('/api/sync-status');
  if (verified.lastSyncedAt !== saved.lastSyncedAt || verified.count !== saved.count) throw new Error('Persisted archive verification did not match the update.');
  console.log(JSON.stringify({ status: saved.status, articles: saved.count, imported: saved.imported, updated: saved.updated, lastSyncedAt: saved.lastSyncedAt, persistedReadback: true }));
} catch (error) {
  const message = typeof error?.message === 'string' ? error.message : 'Writing update failed.';
  console.error(typeof config?.token === 'string' && config.token ? message.replaceAll(config.token, '[REDACTED]') : message);
  process.exitCode = 1;
} finally {
  if (terminalSettings) {
    try { execFileSync('stty', [terminalSettings], { stdio: 'inherit' }); } catch { /* The process is already exiting. */ }
  }
}
