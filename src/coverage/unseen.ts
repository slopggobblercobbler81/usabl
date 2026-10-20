/**
 * Unseen-screen detection: which scanned screens the engine has no grounds to claim it measured.
 *
 * A scan can finish without an error and still never have reached the application. An
 * unauthenticated route, a component that threw on mount, and a wrong URL all settle into a
 * stable document with nothing in it, and axe then fires the same few document-level rules on
 * every one of them. Readiness cannot separate those cases from a legitimately empty list,
 * because all four settle, so the split is made here from what the scan actually returned.
 *
 * Reachability rests on positive evidence that a screen rendered, never on absence of difference
 * between screens. Two screens that measured identically at different URLs are not proof of a blank
 * page: a templated route, a shared application shell, and two pages that carry the same barrier all
 * produce identical findings while rendering correctly. Equality of what we did not find is not
 * evidence of unreachability, so this unit does not infer from it.
 *
 * Two detectors run, both positive observations about one screen:
 *   1. isBodyOnly reads the keyboard transcript. Every stop stayed on the document body, so the page
 *      had nothing to walk. This is the sound floor and runs for every screen.
 *      A body-only screen is unseen even if reachedWhen matched, because a selector aimed at a
 *      persistent app shell matches on a login wall too.
 *   2. reachedSelectorPresent and reachedResponseSeen read the per-surface readiness signal the
 *      operator declared and the scan measured against the live page: a selector that must match,
 *      and a data response that must have been answered with a success. Only an explicit false
 *      (declared and absent) marks a screen unseen, and either part being false is enough. A true
 *      value only suppresses its own gap; it never cancels the body-only floor or the other part.
 *      The detectors are independent.
 *
 * The findings are dropped, not downgraded. The gate weighs a new failure before it weighs
 * missing coverage on purpose, because a real new barrier is the actionable answer. Leaving
 * these drafts in place with a gap beside them would still mint regression from a document
 * nobody rendered.
 *
 * There is no element-count threshold here. A blank screen of a real application still carries
 * a few hundred head elements, so a count would only be another number to tune.
 *
 * This unit reports coverage. It must never mint a verdict.
 */
import type { CoverageGap, ScreenScan } from '../contracts/index.js';

export interface UnseenPass {
  screens: ScreenScan[]; // same order as the input, unseen screens stripped of drafts and applicability
  unseenScreenIds: string[];
}

/**
 * A live blank page reports the document body for every tab press. The page driver writes an
 * nth-child ancestry, so the body arrives as `html > body:nth-child(2)` rather than a bare tag
 * name, and a body carrying an id would arrive as that id instead. Match the tail segment so
 * both real shapes are covered without parsing a selector.
 */
function isDocumentBody(elementPath: string): boolean {
  const tail = elementPath.split('>').at(-1)?.trim() ?? '';
  return tail === 'body' || tail.startsWith('body:');
}

/**
 * The observed signature from a login-gated application scanned with no session: fifty tab
 * presses, focus never off the body, nothing focusable anywhere on the page.
 *
 * An empty transcript is not this. It means no keyboard walk was recorded, which is the absence
 * of evidence rather than evidence the screen was blank.
 */
function isBodyOnly(scan: ScreenScan): boolean {
  return scan.stops.length > 0 && scan.stops.every((stop) => isDocumentBody(stop.elementPath));
}

function unseenGap(scan: ScreenScan, detectorSentences: string[]): CoverageGap {
  return {
    ref: scan.url,
    state: 'not-covered',
    reason: [
      'usabl did not see this screen, so its findings were dropped.',
      ...detectorSentences,
      'Check the URL and any sign-in this run needs before trusting a verdict for it.',
    ].join(' '),
  };
}

/**
 * Strip drafts and applicability from every screen the engine cannot claim it saw and disclose
 * each one as a coverage gap. Screens that were really walked pass through untouched, gaps and all.
 *
 * The two detectors are independent. reachedSelectorPresent === true means only "do not raise the
 * reachedWhen gap", never "cancel the body-only gap". A reachedWhen aimed at a persistent app shell
 * element (a header, nav, or footer present on every route) matches even on a login wall or a screen
 * that threw on mount while the shell survived. Those screens are still body-only, so a matched
 * selector must not suppress the body-only finding, or the run would mint a false green.
 *
 * A genuinely reached screen is not body-only in the first place, so it still passes through with its
 * drafts. Only an explicit reachedSelectorPresent === false raises the reachability gap.
 */
export function markUnseenScreens(screens: ScreenScan[]): UnseenPass {
  const unseenScreenIds: string[] = [];

  const marked = screens.map((scan) => {
    const sentences: string[] = [];
    if (isBodyOnly(scan)) {
      sentences.push(
        'Every keyboard stop stayed on the document body, so the page had nothing to walk; a page ' +
          'that never rendered, one behind a login, and one that threw on mount all look like this.',
      );
    }
    if (scan.reachedSelectorPresent === false) {
      const selector = scan.reachedWhenSelector ?? 'the declared reachedWhen selector';
      sentences.push(
        `Nothing matched reachedWhen selector ${selector} in the rendered page, so the element the ` +
          'operator said proves this screen loaded was absent.',
      );
    }
    if (scan.reachedResponseSeen === false) {
      const path = scan.reachedWhenResponse ?? 'the declared reachedWhen response';
      sentences.push(
        `No fetch or XHR request to ${path} on the application's own host was answered with a ` +
          'success, so the data the operator said proves this screen loaded never arrived.',
      );
    }
    if (sentences.length === 0) {
      return scan;
    }
    unseenScreenIds.push(scan.screenId);
    // Applicability goes with the drafts, for the same reason. Sixty rules reported inapplicable
    // against a document that never rendered is a fact about a blank page, not about the
    // application, and keeping it would put the dropped claim back in a quieter form.
    return { ...scan, drafts: [], applicability: [], gaps: [...scan.gaps, unseenGap(scan, sentences)] };
  });

  return { screens: marked, unseenScreenIds };
}
