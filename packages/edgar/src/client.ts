/**
 * SEC EDGAR client. Free, no API key, 10 requests/second.
 *
 * The single requirement the SEC enforces is a descriptive User-Agent carrying
 * a contact address; requests without one are throttled or blocked outright.
 */

export interface Filing {
  cik: string;
  ticker: string | null;
  accessionNo: string;
  form: string;
  filedAt: string;
  primaryDoc: string;
  /** Item codes on an 8-K, e.g. ["2.02", "9.01"]. 2.02 is Results of Operations. */
  items: string[];
}

export interface EdgarOptions {
  /** SEC requires a real contact. Format: "Company Name contact@example.com". */
  userAgent: string;
  /** Requests per second. SEC's documented ceiling is 10. */
  rateLimit?: number;
  fetchImpl?: typeof fetch;
}

/** 8-K Item 2.02 is "Results of Operations and Financial Condition" — earnings. */
export const EARNINGS_ITEM = '2.02';

interface SubmissionsResponse {
  cik: string;
  tickers?: string[];
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      acceptanceDateTime?: string[];
      primaryDocument: string[];
      items?: string[];
    };
  };
}

export class EdgarClient {
  private readonly ua: string;
  private readonly minGapMs: number;
  private readonly doFetch: typeof fetch;
  private lastAt = 0;
  /** Chained so concurrent callers queue behind each other. */
  private gate: Promise<void> = Promise.resolve();

