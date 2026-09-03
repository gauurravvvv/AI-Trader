import { describe, it, expect } from 'vitest';
import {
  EdgarClient, htmlToText, trimFiling, stripSgmlEnvelope, findExhibitDoc, EARNINGS_ITEM,
} from './client.js';

describe('EdgarClient.padCik', () => {
  it('zero-pads to 10 digits', () => {
    expect(EdgarClient.padCik('320193')).toBe('0000320193');
  });
  it('strips a CIK prefix', () => {
    expect(EdgarClient.padCik('CIK0000320193')).toBe('0000320193');
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('<p>Revenue &amp; profit</p>')).toBe('Revenue & profit');
  });
  it('drops script and style blocks entirely', () => {
    const t = htmlToText('<style>.x{color:red}</style><p>Real</p><script>evil()</script>');
    expect(t).toBe('Real');
  });
  it('turns table cells into tabs so columns stay separable', () => {
    expect(htmlToText('<tr><td>A</td><td>B</td></tr>')).toContain('A');
  });
  it('collapses runaway whitespace', () => {
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });
});

describe('stripSgmlEnvelope', () => {
  it('removes the SEC document header that precedes the real content', () => {
    const raw =
      '<DOCUMENT>\n<TYPE>EX-99.1\n<SEQUENCE>2\n<FILENAME>q2fy27pr.htm\n' +
      '<DESCRIPTION>EX-99.1\n<TEXT>\n<html><body><p>Revenue of $96.2 billion</p></body></html>';
    const out = htmlToText(raw);
    expect(out).toContain('Revenue of $96.2 billion');
    // the header text must not survive as content
    expect(out).not.toContain('q2fy27pr.htm');
    expect(out).not.toContain('SEQUENCE');
    expect(out.startsWith('Revenue')).toBe(true);
  });

  it('drops <head> so the boilerplate <title>Document</title> is not content', () => {
    const out = htmlToText('<html><head><title>Document</title></head><body><p>Real</p></body></html>');
    expect(out).toBe('Real');
  });

  it('is a no-op on a bare html document', () => {
    expect(stripSgmlEnvelope('<html><body>x</body></html>')).toBe('<html><body>x</body></html>');
  });
});

describe('findExhibitDoc', () => {
  it('locates EX-99.1 by declared type, not by filename', () => {
    // NVDA names its press release q2fy27pr.htm — nothing like "ex-99-1".
    const html =
      '<tr><td>1</td><td>8-K</td><td><a href="/x/nvda-20260826.htm">nvda-20260826.htm</a></td><td>8-K</td></tr>' +
      '<tr><td>2</td><td>EX-99.1</td><td><a href="/x/q2fy27pr.htm">q2fy27pr.htm</a></td><td>EX-99.1</td></tr>';
    expect(findExhibitDoc(html)).toBe('q2fy27pr.htm');
  });

  it('prefers 99.1 over 99.2', () => {
    const html =
      '<tr><td>EX-99.2</td><td><a href="/x/commentary.htm">c</a></td></tr>' +
      '<tr><td>EX-99.1</td><td><a href="/x/pr.htm">p</a></td></tr>';
    expect(findExhibitDoc(html)).toBe('pr.htm');
  });

  it('returns null when no exhibit row exists', () => {
    expect(findExhibitDoc('<tr><td>8-K</td><td><a href="/x/a.htm">a</a></td></tr>')).toBeNull();
  });
});

describe('trimFiling', () => {
  it('leaves a short filing untouched', () => {
    expect(trimFiling('short', 1000)).toBe('short');
  });

  it('cuts at the forward-looking-statements boilerplate', () => {
    const body = 'SIGNAL '.repeat(500);
    const text = body + 'Forward-Looking Statements ' + 'NOISE '.repeat(500);
    const out = trimFiling(text, 3000);
    expect(out).toContain('SIGNAL');
    expect(out).not.toContain('NOISE');
  });

  it('ignores an early boilerplate mention (a contents entry, not the section)', () => {
    const text = 'Forward-Looking Statements ' + 'SIGNAL '.repeat(5000);
    const out = trimFiling(text, 3000);
    expect(out.length).toBeGreaterThan(1000);
  });

  it('hard-caps length even with no marker present', () => {
    expect(trimFiling('x'.repeat(50_000), 10_000).length).toBeLessThanOrEqual(10_000);
  });
});

describe('rate limiting', () => {
  it('spaces requests to stay under the SEC ceiling', async () => {
    const calls: number[] = [];
    const client = new EdgarClient({
      userAgent: 'test test@example.com',
      rateLimit: 20,
      fetchImpl: async () => {
        calls.push(Date.now());
        return new Response('{}', { status: 404 });
      },
    });
    await Promise.all([client.submissions('1'), client.submissions('2'), client.submissions('3')]);
    expect(calls).toHaveLength(3);
    expect(calls[2]! - calls[0]!).toBeGreaterThanOrEqual(80); // 2 gaps at 50ms
  });

  it('sends a User-Agent — SEC blocks requests without one', async () => {
    let seen: string | null = null;
    const client = new EdgarClient({
      userAgent: 'Aegis contact@example.com',
      rateLimit: 100,
      fetchImpl: async (_u, init) => {
        seen = (init?.headers as Record<string, string>)['User-Agent'] ?? null;
        return new Response('{}', { status: 404 });
      },
    });
    await client.submissions('320193');
    expect(seen).toBe('Aegis contact@example.com');
  });
});

describe('earnings filtering', () => {
  it('keeps only 8-Ks carrying Item 2.02', async () => {
    const payload = {
      cik: '320193',
      tickers: ['AAPL'],
      filings: {
        recent: {
          accessionNumber: ['a-1', 'a-2', 'a-3'],
          form: ['8-K', '8-K', '10-Q'],
          filingDate: ['2026-08-01', '2026-08-02', '2026-08-03'],
          acceptanceDateTime: ['2026-08-01T16:05:00', '2026-08-02T16:05:00', '2026-08-03T16:05:00'],
          primaryDocument: ['d1.htm', 'd2.htm', 'd3.htm'],
          items: ['5.02', `${EARNINGS_ITEM},9.01`, ''],
        },
      },
    };
    const client = new EdgarClient({
      userAgent: 'test test@example.com',
      rateLimit: 100,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    const out = await client.recentEarnings8K('320193');
    expect(out).toHaveLength(1);
    expect(out[0]!.accessionNo).toBe('a-2');
    expect(out[0]!.ticker).toBe('AAPL');
  });

  it('honours the since cursor so a filing is not read twice', async () => {
    const payload = {
      cik: '1',
      filings: {
        recent: {
          accessionNumber: ['old', 'new'],
          form: ['8-K', '8-K'],
          filingDate: ['2026-01-01', '2026-09-01'],
          acceptanceDateTime: ['2026-01-01T16:00:00', '2026-09-01T16:00:00'],
          primaryDocument: ['a.htm', 'b.htm'],
          items: [EARNINGS_ITEM, EARNINGS_ITEM],
        },
      },
    };
    const client = new EdgarClient({
      userAgent: 'test test@example.com',
      rateLimit: 100,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    const out = await client.recentEarnings8K('1', '2026-06-01T00:00:00');
    expect(out.map((f) => f.accessionNo)).toEqual(['new']);
  });
});
