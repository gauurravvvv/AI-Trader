/**
 * Fetch the story behind a headline.
 *
 * A headline is one sentence written to be clicked, and an analyst asked to
 * build a falsifiable thesis from one will correctly refuse: it cannot
 * establish timing, severity or magnitude. In thirteen live analyses the model
 * declined thirteen times, every one of them a reasonable answer to an
 * unreasonable question. This is what gives it something to reason about.
 */

import http from 'node:http';
import https from 'node:https';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface Article {
  url: string;
  text: string;
  /** Where the text came from, so a thin extraction is visible not guessed at. */
  source: 'article-body' | 'json-ld' | 'paragraphs';
  chars: number;
}

/**
 * Strip a fragment of HTML to readable text.
 *
 * Entities are decoded after tags are removed, in that order: doing it the
 * other way turns an encoded `&lt;script&gt;` in the copy into a real tag.
 */
export function htmlToText(fragment: string): string {
  let t = fragment;
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<(script|style|noscript|svg|figure|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\/(p|div|li|h[1-6]|br)\s*>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  // Trim each line, not just the whole string: a tag boundary leaves a space
  // sitting after the newline and every paragraph starts with one.
  return t
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/**
 * Pull the body out of a page.
 *
 * Three strategies, best first. Yahoo marks its prose with
 * `data-testid="article-body"`; without that a JSON-LD `articleBody` is
 * authoritative; failing both, every paragraph on the page — which drags in
 * navigation chrome and is why it is last and why the caller is told.
 */
export function extractArticle(html: string, url: string): Article | null {
  const marked = /data-testid="article-body"[^>]*>([\s\S]*?)(?:<\/section>|<footer|<div class="[^"]*read-more)/i.exec(html);
  if (marked?.[1] !== undefined) {
    const text = htmlToText(marked[1]);
    if (text.length > 250) return { url, text, source: 'article-body', chars: text.length };
  }

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(m[1] ?? '');
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of nodes) {
        const body = (n as { articleBody?: unknown }).articleBody;
        if (typeof body === 'string' && body.length > 250) {
          const text = htmlToText(body);
          return { url, text, source: 'json-ld', chars: text.length };
        }
      }
    } catch {
      /* a malformed block is not a body */
    }
  }

  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => htmlToText(m[1] ?? ''))
    // Navigation and boilerplate are short; real sentences are not.
    .filter((t) => t.length > 80);
  if (paras.length >= 3) {
    const text = paras.join('\n');
    return { url, text, source: 'paragraphs', chars: text.length };
  }
  return null;
}

/** Keep the opening: a news story states its facts before it contextualises them. */
export function trimArticle(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = cut.lastIndexOf('. ');
  return (lastStop > maxChars * 0.6 ? cut.slice(0, lastStop + 1) : cut) + '\n[truncated]';
}

export interface FetchOpts {
  timeoutMs?: number;
  maxChars?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * One GET, with room for absurd response headers.
 *
 * Not `fetch`. Yahoo replies with more than 16KB of headers — mostly Set-Cookie
 * — and undici, which backs global fetch, rejects that outright with
 * HeadersOverflowError before any body arrives. The request is not refused and
 * the page is not broken; the client simply will not read it, and there is no
 * option on fetch to raise the limit. `node:https` takes maxHeaderSize.
 */
function get(
  url: string,
  opts: Required<Pick<FetchOpts, 'timeoutMs' | 'maxBytes'>>,
): Promise<{ status: number; location: string | null; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // 16KB is the default and Yahoo exceeds it comfortably.
        maxHeaderSize: 128 * 1024,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location ?? null;
        const contentType = String(res.headers['content-type'] ?? '');

        // Redirects and non-HTML carry nothing worth buffering.
        if (location !== null || !contentType.includes('html')) {
          res.resume();
          resolve({ status, location, contentType, body: '' });
          return;
        }

        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          // A runaway page must not become a runaway heap.
          if (size > opts.maxBytes) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status, location, contentType, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * Fetch and extract one article. Null on any failure.
 *
 * Never throws: a story we cannot read must degrade to "headline only", not
 * take down the tick that was reading four others.
 */
export async function fetchArticle(url: string, opts: FetchOpts = {}): Promise<Article | null> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 4_000_000;
  const maxRedirects = opts.maxRedirects ?? 4;

  let current = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (!/^https?:\/\//i.test(current)) return null;
      const res = await get(current, { timeoutMs, maxBytes });

      if (res.location !== null && res.status >= 300 && res.status < 400) {
        current = new URL(res.location, current).toString();
        continue;
      }
      if (res.status !== 200 || res.body === '') return null;

      const a = extractArticle(res.body, current);
      if (a === null) return null;
      return { ...a, text: trimArticle(a.text, opts.maxChars ?? 4000) };
    }
    return null;
  } catch {
    return null;
  }
}
