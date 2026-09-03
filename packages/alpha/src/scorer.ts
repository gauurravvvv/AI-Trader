import Decimal from 'decimal.js';
import type { VerifiedEarningsRead } from './earnings-reader.js';

export interface ScoreWeights {
  numericSurprise: number;
  textSurprise: number;
  guidance: number;
}

/**
 * Starting prior, not truth. Recorded on every decision and retuned only from
 * walk-forward evidence — never from reviewing trades already taken.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  numericSurprise: 0.5,
  textSurprise: 0.3,
  guidance: 0.2,
};

export interface ScoreInputs {
  read: VerifiedEarningsRead;
  /** Standardised numeric EPS surprise from XBRL, when consensus is known. */
  numericSue: number | null;
}

export interface SueResult {
  sue: string;
  components: { name: string; value: string; weight: number }[];
  /** Reasons the score was damped, each one a real reliability concern. */
  penalties: string[];
  passesGate: boolean;
  direction: 'long' | 'none';
}

/** Per-flag discount and its floor. Config, not truth — retuned from evidence. */
const RISK_FLAG_STEP = 0.12;
const RISK_FLAG_FLOOR = 0.6;

const GUIDANCE_SCORE: Record<VerifiedEarningsRead['guidanceDelta'], number> = {
  RAISED: 1,
  MAINTAINED: 0,
  LOWERED: -1,
  WITHDRAWN: -1.5,
  NONE: 0,
};

/**
 * Fuse the model's textual read with hard XBRL numbers into one score.
 *
 * The numeric term is a properly standardised SUE from consensus data; the text
 * term is what the language says about trajectory. They measure different
 * things, which is the entire premise — classic PEAD has decayed toward zero
 * while text-based PEAD has not.
 */
export function scoreSue(
  inputs: ScoreInputs,
  threshold = 1.5,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): SueResult {
  const { read, numericSue } = inputs;
  const penalties: string[] = [];

  // The text term is the company's own stated trajectory and how it is
  // described — acceleration, net of hedging. Not a beat/miss guess.
  const textSurprise = new Decimal(read.momentumShift)
    .times(0.7)
    .plus(new Decimal(read.languageTone).times(0.3))
    .minus(new Decimal(read.hedgingDensity).times(0.4));
  const guidance = new Decimal(GUIDANCE_SCORE[read.guidanceDelta]);

  // When consensus is unavailable the numeric term is absent, not zero —
  // treating "unknown" as "no surprise" silently halves every score.
  // Redistribute its weight across the terms we do have.
  const hasNumeric = numericSue !== null;
  if (!hasNumeric) penalties.push('no consensus: numeric term redistributed');

  const wNum = hasNumeric ? weights.numericSurprise : 0;
  const scale = hasNumeric ? 1 : 1 / (weights.textSurprise + weights.guidance);
  const wText = weights.textSurprise * scale;
  const wGuide = weights.guidance * scale;

  let sue = new Decimal(numericSue ?? 0)
    .times(wNum)
    .plus(textSurprise.times(wText))
    .plus(guidance.times(wGuide));

  // Reliability damping. Each of these is a reason to trust the read less.
  if (read.fabricatedQuotes.length > 0) {
    sue = sue.times(0.5);
    penalties.push(`${String(read.fabricatedQuotes.length)} fabricated quote(s): score halved`);
  }
  if (read.confidence < 60) {
    sue = sue.times(read.confidence / 60);
    penalties.push(`low model confidence ${String(read.confidence)}: score scaled`);
  }
  if (read.dataGaps.length >= 3) {
    sue = sue.times(0.8);
    penalties.push(`${String(read.dataGaps.length)} data gaps: score damped`);
  }
  if (read.riskFlags.length > 0) {
    // Bounded multiplicative damp, not an unbounded subtraction. A linear
    // penalty per flag lets a merely verbose read veto any score — and a long
    // filing always contains something flaggable, so the count is partly a
    // measure of model chattiness rather than of risk. Floor at 0.6 so flags
    // can discount conviction but never invert it.
    const damp = Math.max(RISK_FLAG_FLOOR, 1 - RISK_FLAG_STEP * read.riskFlags.length);
    sue = sue.times(damp);
    penalties.push(
      `${String(read.riskFlags.length)} risk flag(s), score x${damp.toFixed(2)}: ` +
        read.riskFlags.map((f) => f.slice(0, 60)).join(' | '),
    );
  }

  const rounded = sue.toDecimalPlaces(4);
  // Long-only in v1. A bearish read is a reason not to buy, not a reason to short.
  const passes = rounded.gte(threshold);

  return {
    sue: rounded.toString(),
    components: [
      { name: 'numericSurprise', value: String(numericSue ?? 'n/a'), weight: wNum },
      { name: 'textSurprise', value: textSurprise.toString(), weight: wText },
      { name: 'guidance', value: guidance.toString(), weight: wGuide },
    ],
    penalties,
    passesGate: passes,
    direction: passes ? 'long' : 'none',
  };
}
