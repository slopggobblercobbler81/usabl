/**
 * Stop-hook projection for local continuation decisions.
 * This unit maps an existing Result into block or allow messages only.
 * It must never mint verdicts or bypass gate ownership of verdict authority.
 */
import type { Result, UsablConfig, Verdict } from '../contracts/index.js';
import { assembleBoundedMessage, boundField } from '../output/bounded-text.js';
import {
  APPROVAL_REQUIRED_HOW_IT_CLEARS,
  APPROVAL_REQUIRED_HUMAN_LEVER,
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
  guardedFilesHeadline,
  isBlockingBarrier,
} from '../output/disclosure.js';
import {
  applyNoiseBudget,
  formatCollapsedGroupHeadlineWithoutScreen,
  resolveNoiseBudgetDefault,
  type CollapsedFindingGroup,
} from '../output/noise-budget.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import { frameUntrustedBlock, scrubResult } from './scrub.js';

export interface HookContext {
  stopHookActive: boolean;
  // False when the Stop hook did not compare session pins on this stop, for example because the
  // pin store refused. An allow that would otherwise read as a pass then says so on its first
  // line. Absent means the comparison ran or had nothing to compare yet.
  sessionDriftChecked?: boolean;
}

// The note an allow line carries when the session drift comparison did not run.
const DRIFT_NOT_CHECKED = 'session drift not checked';

export interface StopDecision {
  block: boolean;
  message: string;
}

const BLOCKING_VERDICTS: ReadonlySet<Verdict> = new Set(['regression', 'approval_required', 'not_covered']);

/**
 * What the model should do next for each blocking verdict.
 *
 * The reader is a model that just tried to stop. It needs the verdict, the reason, and one
 * concrete next step, in that order, before any detail. A regression is fixed by the model.
 *
 * The coverage step tells the reader to resolve every reason listed under Not evaluated, and
 * then names the reasons a run produces most often. That list is not exhaustive and must not be
 * read as one: a gap is also recorded for a provider skipped after another provider changed the
 * page, for an evidence floor too old to prove anything, and for a configuration usabl could not
 * read, and more can be added. Naming the common ones is what keeps a model from stopping at
 * screens and files; the instruction to resolve every reason listed is what covers the rest.
 *
 * Guarded policy files are the one thing the model must not touch to clear a block, so that step
 * says so.
 */
interface NextSteps {
  regression: string;
  notCovered: string;
  approvalOnly: string;
  approvalWithRegression: string;
  approvalWithGaps: string;
}

const BLOCK_STEPS: NextSteps = {
  regression: 'Next: fix each barrier below, then stop again so usabl can re-check the change.',
  notCovered:
    'Next: resolve every reason under Not evaluated below: make each unreachable screen reachable, map each unmapped file to a screen, grant each denied capability, and fix each failed provider (both are gaps named provider:<id>). Then stop again.',
  approvalOnly:
    'Next: tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithRegression:
    'Next: fix each barrier below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithGaps:
    'Next: resolve every reason under Not evaluated below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
};

/**
 * The same guidance for the run that is let through because continuation is already active.
 *
 * The work is the same work, so the same selector chooses it; only the framing differs. Nothing
 * is listed in that message beyond the gate's summary, so no step says "below", and each one
 * ends by naming the check that has to pass before the model may call the change accessible.
 * This path used to tell every blocking verdict to fix the barriers, which is wrong when
 * guarded files are the only thing standing and wrong again when the work is resolving gaps.
 */
const CONTINUATION_STEPS: NextSteps = {
  regression:
    'Next: fix each barrier usabl reported, then run usabl check before you tell the user this change is accessible.',
  notCovered:
    'Next: resolve every reason usabl reported under Not evaluated, then run usabl check before you tell the user this change is accessible.',
  approvalOnly:
    'Next: tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithRegression:
    'Next: fix each barrier usabl reported, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithGaps:
    'Next: resolve every reason usabl reported under Not evaluated, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
};

/**
 * The step for one Result, from one set of wordings.
 *
 * A guarded-file block asks what the accessibility half of the run said, because that half is a
 * separate verdict the gate wrote and the two can disagree: policy can block a run whose
 * accessibility is verified, regressed, or unproven, and each of those is different work. Every
 * caller routes through here so no path can answer this on its own.
 */
function chooseNextStep(result: Result, steps: NextSteps): string | undefined {
  if (result.verdict === 'approval_required') {
    if (result.accessibilityVerdict === 'regression') {
      return steps.approvalWithRegression;
    }
    if (result.accessibilityVerdict === 'not_covered') {
      return steps.approvalWithGaps;
    }
    return steps.approvalOnly;
  }
  if (result.verdict === 'regression') {
    return steps.regression;
  }
  if (result.verdict === 'not_covered') {
    return steps.notCovered;
  }
  return undefined;
}

/**
 * The lines that follow the next step when guarded files changed: which files, how the state
 * clears, and the one lever a person has. All engine text, so it is scaffold; the joined path
 * list is bounded because nothing else bounds it.
 */
