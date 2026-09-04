import { describe, it, expect } from 'vitest';
import { extractArticle, htmlToText, trimArticle } from './article.js';

const prose = 'Opti9 Technologies has expanded into the Canadian cloud market by acquiring the managed cloud business of Hut 8, a transaction that adds capacity and customers.';

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('<p>Shares rose 4&#37; after the &quot;strong&quot; report</p>'))
      .toBe('Shares rose 4% after the "strong" report');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<p>real</p><script>var x = "fake"</script><style>.a{}</style>'))
      .toBe('real');
  });

  it('decodes after stripping, so encoded markup in the copy stays text', () => {
    // The other order turns an encoded tag in the prose into a real one.
    expect(htmlToText('<p>the &lt;script&gt; tag</p>')).toContain('<script>');
  });

  it('keeps paragraph breaks as newlines', () => {
    expect(htmlToText('<p>one</p><p>two</p>').split('\n')).toEqual(['one', 'two']);
  });
});

describe('extractArticle', () => {
  it('prefers the marked article body', () => {
    const html = `<nav><p>Skip to navigation Skip to main content Yahoo Finance</p></nav>
      <div data-testid="article-body"><p>${prose}</p><p>${prose}</p></div></section>`;
    const a = extractArticle(html, 'u')!;
    expect(a.source).toBe('article-body');
    expect(a.text).toContain('Opti9');
    // The navigation chrome must not come with it.
    expect(a.text).not.toContain('Skip to navigation');
  });

  it('falls back to JSON-LD when nothing is marked', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle', articleBody: prose + prose,
    })}</script>`;
    const a = extractArticle(html, 'u')!;
    expect(a.source).toBe('json-ld');
  });

  it('falls back to long paragraphs last, and says so', () => {
    // This one drags in whatever else the page has, which is why the caller is
    // told which strategy produced the text.
    const html = Array.from({ length: 4 }, () => `<p>${prose}</p>`).join('');
    const a = extractArticle(html, 'u')!;
    expect(a.source).toBe('paragraphs');
  });

  it('ignores short paragraphs, which are navigation not prose', () => {
    const html = '<p>Home</p><p>News</p><p>Markets</p><p>Sign in</p>';
    expect(extractArticle(html, 'u')).toBeNull();
  });

  it('returns null rather than a stub when there is no article', () => {
    expect(extractArticle('<html><body><div>nothing</div></body></html>', 'u')).toBeNull();
  });

  it('survives malformed JSON-LD', () => {
    const html = '<script type="application/ld+json">{ broken</script>'
      + Array.from({ length: 4 }, () => `<p>${prose}</p>`).join('');
    expect(extractArticle(html, 'u')?.source).toBe('paragraphs');
  });
});

describe('trimArticle', () => {
  it('leaves a short article alone', () => {
    expect(trimArticle('short', 4000)).toBe('short');
  });

  it('cuts at a sentence boundary when one falls late enough', () => {
    const text = 'A short sentence. '.repeat(40);
    const out = trimArticle(text, 200);
    expect(out).toMatch(/\.\s*\n\[truncated\]$/);
  });

  it('hard-cuts rather than throwing most of the text away', () => {
    // A boundary in the first 60% would mean discarding the rest to reach it,
    // so the cut stands where it is.
    const text = 'One sentence. ' + 'x'.repeat(500);
    const out = trimArticle(text, 200);
    expect(out).toContain('[truncated]');
    expect(out.length).toBeGreaterThan(190);
  });

  it('hard-cuts when there is no sentence boundary at all', () => {
    expect(trimArticle('x'.repeat(500), 100)).toContain('[truncated]');
  });
});
