import { describe, expect, it } from 'vitest';
import { redact } from '../../src/secret/redact.js';

const FAKE = 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123';

describe('redact', () => {
  it.each([
    ['ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123'],
    ['gho_FAKETOKENFAKETOKENFAKETOKENFAKE0123'],
    ['ghu_FAKETOKENFAKETOKENFAKETOKENFAKE0123'],
    ['ghs_FAKETOKENFAKETOKENFAKETOKENFAKE0123'],
    ['ghr_FAKETOKENFAKETOKENFAKETOKENFAKE0123'],
    ['github_pat_11ABCDEFG0FAKEFAKEFAKE_FAKETOKENFAKETOKENFAKETOKENFAKE0123'],
  ])('masks %s wherever it appears in a line', (token) => {
    const masked = redact(`failed to upload with token ${token} (attempt 1)`);
    expect(masked).not.toContain(token);
    expect(masked).toContain('[redacted]');
  });

  it('leaves text that merely looks token-ish alone', () => {
    const text = 'ghp_short and github.com/akholod/easy-cast and ghost_writer';
    expect(redact(text)).toBe(text);
  });

  it('masks an Authorization header value but keeps the header name', () => {
    expect(redact(`Authorization: Bearer ${FAKE}`)).toBe('Authorization: [redacted]');
    expect(redact('authorization: token abcdef')).toBe('authorization: [redacted]');
  });

  it('masks a Set-Cookie value including everything after it on the line', () => {
    expect(redact('Set-Cookie: _gh_sess=abc123; Path=/; HttpOnly')).toBe('Set-Cookie: [redacted]');
  });

  it('keeps a redacted JSON document parseable', () => {
    const json = JSON.stringify({ authorization: `Bearer ${FAKE}`, url: 'https://example.test' });
    const masked = redact(json);
    expect(masked).not.toContain(FAKE);
    expect(JSON.parse(masked)).toEqual({ authorization: '[redacted]', url: 'https://example.test' });
  });

  it.each(['jwt', 'token', 'sig', 'X-Amz-Signature', 'X-Amz-Credential'])(
    'masks the %s query parameter of a signed URL',
    (param) => {
      const url = `https://objects.example.test/asset?${param}=SECRETVALUE&other=keep`;
      const masked = redact(url);
      expect(masked).not.toContain('SECRETVALUE');
      expect(masked).toContain('other=keep');
    },
  );

  it('stops at the closing paren so a markdown link survives', () => {
    expect(redact('![a](https://e.test/x?jwt=SECRETVALUE)')).toBe('![a](https://e.test/x?jwt=[redacted])');
  });

  it('is idempotent, so redacting an already-redacted string is safe', () => {
    const text = `Authorization: Bearer ${FAKE}\nGET /a?jwt=xyz&sig=abc\nSet-Cookie: s=1`;
    expect(redact(redact(text))).toBe(redact(text));
  });

  it('masks every occurrence, not just the first', () => {
    const masked = redact(`${FAKE} then ${FAKE}`);
    expect(masked).toBe('[redacted] then [redacted]');
  });
});