function approvalLines(result: Result): string[] {
  const paths = result.dirtyGuardedPaths;
  const named = paths.length === 0 ? 'none recorded' : boundField(paths.join(', '), 'candidates');
  return [
    `${guardedFilesHeadline(paths.length)}: ${named}`,
    APPROVAL_REQUIRED_HOW_IT_CLEARS,
    APPROVAL_REQUIRED_HUMAN_LEVER,
  ];
}

/**
 * The line every stop-hook message opens with: the verdict word and exit code, then what that
 * means for the change. Every part is an engine constant chosen by the verdict, so it is trusted
 * scaffold and never framed.
 */
function verdictLine(result: Result, meaningPrefix: string): string {
  const verdict = describeVerdict(result);
  return `${formatVerdictWord(verdict)}: ${meaningPrefix}${verdict.meaning}`;
}

/**
 * The gate's own summary as a framed piece.
 *
 * The summary is free text and not always engine-only: the summary for a run that never saw the
 * application names the unseen screen ids, which the router fallback can derive from a route
 * literal in the application, and a crash summary carries a raw error message. Anything a page
 * can influence is data to a model reader, so the summary goes inside the frame under its own
 * label rather than beside the verdict line. The frame label says untrusted text, not page
 * text, so engine free text sits there correctly. The piece is bounded because a crash summary
 * can be long; only the free text is cut, and the verdict word and exit code come from the
 * verdict line, never from the summary.
 */
function summaryPiece(result: Result): string {
  return `engine summary: ${boundField(result.summary, 'summary')}`;
}

/**
 * What the run did not examine, one entry per gap state.
 *
 * The reader is a model deciding whether to keep working, so it gets a reason it can act on
 * rather than a count it cannot. One example per state and a count of the rest, because gaps
 * cluster: five screens behind one broken server produce five near-identical reasons, while a
 * denied capability is a different fact that must never be crowded out by them.
 *
 * Each line pairs the gap headline, which is trusted usabl-chosen text, with the page-derived
 * detail, so the model can still map each reason to its state inside the single frame.
 *
 * The number of entries is bounded by construction: there are four gap states plus one entry
 * for unrecognized states, so at most five. The length of each entry is bounded per field, ref
 * and reason, before the headline with its count is attached, so a provider error the size of a
 * stack trace cannot fill the model's context and the count is never cut. No assembled string
 * is ever cut to fit. Cutting could remove a closing frame marker and hand the model an
 * unterminated block of untrusted text.
 */
function notEvaluatedPieces(result: Result): string[] {
  const disclosures = discloseGaps(result.coverage.gaps);
  return disclosures.map((disclosure) => {
    const detail = gapDetail({
      ...disclosure,
      ref: boundField(disclosure.ref, 'gapRef'),
      reason: boundField(disclosure.reason, 'gapReason'),
    });
    return `- ${gapHeadline(disclosure)}: ${detail}`;
  });
}

/**
 * A group whose free-text fields are bounded for printing. The count is left alone, so a
 * headline can name a rule that was cut short and still say how many findings it stands for.
 *
 * Layer and rule are printed outside the frame. In the first-party provider stack both are
 * authored by the providers, never read from the page, so they are trusted scaffold here. The
 * screen id is not: the router fallback derives it from a route literal in the application, so
 * it is printed inside the frame as a piece and never in the headline.
 */
function boundGroup(group: CollapsedFindingGroup): CollapsedFindingGroup {
  return {
    ...group,
    screenId: boundField(group.screenId, 'screenId'),
    layer: boundField(group.layer, 'layer'),
    rule: boundField(group.rule, 'rule'),
  };
}

/**
 * The whole block message, with at most one untrusted frame.
 *
 * It opens with the verdict word and exit code, what the verdict means, and the next step, so a
 * model reads the decision before any detail. The trusted engine scaffold stays outside the
 * frame: those opening lines, the guarded-file lines when policy files changed, the Rule or
 * Barriers headline lines, and the show-all hint. Every free-text piece, the gate's summary
 * first, then each finding experience, each fix, and each gap detail, goes inside one frame,
 * each with a short inline label so the model can map evidence to cause.
 *
 * Inside the frame the pieces read in the order a reader needs them: each barrier opens with a
 * "barrier:" line naming its rule, and the "Not evaluated:" label sits directly above the gap
 * lines rather than outside the frame, so a reader never meets "Not evaluated:" and then reads
 * about a button. Both labels are engine text; they are pieces only so they stay next to what
 * they label.
 *
 * The noise budget bounds how many groups appear, and the assembled block is never cut to
 * length. Cutting could remove the single closing marker and hand the model an unterminated
 * block of untrusted text.
 */
