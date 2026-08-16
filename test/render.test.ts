import { describe, expect, it } from 'vitest';
import { renderAttachment, renderBatch, escapeMarkdownLabel } from '../src/render.js';

describe('renderAttachment — image', () => {
  it('renders a markdown image reference', () => {
    const out = renderAttachment({
      url: 'https://gh.example/a.png',
      category: 'image',
      name: 'shot.png',
    });
    expect(out).toBe('![shot.png](https://gh.example/a.png)');
  });
});

describe('renderAttachment — video', () => {
  const url = 'https://gh.example/clip.mp4';

  it('renders a bare URL, occupying a line by itself', () => {
    const out = renderAttachment({ url, category: 'video', name: 'clip.mp4' });
    const lines = out.split('\n');
    expect(lines.some((line) => line === url)).toBe(true);
  });

  it('never wraps the URL in markdown', () => {
    const out = renderAttachment({ url, category: 'video', name: 'clip.mp4' });
    expect(out).toBe(url);
  });

  it('puts a caption on its own line above the URL, never sharing a line with it', () => {
    const out = renderAttachment({ url, category: 'video', name: 'clip.mp4', caption: 'Repro steps' });
    const lines = out.split('\n');
    const urlLineIndex = lines.indexOf(url);
    expect(urlLineIndex).toBeGreaterThan(-1);
    expect(lines[urlLineIndex]).toBe(url);
    expect(lines[0]).toBe('Repro steps');
  });
});

describe('renderBatch', () => {
  it('renders a batch of three mixed attachments in argv order with a shared caption on top', () => {
    const items = [
      { url: 'https://gh.example/one.png', category: 'image' as const, name: 'before.png' },
      { url: 'https://gh.example/two.mp4', category: 'video' as const, name: 'repro.mp4' },
      { url: 'https://gh.example/three.png', category: 'image' as const, name: 'after.png' },
    ];

    const out = renderBatch(items, 'Regression repro');

    expect(out).toBe(
      'Regression repro\n\n' +
        '![before.png](https://gh.example/one.png)\n\n' +
        'https://gh.example/two.mp4\n\n' +
        '![after.png](https://gh.example/three.png)',
    );
  });

  it('keeps the batch video URL alone on its own line', () => {
    const items = [
      { url: 'https://gh.example/one.png', category: 'image' as const, name: 'before.png' },
      { url: 'https://gh.example/two.mp4', category: 'video' as const, name: 'repro.mp4' },
    ];
    const out = renderBatch(items, 'Regression repro');
    expect(out.split('\n')).toContain('https://gh.example/two.mp4');
  });

  it('omits the caption block entirely when none is given', () => {
    const items = [{ url: 'https://gh.example/one.png', category: 'image' as const, name: 'before.png' }];
    expect(renderBatch(items)).toBe('![before.png](https://gh.example/one.png)');
  });
});

describe('escapeMarkdownLabel', () => {
  it('escapes a closing bracket', () => {
    expect(escapeMarkdownLabel('a]b')).toBe('a\\]b');
  });

  it('escapes an opening bracket', () => {
    expect(escapeMarkdownLabel('a[b')).toBe('a\\[b');
  });

  it('escapes a closing paren', () => {
    expect(escapeMarkdownLabel('a)b')).toBe('a\\)b');
  });

  it('escapes an opening paren', () => {
    expect(escapeMarkdownLabel('a(b')).toBe('a\\(b');
  });

  it('escapes a literal backslash without double-escaping the brackets it introduces', () => {
    expect(escapeMarkdownLabel('a\\b')).toBe('a\\\\b');
  });

  it('replaces a raw newline so a label can never span multiple lines', () => {
    expect(escapeMarkdownLabel('a\nb')).toBe('a b');
    expect(escapeMarkdownLabel('a\r\nb')).toBe('a b');
    expect(escapeMarkdownLabel('a\rb')).toBe('a b');
  });

  it('escapes ] ( \\ and a raw newline together so a crafted name cannot break out of its label', () => {
    const name = 'evil](url)\\injected\n-->name';
    expect(escapeMarkdownLabel(name)).toBe('evil\\]\\(url\\)\\\\injected -->name');
  });
});

describe('injection resistance', () => {
  it('renders a fully attacker-controlled name as a single well-formed image line that cannot break out or terminate the surrounding comment early', () => {
    const name = 'evil](url)\\injected\n-->name';
    const url = 'https://gh.example/x.png';

    const out = renderAttachment({ url, category: 'image', name });

    // No raw newline escaped through: the whole render is exactly one line.
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toBe('![evil\\]\\(url\\)\\\\injected -->name](https://gh.example/x.png)');
    // The label cannot terminate early: there is exactly one unescaped `](`
    // boundary, and it is immediately followed by the real URL and a single
    // closing paren — an attacker-supplied `-->` never opens or closes an
    // HTML comment because render.ts never emits one.
    expect(out).toMatch(/^!\[.*\]\(https:\/\/gh\.example\/x\.png\)$/);
  });

  it('renders an attacker-controlled caption as its own escaped line that cannot merge with the URL line', () => {
    const caption = 'end early\n-->\n<!-- fake';
    const url = 'https://gh.example/clip.mp4';

    const out = renderAttachment({ url, category: 'video', name: 'clip.mp4', caption });

    const lines = out.split('\n');
    expect(lines).toEqual(['end early --> <!-- fake', '', url]);
    expect(lines[2]).toBe(url);
  });
});
