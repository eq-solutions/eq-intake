/**
 * @eq/validation — string coercer
 *
 * Light-touch normalisation:
 * - Trim leading/trailing whitespace
 * - Collapse internal runs of whitespace to single space
 * - Convert non-string types via String()
 * - Optionally enforce max length (truncate or error per opts)
 * - Strip zero-width characters and BOM
 *
 * The point of this coercer is gentle cleanup, not validation.
 * Length / format / pattern checks happen in the validators, not here.
 */

import { CoerceOptions, CoerceResult, ok, err } from './types';

interface StringOpts extends Partial<CoerceOptions> {
  /** Collapse runs of whitespace to single space. Default true. */
  collapseWhitespace?: boolean;
  /** Strip zero-width chars and BOM. Default true. */
  stripInvisible?: boolean;
  /** Maximum length. If exceeded, behaviour controlled by onTooLong. */
  maxLength?: number;
  /** What to do if maxLength exceeded: 'error' (default) or 'truncate' */
  onTooLong?: 'error' | 'truncate';
  /** Convert empty string to null. Default false (keep empty as ''). */
  emptyAsNull?: boolean;
}

const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF|\u00AD/g;
const WHITESPACE_RUN = /\s+/g;

export function coerceString(
  value: unknown,
  opts: StringOpts = {}
): CoerceResult<string | null> {
  const collapseWhitespace = opts.collapseWhitespace ?? true;
  const stripInvisible = opts.stripInvisible ?? true;
  const onTooLong = opts.onTooLong ?? 'error';

  if (value === null || value === undefined) {
    if (opts.strict) return err('value_null_or_empty', 'Empty string in strict mode.');
    return ok(null, true, 'empty cell');
  }

  let s = typeof value === 'string' ? value : String(value);
  const original = s;

  if (stripInvisible) {
    s = s.replace(ZERO_WIDTH, '');
  }

  s = s.trim();

  if (collapseWhitespace) {
    s = s.replace(WHITESPACE_RUN, ' ');
  }

  if (s === '') {
    if (opts.strict) return err('value_null_or_empty', 'Empty string after normalisation.');
    if (opts.emptyAsNull) return ok(null, true, 'empty after normalisation');
    return ok('', s !== original);
  }

  if (opts.maxLength !== undefined && s.length > opts.maxLength) {
    if (onTooLong === 'truncate') {
      return ok(s.slice(0, opts.maxLength), true, `truncated to ${opts.maxLength} chars`);
    }
    return err(
      'string_too_long',
      `Value is ${s.length} characters, max ${opts.maxLength}.`
    );
  }

  return ok(s, s !== original);
}
