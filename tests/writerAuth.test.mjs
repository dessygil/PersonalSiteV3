import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeWriter } from '../server/writerAuth.mjs';

const fakeToken = 'fake-test-token.only-for-unit-tests_123';
const hash = async token => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join('');
const request = headers => new Request('https://site.example/api/import-articles', { method: 'POST', headers });

test('accepts the matching bearer token and rejects an incorrect token', async () => {
  const env = { WRITING_SERVICE_TOKEN_SHA256: await hash(fakeToken) };
  assert.equal(await authorizeWriter(request({ Authorization: `Bearer ${fakeToken}` }), env), true);
  assert.equal(await authorizeWriter(request({ Authorization: 'Bearer wrong-test-token' }), env), false);
  assert.equal(await authorizeWriter(request({ Authorization: `bEaReR ${fakeToken}` }), env), true);
  assert.equal(await authorizeWriter(request({ Authorization: `Bearer ${fakeToken}` }), { WRITING_SERVICE_TOKEN_SHA256: env.WRITING_SERVICE_TOKEN_SHA256.toUpperCase() }), true);
});

test('fails closed when the verifier or authorization is missing', async () => {
  const env = { WRITING_SERVICE_TOKEN_SHA256: await hash(fakeToken) };
  assert.equal(await authorizeWriter(request({}), env), false);
  assert.equal(await authorizeWriter(request({ Authorization: `Bearer ${fakeToken}` }), {}), false);
  assert.equal(await authorizeWriter(request({ Authorization: `Bearer ${fakeToken}` }), undefined), false);
  assert.equal(await authorizeWriter(null, env), false);
});

test('static sync and platform bypass headers cannot independently authorize writes', async () => {
  const env = { WRITING_SERVICE_TOKEN_SHA256: await hash(fakeToken) };
  assert.equal(await authorizeWriter(request({ 'X-Des-Sync': 'devto-v1' }), env), false);
  assert.equal(await authorizeWriter(request({ 'X-Des-Sync': 'devto-v1', 'OAI-Sites-Authorization': `Bearer ${fakeToken}` }), env), false);
});

test('rejects malformed verifier values', async () => {
  for (const verifier of [null, 123, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ` ${'a'.repeat(63)}`, `${'a'.repeat(63)}\n`, `sha256:${'a'.repeat(64)}`]) {
    assert.equal(await authorizeWriter(request({ Authorization: `Bearer ${fakeToken}` }), { WRITING_SERVICE_TOKEN_SHA256: verifier }), false);
  }
});

test('rejects malformed, combined, unsupported or oversized authorization values', async () => {
  const env = { WRITING_SERVICE_TOKEN_SHA256: await hash(fakeToken) };
  for (const authorization of ['', 'Bearer', 'Bearer ', `Basic ${fakeToken}`, `Bearer  ${fakeToken}`, `Bearer ${fakeToken}, Bearer second`, 'Bearer x=y', 'Bearer =', `Bearer ${'a'.repeat(4097)}`]) {
    assert.equal(await authorizeWriter(request({ Authorization: authorization }), env), false);
  }
});
