/**
 * The one verdict line every surface opens with.
 *
 * Reads a Result and names its state: a symbol, the verdict word, the exit code, and one plain
 * sentence saying what the state means for the change. Every surface that presents a verdict
 * starts from this unit so the terminal report, the stop hook, and the self-check cannot drift
 * apart on the words a reader sees first.
 *
 * This unit never mints a verdict. It reads `verdict` and `exitCode` as the gate wrote them.
 *
 * The symbol is decoration. The word and the exit code carry the meaning, so a reader who cannot
 * see the symbol, or a screen reader that names it oddly, loses nothing. No colour is used, so
 * no state depends on colour to be understood.
 */
import type { Result } from '../contracts/index.js';

export interface VerdictLine {
  symbol: string;
  word: string;
  exitCode: number;
  meaning: string;
  // True for the two states that carry no verdict: idle and a failed run. Both leave
  // `verdict` null, and they are opposite facts, so each is named on its own.
  noVerdict: boolean;
}

const VERDICT_WORDS: Record<string, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

const VERDICT_SYMBOLS: Record<string, string> = {
  verified: '✔', // heavy check mark
  regression: '✖', // heavy multiplication x
  not_covered: '▲', // black up-pointing triangle
  approval_required: '■', // black square
};

const VERDICT_MEANINGS: Record<string, string> = {
  // Not "passed every check". A verified run routinely carries recorded debt, and on the
  // application this was measured against it carried twenty definite failures the floor had
  // accepted. Verified means no NEW barrier blocks the change, which is what the gate decided and
  // what the overlay's own lead sentence already said.
  verified: 'No new barrier blocks this change. It can proceed.',
  regression: 'This change adds an accessibility barrier. It is blocked until fixed.',
  not_covered: 'usabl could not check all of this change, so it is blocked as unproven.',
  // Approval happens on the pull request and nowhere else. The surfaces that face a model say
  // who approves it and how the state clears; this line only has room to say where.
  approval_required: 'This change edits guarded policy files. It needs approval on the pull request.',
};

const IDLE_SYMBOL = '○'; // white circle: nothing happened
const FAILED_SYMBOL = '!';

/**
 * The word for a verdict usabl has no word for.
 *
 * A fixed label, never the verdict that arrived. `Result` is exported and one can be composed
 * outside the engine or parsed from a document, so at runtime `verdict` is any string, and this
 * word is printed in the one position every surface treats as its own: the opening line, outside
 * the untrusted frame on the surfaces that have one. Echoing an unrecognized verdict there would
 * put text usabl did not write where a reader, and on two surfaces a language model, reads
 * usabl's own voice. The reader still learns the state, because the exit code and the meaning
 * sentence are printed beside it. The gap disclosure holds the same line for a gap state.
 */
const UNRECOGNIZED_VERDICT_WORD = 'UNRECOGNIZED VERDICT';

/**
 * The exit code as text, or a word saying it was not one.
 *
 * The contract types this a number and a Result from `run()` always carries one, but a composed
 * or parsed Result can carry anything, and this is printed as usabl's own text. A value that is
 * not a whole number is named as unknown rather than pasted into the line.
 */
function formatExitCode(exitCode: number): string {
  return Number.isInteger(exitCode) ? String(exitCode) : 'unknown';
}

/**
 * Names the state of a Result for a reader who sees this line first.
 *
 * `verdict` null with exit 4 is a run usabl could not finish. `verdict` null with any other
 * exit is idle: nothing to check. Both say NO VERDICT so neither can be mistaken for a pass,
 * and the word after it tells them apart. Neither state names the word "verified" in any form,
 * so neither can be skimmed as a pass.
 */
export function describeVerdict(result: Result): VerdictLine {
  if (result.exitCode === 4) {
    return {
      symbol: FAILED_SYMBOL,
      word: 'NO VERDICT: RUN FAILED',
      exitCode: result.exitCode,
      meaning: 'usabl could not finish the run, so it proved nothing about this change.',
      noVerdict: true,
    };
  }
  if (result.verdict === null) {
    return {
      symbol: IDLE_SYMBOL,
      word: 'NO VERDICT: IDLE',
      exitCode: result.exitCode,
      meaning: 'No UI files changed, so there was nothing to check. No pass, no fail.',
      noVerdict: true,
    };
  }
  return {
    symbol: VERDICT_SYMBOLS[result.verdict] ?? '',
    word: VERDICT_WORDS[result.verdict] ?? UNRECOGNIZED_VERDICT_WORD,
    exitCode: result.exitCode,
    meaning: VERDICT_MEANINGS[result.verdict] ?? 'usabl reached a verdict it has no words for.',
    noVerdict: false,
  };
}

/**
 * The verdict word and exit code with no symbol, for readers that gain nothing from one. A note,
 * when given, goes inside the parentheses after the exit code, so it is read with the verdict.
 */
export function formatVerdictWord(line: VerdictLine, note?: string): string {
  const suffix = note === undefined ? '' : `, ${note}`;
  return `${line.word} (exit ${formatExitCode(line.exitCode)}${suffix})`;
}

/** The full verdict line: symbol, word, and exit code. */
export function formatVerdictLine(line: VerdictLine): string {
  const symbol = line.symbol.length > 0 ? `${line.symbol} ` : '';
  return `${symbol}${formatVerdictWord(line)}`;
}
