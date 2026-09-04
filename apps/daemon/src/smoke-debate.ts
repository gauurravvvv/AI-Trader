/**
 * Run one real debate end to end. `pnpm smoke:debate`.
 *
 * Takes the most recent news signal, fetches the actual article, and runs the
 * analyst and challenger against it. Exists because the analyst declined
 * thirteen consecutive times on headlines alone and the only honest way to know
 * whether full text changes that is to try it.
 */
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { fetchArticle } from '@aegis/marketdata';
import { proposeThesis, challengeThesis, resolveDebate, type Evidence } from '@aegis/pipeline';

const log = createLogger({});
const db = openDb(process.env.DB_PATH ?? './data/aegis.db');
const budget = new BudgetGovernor(db, 100, `${new Date().toISOString().slice(0, 7)}-01`);

const row = db
  .prepare(
    `SELECT symbol, data FROM agent_signals
      WHERE signal_type = 'news_signal'
        AND json_extract(data, '$.link') IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
  )
  .get() as { symbol: string; data: string } | undefined;

if (!row) {
  log.warn('smoke', 'no news signal with a link yet — let the scout run first');
  process.exit(0);
}

const d = JSON.parse(row.data) as { title: string; publisher: string; publishedAt: string; link: string };
log.ok('smoke', `${row.symbol}: ${d.title}`);

const article = await fetchArticle(d.link, { maxChars: 3500 });
log.event('smoke', article
  ? `fetched ${String(article.chars)} chars via ${article.source}`
  : 'could not fetch the body — analyst gets the headline only');

const evidence: Evidence = {
  symbol: row.symbol,
  headlines: [{
    title: d.title, publisher: d.publisher, publishedAt: d.publishedAt,
    ...(article ? { body: article.text } : {}),
  }],
  movePct: 0, move5dPct: 0, regime: 'NEUTRAL',
};

const deps = { budget, log };
const proposed = await proposeThesis(evidence, deps);
if (!proposed.ok) {
  log.error('smoke', `analyst failed: ${proposed.reason}`);
  process.exit(1);
}
const t = proposed.value;
log.ok('analyst', `${t.direction}  conviction ${String(t.conviction)}  ${String(t.claims.length)} claim(s)`);
log.raw(`  ${t.thesis}`);
for (const c of t.claims) log.raw(`    claim: ${c}`);

if (t.direction === 'NONE') {
  log.warn('smoke', 'analyst declined — no challenge to run');
  db.close();
  process.exit(0);
}

const challenged = await challengeThesis(evidence, t, deps);
if (!challenged.ok) {
  log.error('smoke', `challenger failed: ${challenged.reason}`);
  process.exit(1);
}
const ch = challenged.value;
for (const v of ch.claimVerdicts) {
  log.raw(`    ${v.verdict === 'SUPPORTED' ? '✓' : v.verdict === 'CONTRADICTED' ? '✗' : '?'} ${v.claim}`);
}
log.ok('challenger', `${ch.verdict}  ${ch.oneLine}`);
log.raw(`  against: ${ch.bearCase}`);

const verdict = resolveDebate(t, ch);
log.ok('smoke', verdict.trade
  ? `WOULD TRADE ${verdict.direction} at strength ${verdict.strength.toFixed(2)} — ${verdict.reason}`
  : `no trade — ${verdict.reason}`);
db.close();
