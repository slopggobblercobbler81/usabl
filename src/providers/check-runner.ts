/**
 * CheckRunner executes one screen scan and returns transcript stops, provider drafts, and coverage gaps.
 * It must never throw, never mint a verdict, and never drop a failed screen on the floor.
 * Transcript collection runs before providers because interaction probes can mutate focus order.
 *
 * A screen this run did not reach signed in is disclosed as a coverage gap and measured no
 * further. See providers/redirected.ts for the three rules, when each fires, and what they can
 * and cannot see.
 */
import type {
  Capability,
  BrowserDriver,
  CheckRunner,
  CoverageGap,
  Page,
  Provider,
  ScreenScan,
  Step,
  StepRunner,
  UsablConfig,
} from '../contracts/index.js';
import { attachDomSourceToDrafts } from './dom-source.js';
import { measureReadiness, readApiResponses, readinessSignalOf, type ReadinessSignal } from './reachability.js';
import { observeLanding, readRefusedRequests, redirectedAwayGap } from './redirected.js';
import { waitForScannerArtifactsToClear } from './scanner-artifacts.js';
import { runProviders } from './index.js';

export interface CheckRunnerDeps {
  browser: BrowserDriver;
  providers: Provider[];
  config: UsablConfig;
  allowedCapabilities: Capability[];
  stepRunner: StepRunner;
  transcriptTabCap?: number;
  // Whether the operator configured a storage state for this run, which is the only assertion that
  // this scan is signed in. Two of the three not-reached rules are claims about a session that was
  // asserted and did not work, so they say nothing without it. Absent means no session was
  // configured, which is the honest reading for a caller that never had one: a signed-out scan
  // legitimately meets 401s and login forms, and firing on those would turn every deliberate
  // signed-out run into a coverage gap. The composition root sets it for every gating surface.
  sessionConfigured?: boolean;
}

const DEFAULT_TRANSCRIPT_TAB_CAP = 50;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notCoveredGap(ref: string, reason: string): CoverageGap {
  return { ref, state: 'not-covered', reason };
}

function failedScan(screen: { id: string; url: string }, reason: string): ScreenScan {
  // A scan that failed knows nothing about which rules applied, so it claims nothing. It also made
  // no reachability observation, so both reachability fields stay null. The gap here already tells
  // the operator the screen failed to open.
  return {
    screenId: screen.id,
    url: screen.url,
    stops: [],
    drafts: [],
    gaps: [notCoveredGap(screen.url, reason)],
    applicability: [],
    reachedSelectorPresent: null,
    reachedWhenSelector: null,
  };
}

/**
 * A screen this run did not reach signed in. Its transcript, its drafts, and its applicability are
 * all measurements of a page that is not the requested screen, so none of them is carried, and no
 * reachability claim is made because the assertion describes a screen that was not shown.
 *
 * One shape for both the early check and the late one, so a refusal that arrives during the walk
 * cannot be disclosed differently from one that was there on load.
 */
function notReachedScan(
  screen: { id: string; url: string },
  gap: CoverageGap,
  signal: ReadinessSignal | null,
): ScreenScan {
  return {
    screenId: screen.id,
    url: screen.url,
    stops: [],
    drafts: [],
    gaps: [gap],
    applicability: [],
    reachedSelectorPresent: null,
    reachedWhenSelector: signal?.selector ?? null,
    ...responseFields(signal, null),
  };
}

/**
 * The response half of the readiness record. Left off entirely when the surface declared no
 * response, so a scan of a surface that does not use it has exactly the shape it always had.
 */
function responseFields(
  signal: ReadinessSignal | null,
  seen: boolean | null,
): Pick<ScreenScan, 'reachedResponseSeen' | 'reachedWhenResponse'> {
  if (signal === null || signal.response === null) {
    return {};
  }
  return { reachedResponseSeen: seen, reachedWhenResponse: signal.response };
}

function makeTabSteps(tabCap: number): Step[] {
  return Array.from({ length: tabCap }, (): Step => ({ do: 'tab' }));
}

function trimCycle(stops: ScreenScan['stops']): ScreenScan['stops'] {
  const seen = new Set<string>();
  for (const [index, stop] of stops.entries()) {
    if (seen.has(stop.elementPath)) {
      return stops.slice(0, index);
    }
    seen.add(stop.elementPath);
  }
  return stops;
}