function buildBlockMessage(result: Result, config?: UsablConfig): string {
  const scaffold = [verdictLine(result, 'NOT verified. ')];
  const budget = resolveNoiseBudgetDefault(config);
  // The barriers this block is about are the ones the gate blocks on, by the gate's own rule.
  const gating = result.findings.filter(isBlockingBarrier);
  const view = applyNoiseBudget(gating, budget, 'gating findings');

  const nextStep = chooseNextStep(result, BLOCK_STEPS);
  if (nextStep !== undefined) {
    scaffold.push(nextStep);
  }
  if (result.verdict === 'approval_required') {
    scaffold.push(...approvalLines(result));
  }
  // The verdict line, the next step, and the guarded-file lines always survive the message
  // bound, as does the summary piece that opens the frame.
  const keep = scaffold.length;
  const pieces: string[] = [summaryPiece(result)];

  // Each free-text field is bounded on its own before it is labelled and framed, so a huge page
  // string shortens with a visible note and the counts around it stay whole.
  if (view.groups.length === 1 && !view.collapsed) {
    const group = boundGroup(view.groups[0]!);
    const ruleLabel =
      group.count > 1 ? `${group.rule} (×${group.count})` : group.rule;
    scaffold.push(`Rule: ${ruleLabel}`);
    pieces.push(`barrier: ${group.rule}`);
    pieces.push(`experience: ${boundField(group.representative.whatUserExperiences, 'experience')}`);
    pieces.push(`fix: ${boundField(fixOrAbsence(group.representative), 'fix')}`);
  } else if (view.groups.length > 0) {
    scaffold.push('Barriers:');
    for (const raw of view.groups) {
      const group = boundGroup(raw);
      scaffold.push(`- ${formatCollapsedGroupHeadlineWithoutScreen(group)}`);
      pieces.push(`barrier: ${group.rule}`);
      pieces.push(`screen (${group.rule}): ${group.screenId}`);
      pieces.push(
        `experience (${group.rule}): ${boundField(group.representative.whatUserExperiences, 'experience')}`,
      );
      pieces.push(`fix (${group.rule}): ${boundField(fixOrAbsence(group.representative), 'fix')}`);
    }
    if (view.showAllHint !== null) {
      scaffold.push(view.showAllHint);
    }
  }

  const gapPieces = notEvaluatedPieces(result);
  if (gapPieces.length > 0) {
    pieces.push('Not evaluated:', ...gapPieces);
  }

  // The whole message is bounded as well as each field. Whole pieces go first, then trailing
  // scaffold lines, never the opening lines or the summary piece, and the frame is rebuilt
  // around what survives.
  return assembleBoundedMessage({ scaffold, keep, pieces, keepPieces: 1, frame: frameUntrustedBlock });
}

export function evaluateStopDecision(
  result: Result,
  ctx: HookContext,
  config?: UsablConfig,
): StopDecision {
  const safe = scrubResult(result);
  const passNote = ctx.sessionDriftChecked === false ? DRIFT_NOT_CHECKED : undefined;

  if (safe.verdict === 'verified') {
    const sourceTree = safe.receipt?.sourceTree;
    const verdict = describeVerdict(safe);
    const proof =
      sourceTree === undefined
        ? 'the gate verified this change.'
        : `the gate verified this change. Receipt sourceTree ${boundField(sourceTree, 'receipt')}.`;
    return {
      block: false,
      message: `${formatVerdictWord(verdict, passNote)}: ${proof} You may stop.`,
    };
  }

  if (safe.exitCode === 4) {
    // A failed run proves nothing, and the hook fails open: it does not block. The line says
    // both, so the protocol decision and its limit are read together. It never says "verified"
    // in any form, so a model skimming the first word cannot mistake it for a pass.
    const verdict = describeVerdict(safe);
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [
          `${formatVerdictWord(verdict)}: usabl is not blocking this stop, but the run did not finish, so it proved nothing about this change.`,
          'Next: run usabl check again, or check the change by hand, before you call this change accessible.',
        ],
        keep: 2,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  if (safe.verdict === null && safe.coverage.nothingToCheck) {
    const verdict = describeVerdict(safe);
    return {
      block: false,
      message: `${formatVerdictWord(verdict, passNote)}: ${verdict.meaning} You may stop.`,
    };
  }

  const shouldBlock = safe.verdict !== null && BLOCKING_VERDICTS.has(safe.verdict);
  if (!shouldBlock) {
    // A null verdict with no idle flag and no crash can only be composed outside run(). Say
    // that usabl reached no verdict rather than guess which null state it is.
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [`NO VERDICT (exit ${safe.exitCode}): usabl did not reach a verdict for this change.`],
        keep: 1,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  if (ctx.stopHookActive) {
    // A second block while continuation is active can loop the model and hide the real operator
    // choice. The stop goes through, and the guidance is still the guidance for this verdict:
    // the same selector the block message uses, in the wording this path needs. A guarded-file
    // state also names the files here, because the step tells the model to raise them with the
    // user and a model cannot name a file it was not given.
    const scaffold = [
      verdictLine(
        safe,
        'NOT verified. usabl let this stop through without blocking again (continuation already active). ',
      ),
    ];
    const step = chooseNextStep(safe, CONTINUATION_STEPS);
    if (step !== undefined) {
      scaffold.push(step);
    }
    if (safe.verdict === 'approval_required') {
      scaffold.push(...approvalLines(safe));
    }
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold,
        keep: scaffold.length,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe, config),
  };
}
