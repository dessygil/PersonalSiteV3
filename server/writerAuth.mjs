/** Verify the writer's service credential independently of Site visibility. */
export async function authorizeWriter(request, env) {
  try {
    const verifier = env?.WRITING_SERVICE_TOKEN_SHA256;
    if (typeof verifier !== 'string' || verifier.length !== 64 || !/^[a-f0-9]{64}$/i.test(verifier)) {
      return false;
    }
    const authorization = request?.headers?.get('Authorization');
    if (typeof authorization !== 'string') return false;
    const parts = authorization.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;
    const token = parts[1];
    // RFC 6750 bearer-token characters; reject empty/combined/oversized values.
    if (!token || token.length > 4096 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || /\s/.test(token)) {
      return false;
    }
    const expected = new Uint8Array(32);
    for (let index = 0; index < expected.length; index += 1) {
      expected[index] = Number.parseInt(verifier.slice(index * 2, index * 2 + 2), 16);
    }
    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    if (actual.length !== expected.length) return false;
    // Both digests always have 32 bytes. Never return early based on a byte.
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= actual[index] ^ expected[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}
