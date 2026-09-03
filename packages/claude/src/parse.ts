import type { ZodType, ZodTypeDef } from 'zod';

export type ParseStage = 'direct' | 'fence' | 'extract' | 'schema';
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; stage: ParseStage };

/**
 * The CLI has no structured-output mode, and models wrap JSON in fences even
 * when told not to (verified: haiku did exactly that on this machine). Three
 * extraction attempts, then schema validation. Returns a result rather than
 * throwing, so a caller records a dataGap instead of crashing an agent tick.
 */
export function parseModelJson<T>(
  raw: string,
  // Input is `unknown` so schemas using .default()/.transform() — where the
  // input and output types differ — bind to the OUTPUT type. Without this,
  // TypeScript infers T from the input side and every defaulted field comes
  // back optional.
  schema: ZodType<T, ZodTypeDef, unknown>,
): ParseResult<T> {
  const candidates: string[] = [raw.trim()];

  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());

  const starts = [raw.indexOf('{'), raw.indexOf('[')].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    if (end > start) candidates.push(raw.slice(start, end + 1));
  }

  let lastSchemaError: string | null = null;

  for (const text of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    lastSchemaError = result.error.issues
      .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
      .join('; ');
  }

  if (lastSchemaError !== null) return { ok: false, error: lastSchemaError, stage: 'schema' };
  return {
    ok: false,
    stage: 'extract',
    error: `no parseable JSON in ${String(raw.length)} chars: ${raw.slice(0, 120)}`,
  };
}