export function makeCheckRunner(deps: CheckRunnerDeps): CheckRunner {
  const transcriptTabCap = deps.transcriptTabCap ?? DEFAULT_TRANSCRIPT_TAB_CAP;
  const tabSteps = makeTabSteps(transcriptTabCap);

  return {
    async scan(screen): Promise<ScreenScan> {
      let page: Page;
      try {
        page = await deps.browser.open(screen.url);
      } catch (err) {
        return failedScan(screen, `screen failed to open: ${errorMessage(err)}`);
      }

      // Look up the surface's optional readiness signal by screen id. Only manually declared
      // surfaces set an id that matches a scan target, so route-discovered screens find nothing here
      // and make no reachability claim.
      const reachedWhen = deps.config.surfaces.find((surface) => surface.id === screen.id)?.reachedWhen;
      const signal = readinessSignalOf(reachedWhen);

      let result: ScreenScan = {
        screenId: screen.id,
        url: screen.url,
        stops: [],
        drafts: [],
        gaps: [],
        applicability: [],
        reachedSelectorPresent: null,
        reachedWhenSelector: signal?.selector ?? null,
        ...responseFields(signal, null),
      };
      try {
        await page.gotoReady();

        // Whether this is the requested screen, signed in. The address and the password count are
        // read here and only here: providers click and press keys, a click can navigate, so a
        // later DOM read could not tell what the application did on load from what usabl did to
        // it afterwards.
        const landing = await observeLanding(page, {
          requestedUrl: screen.url,
          appBaseUrl: deps.config.appBaseUrl,
          sessionConfigured: deps.sessionConfigured === true,
          ...(reachedWhen === undefined ? { reachedWhen: undefined } : { reachedWhen }),
        });
        const notReached = redirectedAwayGap(screen.id, landing);
        if (notReached !== null) {
          // Not this screen. The walk and the providers are skipped rather than run and thrown
          // away: a keyboard order and a rule result from a sign-in page are not weak evidence
          // about the requested screen, they are evidence about a different page, and collecting
          // them at all invites a later change to keep them. Nothing is claimed about
          // reachability either, because this page is not the one the assertion describes.
          result = notReachedScan(screen, notReached, signal);
        } else {
          // Everything the page sent up to here is the screen loading. Everything after is usabl
          // pressing keys and running checks, so it never counts toward the readiness response.
          await page.markWalkStart();
          await page.armAnnouncementCapture();

          const transcript = await deps.stepRunner.run(page, tabSteps);
          const stops = trimCycle(transcript);

          await page.focusBody();
          // The walk can have opened a tooltip or a popover, and blurring it starts a fade out
          // that leaves the element in the DOM for a few hundred milliseconds. Content the scanner
          // itself caused is not the page, so the providers wait for it to go.
          await waitForScannerArtifactsToClear(page);
          const providerResult = await runProviders(
            deps.providers,
            { page, screen, config: deps.config, profile: screen.profile ?? 'app' },
            deps.allowedCapabilities,
          );
          const drafts = await attachDomSourceToDrafts(page, providerResult.drafts);

          // Measure the readiness signal after the walk and providers have run, while the page is
          // still open. This is the only place the live page exists; markUnseenScreens runs later
          // over collected scans and cannot query it. Both parts are read at this one moment. The
          // response part counts only requests sent before the walk began, so a request the page
          // sent on load and the server answered slowly counts, and one a key press or a provider
          // caused does not. The selector part sees the page as the checks left it.
          const readiness = await measureReadiness(page, signal, deps.config.appBaseUrl);

          // Rule A again, on the record as it stands now. Readiness settles about 1.5 seconds
          // after a stable shell appears, so an application that sends its identity request later
          // than that had sent nothing at the first read. A refusal recorded by either read means
          // the screen was not reached signed in, and everything collected from it goes with it.
          // This is the second and last read: a refusal that arrives after it is not seen. Only
          // the refused-request record is re-read; the address and the password count keep their
          // load-time values for the reason given above.
          //
          // The response record is re-read with it, so a refusal the application recovered from
          // during the walk is read against its later answer. Recovery also needs the declared
          // response to have been answered at an address that was never refused, by a request sent
          // before the walk; see recoveryStandsDown in redirected.ts. The selector part keeps its
          // load-time value, and the later measurement above still has to hold on its own for the
          // screen to count as seen.
          const lateRefusal = redirectedAwayGap(screen.id, {
            ...landing,
            unauthorizedApiUrls: await readRefusedRequests(page),
            apiResponses: await readApiResponses(page),
          });
          if (lateRefusal !== null) {
            result = notReachedScan(screen, lateRefusal, signal);
          } else {
            result = {
              screenId: screen.id,
              url: screen.url,
              stops,
              drafts,
              gaps: providerResult.gaps,
              applicability: providerResult.applicability,
              reachedSelectorPresent: readiness.selectorPresent,
              reachedWhenSelector: signal?.selector ?? null,
              ...responseFields(signal, readiness.responseSeen),
            };
          }
        }
      } catch (err) {
        result = failedScan(screen, `scan failed: ${errorMessage(err)}`);
      } finally {
        try {
          await page.close();
        } catch (err) {
          result = {
            ...result,
            gaps: [...result.gaps, notCoveredGap(screen.url, `scan cleanup failed: ${errorMessage(err)}`)],
          };
        }
      }

      return result;
    },
  };
}
