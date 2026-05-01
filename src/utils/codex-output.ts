/**
 * codex-output.ts — extract a structured verdict from `codex exec` stdout.
 *
 * The codex CLI mixes log lines, an echoed prompt block, the model reply, an
 * ERROR rollout-record line, a "tokens used" footer, and (often) a re-print
 * of the final reply at the very end. The structured verdict we want lives
 * after the assistant turn marker (`\ncodex\n`). Everything before that
 * marker — including any JSON the prompt itself contains as a schema example
 * — must NOT be extracted, or we will return the schema placeholder back to
 * the caller and silently misclassify a council vote.
 *
 * Strategy:
 *   1. Anchor on the LAST `\ncodex\n` marker (multi-turn tolerant).
 *   2. From that index forward, scan for `{` and attempt balanced-brace
 *      extraction (string-aware, escape-aware) of each candidate.
 *   3. JSON.parse each candidate; the first one with a `verdict` field
 *      wins. This rejects malformed JSON and JSON-shaped non-verdicts.
 *   4. If stdout extraction fails, retry against stdout+stderr concatenated
 *      — codex sometimes interleaves to stderr.
 *
 * Returning `null` is the silent-fail signal the caller MUST surface as a
 * council failure (NOT an approval). The plan-doc comment is explicit: a
 * null verdict means "council didn't return" and must default-deny.
 */

export interface CouncilVerdictJson {
  verdict: 'approve' | 'block';
  concerns: string[];
  must_fix: string[];
}

const ASSISTANT_MARKER = '\ncodex\n';

/**
 * Scan forward from `start` and return the [start, end) slice of the first
 * balanced JSON object, or null if no balanced object is found before EOF.
 * Tracks string state to avoid counting braces inside strings as structure.
 */
function findBalancedObject(text: string, from: number): { start: number; end: number } | null {
  const len = text.length;
  let i = from;
  while (i < len) {
    if (text[i] === '{') {
      let depth = 0;
      let inStr = false;
      let escaped = false;
      for (let j = i; j < len; j++) {
        const ch = text[j];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (inStr) {
          if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inStr = false;
          }
          continue;
        }
        if (ch === '"') {
          inStr = true;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            return { start: i, end: j + 1 };
          }
        }
      }
      // Unbalanced from this `{` to EOF — no point scanning further from earlier `{`.
      return null;
    }
    i++;
  }
  return null;
}

function tryExtractFromRegion(region: string): CouncilVerdictJson | null {
  let cursor = 0;
  while (cursor < region.length) {
    const span = findBalancedObject(region, cursor);
    if (!span) return null;
    const candidate = region.slice(span.start, span.end);
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.verdict === 'approve' || parsed.verdict === 'block')
      ) {
        return {
          verdict: parsed.verdict,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
          must_fix: Array.isArray(parsed.must_fix) ? parsed.must_fix.map(String) : [],
        };
      }
    } catch {
      // Malformed candidate — skip ahead and keep scanning.
    }
    cursor = span.end;
  }
  return null;
}

export function extractCouncilVerdict(
  stdout: string,
  stderr: string = '',
): CouncilVerdictJson | null {
  const markerIdx = stdout.lastIndexOf(ASSISTANT_MARKER);
  const region = markerIdx >= 0 ? stdout.slice(markerIdx + ASSISTANT_MARKER.length) : stdout;
  const fromStdout = tryExtractFromRegion(region);
  if (fromStdout) return fromStdout;

  if (stderr) {
    const combined = stdout + '\n' + stderr;
    const combinedMarker = combined.lastIndexOf(ASSISTANT_MARKER);
    const combinedRegion =
      combinedMarker >= 0 ? combined.slice(combinedMarker + ASSISTANT_MARKER.length) : combined;
    return tryExtractFromRegion(combinedRegion);
  }

  return null;
}
