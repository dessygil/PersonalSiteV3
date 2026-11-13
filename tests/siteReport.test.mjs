import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'des-report-tests-'));
after(() => rm(temporary, { recursive: true, force: true }));
const preload = join(temporary, 'mock-report-service.mjs');
const origin = 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site';
const since = '2026-11-10T14:00:00.000Z';

// Exercise the real deployed-script entrypoint and stdin handling. The service
// is replaced before startup; no requests or real credentials leave the test.
await writeFile(preload, `
const origin = ${JSON.stringify(origin)};
const since = ${JSON.stringify(since)};
const messages = Array.from({ length: 25 }, (_, index) => ({
  id: 'message-' + (index + 1), receivedAt: '2026-11-11T13:00:00.000Z',
  name: 'Test sender', email: 'sender@example.com', message: ('Message ' + (index + 1) + ' ').repeat(150),
}));
let inboxReads = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin !== origin || options.redirect !== 'error'
    || options.headers.Authorization !== 'Bearer report-test-token'
    || options.headers['OAI-Sites-Authorization'] !== 'Bearer report-test-token') throw new Error('Unexpected report access.');
  if (url.pathname === '/api/private/analytics') return Response.json({ totals: { events: { pageview: 0 } } });
  if (url.pathname !== '/api/private/messages') throw new Error('Unexpected endpoint.');
  if (++inboxReads > 1) throw new Error('Report must not scan past the displayed page.');
  if (url.searchParams.get('limit') !== '20') throw new Error('Report must request exactly 20 messages.');
  if (url.searchParams.has('since') && url.searchParams.get('since') !== since) throw new Error('Inbox starting time changed.');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && cursor !== 'after-20') throw new Error('Unexpected cursor.');
  const start = cursor === 'after-20' ? 20 : 0;
  const more = start === 0;
  return Response.json({
    messages: messages.slice(start, start + 20), since, limit: 20, truncated: more,
    nextCursor: more && process.env.REPORT_FIXTURE_MODE !== 'missing-cursor' ? 'after-20' : null,
  });
};
`);

function runReport(extra = {}, mode = 'normal') {
  return spawnSync(process.execPath, ['--import', preload, join(root, 'scripts/read-site-report.mjs')], {
    input: JSON.stringify({ url: origin, token: 'report-test-token', includeMessages: true, ...extra }) + '\n',
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, REPORT_FIXTURE_MODE: mode },
  });
}
function report(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(!result.stdout.includes('report-test-token'));
  assert.ok(!result.stderr.includes('report-test-token'));
  const outputs = result.stdout.split('\n').filter(line => line.startsWith('{'));
  assert.equal(outputs.length, 1);
  return JSON.parse(outputs[0]);
}

test('a 25-message inbox is completely reachable through displayed 20-message continuations', () => {
  const first = report(runReport()).inbox;
  assert.equal(first.count, 20);
  assert.equal(first.messages.length, 20);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 'after-20');
  assert.equal(first.since, since);
  assert.equal(Object.hasOwn(first, 'omittedMessages'), false);
  assert.ok(first.messages.every(message => message.message.length === 1000 && message.messageTruncated));

  const next = report(runReport({ since: first.since, cursor: first.nextCursor, fullMessages: true })).inbox;
  assert.equal(next.count, 5);
  assert.equal(next.messages.length, 5);
  assert.equal(next.hasMore, false);
  assert.equal(next.truncated, false);
  assert.equal(next.nextCursor, null);
  assert.equal(next.since, first.since);
  assert.ok(next.messages.every(message => message.message.length > 1000 && !message.messageTruncated));
  const ids = [...first.messages, ...next.messages].map(message => message.id);
  assert.equal(new Set(ids).size, 25);
  assert.deepEqual(ids, Array.from({ length: 25 }, (_, index) => `message-${index + 1}`));
});

test('a truncated service page without a cursor fails instead of claiming completeness', () => {
  const result = runReport({}, 'missing-cursor');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /incomplete and has no continuation/);
  assert.ok(!result.stdout.split('\n').some(line => line.startsWith('{')));
  assert.ok(!result.stderr.includes('report-test-token'));
});

test('traffic-only reports do not fetch or disclose inbox messages', () => {
  const result = report(runReport({ includeMessages: false }));
  assert.equal(Object.hasOwn(result, 'inbox'), false);
  assert.deepEqual(result.analytics, { totals: { events: { pageview: 0 } } });
});