  constructor(opts: EdgarOptions) {
    this.ua = opts.userAgent;
    this.minGapMs = 1000 / (opts.rateLimit ?? 8); // 8/s, under the 10/s ceiling
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /**
   * Serialised throttle. SEC blocks bursts, not just sustained rates.
   *
   * The naive version — read lastAt, sleep, write lastAt — does not serialise:
   * concurrent callers all read the same lastAt before any of them writes, and
   * every one of them decides it can go now. Chaining onto a shared promise
   * makes each caller wait for the previous slot to be claimed.
   */
  private throttle(): Promise<void> {
    const mine = this.gate.then(async () => {
      const wait = this.lastAt + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
    });
    this.gate = mine.catch(() => undefined);
    return mine;
  }

  private async get(url: string): Promise<Response> {
    await this.throttle();
    return this.doFetch(url, {
      headers: { 'User-Agent': this.ua, 'Accept-Encoding': 'gzip, deflate' },
    });
  }

  static padCik(cik: string): string {
    return cik.replace(/\D/g, '').padStart(10, '0');
  }

  /** Recent filings for one company. */
  async submissions(cik: string): Promise<Filing[]> {
    const padded = EdgarClient.padCik(cik);
    const res = await this.get(`https://data.sec.gov/submissions/CIK${padded}.json`);
    if (!res.ok) return [];
    const json = (await res.json()) as SubmissionsResponse;
    const r = json.filings.recent;
    const ticker = json.tickers?.[0] ?? null;

    return r.accessionNumber.map((acc, i) => ({
      cik: padded,
      ticker,
      accessionNo: acc,
      form: r.form[i] ?? '',
      filedAt: r.acceptanceDateTime?.[i] ?? r.filingDate[i] ?? '',
      primaryDoc: r.primaryDocument[i] ?? '',
      items: (r.items?.[i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }));
  }

  /** 8-K filings reporting results, newest first. */
  async recentEarnings8K(cik: string, sinceIso?: string): Promise<Filing[]> {
    const all = await this.submissions(cik);
    return all
      .filter((f) => f.form === '8-K' && f.items.includes(EARNINGS_ITEM))
      .filter((f) => (sinceIso === undefined ? true : f.filedAt > sinceIso))
      .sort((a, b) => (a.filedAt < b.filedAt ? 1 : -1));
  }

  /** Directory listing for a filing — used to locate Exhibit 99.1. */
  async filingIndex(cik: string, accessionNo: string): Promise<{ name: string; type: string }[]> {
    const padded = EdgarClient.padCik(cik);
    const bare = accessionNo.replace(/-/g, '');
    const res = await this.get(
      `https://www.sec.gov/Archives/edgar/data/${String(Number(padded))}/${bare}/index.json`,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { directory: { item: { name: string; type: string }[] } };
    return json.directory.item;
  }

  /**
   * The earnings press release itself.
   *
   * On an 8-K reporting results, Exhibit 99.1 is the press release — the
   * reported figures plus management's guidance language. It lands on EDGAR
   * within minutes of the announcement, typically well before any transcript
   * exists, which is the whole timing edge.
   *
   * Located by the filing index's declared document TYPE, not by filename.
   * Filenames are arbitrary: NVDA calls its press release `q2fy27pr.htm`, not
   * anything resembling `ex-99-1`. Only the index states the exhibit type.
   */
  async earningsExhibit(cik: string, accessionNo: string): Promise<string | null> {
    const padded = EdgarClient.padCik(cik);
    const bare = accessionNo.replace(/-/g, '');
    const dir = `https://www.sec.gov/Archives/edgar/data/${String(Number(padded))}/${bare}`;

    const idx = await this.get(`${dir}/${accessionNo}-index.html`);
    let doc: string | null = null;
    if (idx.ok) doc = findExhibitDoc(await idx.text());

    if (doc === null) {
      // Fallback: the largest .htm that is neither the primary iXBRL document
      // nor a generated R*.htm viewer fragment.
      const items = await this.filingIndex(cik, accessionNo);
      doc =
        items
          .map((i) => i.name)
          .filter((n) => /\.htm$/i.test(n) && !/^R\d+\.htm$/i.test(n))
          .find((n) => /ex-?99|pr\.htm|press/i.test(n)) ?? null;
    }
    if (doc === null) return null;

    const res = await this.get(`${dir}/${doc}`);
    if (!res.ok) return null;
    return htmlToText(await res.text());
  }
}

/**
 * Remove the SEC's SGML document envelope.
 *
 * EDGAR serves exhibits wrapped in their own header:
 *   <DOCUMENT><TYPE>EX-99.1<SEQUENCE>2<FILENAME>q2fy27pr.htm<TEXT><html>...
 * Tag-stripping alone leaves the header's *text* ("EX-99.1", "2", the filename)
 * glued to the front of the press release, where it reads as content.
 */
export function stripSgmlEnvelope(raw: string): string {
  const textTag = /<TEXT>/i.exec(raw);
  const body = textTag ? raw.slice(textTag.index + textTag[0].length) : raw;
  const htmlStart = /<html[\s>]/i.exec(body);
  return htmlStart ? body.slice(htmlStart.index) : body;
}

/**
 * Find the EX-99.1 document in a filing index page.
 *
 * Parsed row-wise: a table row declaring type EX-99.1 also carries the link to
 * the document. Matching on filename instead fails constantly — issuers name
 * exhibits whatever they like.
 */
export function findExhibitDoc(indexHtml: string): string | null {
  const rows = indexHtml.split(/<tr[\s>]/i).slice(1);
  const pick = (want: RegExp): string | null => {
    for (const row of rows) {
      const cells = [...row.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim());
      if (!cells.some((c) => want.test(c))) continue;
      const href = /href="([^"]+\.htm[l]?)"/i.exec(row);
      if (href?.[1] !== undefined) {
        const parts = href[1].split('/');
        return parts[parts.length - 1] ?? null;
      }
    }
    return null;
  };
  // 99.1 is the press release; 99.2 is usually supplementary commentary.
  return pick(/^EX-99\.1$/i) ?? pick(/^EX-99/i);
}

/**
 * Strip HTML to readable text. Filing exhibits are table-heavy and full of
 * inline styling; sending raw HTML to a model wastes most of the prompt on
 * markup that carries no signal.
 */
export function htmlToText(html: string): string {
  return stripSgmlEnvelope(html)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Trim a filing to the section that carries the signal.
 *
 * A full 8-K exhibit runs 30-60k tokens, most of it GAAP reconciliation tables
 * and boilerplate. At Sonnet rates that is the difference between a $0.09 read
 * and a $0.30 one, for strictly less signal — the guidance language and the
 * headline figures live in the first few thousand words.
 */
export function trimFiling(text: string, maxChars = 24_000): string {
  if (text.length <= maxChars) return text;

  const cutMarkers = [
    /forward[- ]looking statements/i,
    /non-?GAAP financial measures/i,
    /about\s+\w+\s+corporation/i,
    /investor relations contact/i,
  ];
  let end = text.length;
  for (const m of cutMarkers) {
    const hit = m.exec(text);
    // Only honour a marker that appears past the first fifth — an early match
    // is usually a table of contents entry, not the actual boilerplate.
    if (hit && hit.index > maxChars / 5 && hit.index < end) end = hit.index;
  }
  return text.slice(0, Math.min(end, maxChars)).trim();
}
