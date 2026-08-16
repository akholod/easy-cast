import { describe, expect, it } from 'vitest';
import { classifyExtension, checkSize } from '../src/media/mime.js';
import { MIME_TABLE, MIME_TABLE_SOURCE } from '../src/media/mime-table.js';

describe('classifyExtension', () => {
  it.each(MIME_TABLE)('classifies $extension as $category / $contentType', (row) => {
    const kind = classifyExtension(`file${row.extension}`);
    expect(kind).toEqual({
      contentType: row.contentType,
      category: row.category,
      warnBytes: row.warnBytes,
    });
  });

  it('returns undefined for an unknown extension', () => {
    expect(classifyExtension('report.pdf')).toBeUndefined();
    expect(classifyExtension('README')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(classifyExtension('Shot.PNG')).toEqual({
      contentType: 'image/png',
      category: 'image',
      warnBytes: 10 * 1024 * 1024,
    });
  });

  it('uses only the final extension of a multi-dot filename', () => {
    expect(classifyExtension('a.b.mp4')).toEqual({
      contentType: 'video/mp4',
      category: 'video',
      warnBytes: 10 * 1024 * 1024,
    });
  });
});

describe('checkSize', () => {
  const image = classifyExtension('shot.png')!;

  it('is ok below the documented threshold', () => {
    expect(checkSize(image.warnBytes - 1, image)).toEqual({ level: 'ok' });
  });

  it('warns, and does not reject, a file at the documented threshold', () => {
    const result = checkSize(image.warnBytes, image);
    expect(result.level).toBe('warn');
    expect(result.level).not.toBe('reject');
  });

  it('warns, and does not reject, a file between the documented threshold and the local policy limit', () => {
    const result = checkSize(50 * 1024 * 1024, image);
    expect(result.level).toBe('warn');
  });

  it('rejects with local_policy_limit above 100 MB', () => {
    const result = checkSize(100 * 1024 * 1024 + 1, image);
    expect(result).toMatchObject({ level: 'reject', policy: 'local_policy_limit' });
    if (result.level === 'reject') {
      expect(result.message).toMatch(/local_policy_limit|policy/i);
    }
  });

  it('does not reject a file at exactly the local policy limit', () => {
    const result = checkSize(100 * 1024 * 1024, image);
    expect(result.level).not.toBe('reject');
  });
});

describe('mime-table provenance', () => {
  it('records where the table came from and when', () => {
    expect(MIME_TABLE_SOURCE.sourceUrl).toMatch(/^https:\/\//);
    expect(MIME_TABLE_SOURCE.retrievedAt).toBeTruthy();
  });
});
