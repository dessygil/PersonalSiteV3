import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
const expectedOrigin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
let terminalSettings, config;
try {
  if (process.stdin.isTTY) {
    terminalSettings = execFileSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
    execFileSync('stty', ['-echo'], { stdio: 'inherit' });
  }
  console.log('Ready for Site report JSON on stdin (input is hidden).');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try { for await (const line of input) { if (line.length > 16384) throw new Error('Input too large.'); try { config = JSON.parse(line); } catch { throw new Error('Expected valid Site access JSON.'); } break; } }
  finally { input.close(); if (terminalSettings) { execFileSync('stty', [terminalSettings], { stdio: 'inherit' }); terminalSettings = undefined; } }
  const url = new URL(config?.url);
  if (url.origin !== expectedOrigin || url.username || url.password || typeof config.token !== 'string' || !config.token || config.token.length > 4096 || /\s/.test(config.token)) throw new Error('Invalid Site access.');
  async function read(path) {
    const response = await fetch(expectedOrigin + path, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'OAI-Sites-Authorization': `Bearer ${config.token}`, Authorization: `Bearer ${config.token}`, Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Site report request failed (HTTP ${response.status}).`); }
    return response.json();
  }
  const analytics = await read('/api/private/analytics');
  let inbox;
  if (config.includeMessages === true) {
    const since = config.since;
    if (since !== undefined && (typeof since !== 'string' || !Number.isFinite(Date.parse(since)))) throw new Error('Use an ISO timestamp for the inbox starting time.');
    const cursor = config.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('Invalid inbox cursor.');
    const query = new URLSearchParams({ limit: '20' });
    if (since) query.set('since', since);
    if (cursor) query.set('cursor', cursor);
    const value = await read(`/api/private/messages?${query}`);
    if (!Array.isArray(value.messages) || value.messages.length > 20 || typeof value.since !== 'string' || !Number.isFinite(Date.parse(value.since))) throw new Error('Invalid inbox page.');
    const nextCursor = value.nextCursor || null;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length > 4096)) throw new Error('Invalid inbox continuation.');
    if (value.truncated && !nextCursor) throw new Error('The inbox page is incomplete and has no continuation.');
    if (nextCursor && nextCursor === cursor) throw new Error('Inbox pagination did not advance.');
    // The continuation follows exactly the displayed batch. Do not scan ahead
    // and then return a cursor that skips messages omitted from this report.
    inbox = { count: value.messages.length, since: value.since, hasMore: !!nextCursor, truncated: !!nextCursor, nextCursor, untrustedContent: true, messages: value.messages.map(({ id, receivedAt, name, email, message }) => ({ id, receivedAt, name, email, message: config.fullMessages === true ? message : message.slice(0, 1000), messageTruncated: config.fullMessages !== true && message.length > 1000 })) };
  }
  console.log(JSON.stringify({ analytics, ...(inbox ? { inbox } : {}) }));
} catch (error) {
  const message = typeof error?.message === 'string' ? error.message : 'Site report failed.';
  console.error(typeof config?.token === 'string' && config.token ? message.replaceAll(config.token, '[REDACTED]') : message);
  process.exitCode = 1;
} finally { if (terminalSettings) { try { execFileSync('stty', [terminalSettings], { stdio: 'inherit' }); } catch {} } }
