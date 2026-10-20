/**
 * Detects that a scan did not reach the screen it was asked for, signed in.
 *
 * The failure this closes, measured on a real login-gated application. The scan session expired.
 * usabl scanned what it got back under the requested screen ids, filed the sign-in page's barriers
 * as that screen's barriers, disclosed nothing, and told the gate that all twenty-nine accepted
 * barriers on those screens were resolved. The verdict came back red only because the page it
 * measured happened to carry barriers of its own. A clean one would have produced verified, with a
 * receipt, and a claim that the debt was paid.
 *
 * How that application actually behaves, measured. The browser never leaves the requested address.
 * The single page application renders a blank shell for over five seconds and then swaps a login
 * form in at the same URL: a heading, a text input, a password input, three focusable elements. A
 * scan that settles mid transition sees a partial page. So neither the address nor the password
 * field is reliable on its own here. What is reliable is the network: three of the page's own API
 * calls to identity endpoints answered 401 immediately. The same screen loaded with a working
 * session made nine API calls, all 200, and no 401 at all.
 *
 * THE RULES, and exactly when each fires.
 *
 * Two of them apply only when the operator configured a storage state, because only then has
 * anyone asserted that this scan is signed in. Without that assertion a 401 and a login form are
 * ordinary things for a signed-out visitor to meet, and firing on them would turn every deliberate
 * signed-out scan into a coverage gap.
 *
 * Rule A, refused data requests. Fires when a storage state is configured AND at least one of the
 *   page's own fetch or XHR requests to the application's own hostname had answered 401 at either
 *   of two reads: the first when readiness settles, the second after the walk, the checks, the
 *   source attachment, and the reachability measurement have run. A refusal that arrives after the
 *   second read is not seen.
 *
 *   One thing stands a refusal down, and it needs every one of these facts together:
 *
 *     - the surface's readiness signal declares a response path. A selector on its own, which is
 *       what the string form of reachedWhen is, never stands Rule A down, exactly as before
 *       recovery was read at all;
 *     - that path was answered with a 2xx, not an HTML page, at an address that was never refused
 *       in this record, by a request sent before the walk began;
 *     - a declared selector did not fail at load;
 *     - the last answer the page recorded for each refused address was a 2xx that is not an HTML
 *       page.
 *
 *   That is a token refresh: the identity call is refused, the client refreshes, the same call is
 *   answered, and the screen's own data arrives. No one fact is enough. A 401 followed by a 200 can
 *   be an application that dropped its stale token and was answered as an anonymous visitor, and a
 *   single 200 must not count both as the signal holding and as the refused address recovering,
 *   which is why the signal has to be held by an address that was never refused. See
 *   recoveryStandsDown and unrecoveredRefusals.
 *
 *   The application's hostname, not any host. An optional widget, an analytics beacon, or a
 *   third-party service whose own credentials are stale can answer 401 while the application
 *   session is perfectly good, and discarding a whole screen every run over that is not a cost
 *   worth paying. A refusal from the application's own API is the application saying it does not
 *   accept this session. See refusalsFromAppHost for the match and why an unreadable appBaseUrl
 *   counts everything.
 *
 *   Two reads, not one, and not a continuous watch. It is NOT free of a timing race. Readiness
 *   needs four equal DOM counts 500 ms apart plus 500 ms of network quiet, so a stable shell
 *   settles in about 1.5 s, and an application that sends its identity request later than that has
 *   sent nothing yet when the first read happens. Measured with the real adapter: a page fetching
 *   its identity endpoint at three seconds recorded nothing at the first read and the 401 during
 *   the walk window. The second read closes that window, and it deliberately includes traffic the
 *   providers caused, because a request a provider click triggered is still the application
 *   answering this session.
 *
 *   One boundary remains, and it cannot be closed from here: a 401 that arrives after the second
 *   read is not seen. That read is the last observation of the page before it is closed, so a
 *   response still in flight at that moment is never recorded.
 *
 *   401 only. 403 means authenticated and not permitted, which is a state a correctly signed-in
 *   scan can legitimately meet.
 *
 * Rule B, a password field anywhere. Fires when a storage state is configured AND at least one
 *   password input exists anywhere in the page: any frame, and inside open shadow roots. The
 *   address is not consulted, because the application that produced this defect never changes it.
 *   A signed-in session has no business being shown a password field.
 *
 *   Overridden by reachedWhen. When the surface declares a reachedWhen readiness signal and every
 *   part of it holds at the time of the check, this rule does not fire. The operator has made a
 *   positive assertion that this screen rendered, and that outranks a heuristic that it did not. A
 *   change-password screen, or a settings page with a re-authentication prompt, is exactly the
 *   case the override exists for: a real signed-in screen that really does contain a password
 *   field, which would otherwise be discarded on every run with no way to say so.
 *
 *   reachedWhen is operator-supplied policy, not independent proof. A selector that matches a
 *   persistent application shell, a header, a navigation, or a footer is present on a login wall
 *   too, and it will let Rule B pass the wrong page. To be worth anything it has to name content
 *   only this screen has: that screen's own table, its own heading, its own empty state.
 *
 *   The override does not extend to Rule A, for the same reason. A same-host 401 with a configured
 *   session is the application itself saying the session was refused, which is stronger evidence
 *   than any selector an operator wrote. Only the application answering that same address later,
 *   with the declared response held at another address, can stand it down.
 *
 * Rule C, redirected to a login page. Fires whether or not a storage state is configured, when the
 *   address the browser ended on differs from the one requested AND a password field is present.
 *   With no session configured this is still the wrong page: usabl was asked to measure one screen
 *   and measured another. With a session configured Rule B already covers it, so in practice this
 *   is the signed-out rule.
 *
 * Address comparison for Rule C normalizes scheme case, host case, default port, and one trailing
 * slash on the path. The query string is ignored, because a login redirect usually adds a return
 * address and a legitimately requested login screen often has one too, so a query difference
 * separates nothing. The fragment IS compared, because hash routers keep the whole route there and
 * ignoring it would leave every hash-routed application uncovered by Rule C.
 *
 * FALSE POSITIVES, which this can produce.
 *
 * Rule A fires on a refused same-host request even when the application session is fine, such as
 * an optional feature on the application's own API that this identity is not entitled to and whose
 * server answers 401 rather than 403, and it fires on every page-initiated 401 when appBaseUrl
 * cannot be parsed. Rule B fires on a signed-in screen that really does contain a password field
 * and declares no readiness signal that holds. Rule C fires on a screen reached at a different
 * path or fragment than the one configured that also shows a password field, which in practice is
 * a stale configured URL. In all three the cost is a coverage gap, so the run reports not_covered
 * rather than a verdict, and the fix is to correct the surface URL or to declare a reachedWhen
 * readiness signal for that screen. Rule A also fires on a refusal the application recovered from
 * when the screen declares no response path, because recovery alone is not proof the session
 * worked.
 *
 * FALSE NEGATIVES, which matter more and are real.
 *
 * A server-rendered login page that makes no API calls and carries no password input is not caught
 * by any rule here: a passkey prompt, a magic-link page, an email-first identity provider, or a
 * consent screen. An authentication wall that answers 200 to everything and renders a branded
 * landing page is not caught either. A login page served at the very address that was requested,
 * with no session configured, cannot be told from the screen itself. A sign-in wall whose API
 * lives on an unrelated hostname is not caught by Rule A, and neither is a 401 that arrives after
 * the second read. Rule B passes a wrong page whenever the surface declares a reachedWhen selector
 * that a login wall also matches, which any shell, header, navigation, or footer selector does.
 * The body-only detector in coverage/unseen.ts catches the subset of these that render nothing
 * focusable. A declared readiness signal (reachedWhen, see providers/reachability.ts) catches the
 * rest for that screen, because none of these pages renders the screen's own content or asks for
 * its own data; the unseen pass in coverage/unseen.ts turns a signal that did not hold into a gap.
 * Without a signal they stay open. A miss leaves the behaviour that was there before, so it never
 * manufactures a new false green.
 *
 * This unit reports coverage. It must never mint a verdict.
 */
import type { ApiResponse, CoverageGap, Page, ReachedWhenSignal } from '../contracts/index.js';
import { STORAGE_STATE_ENV_VAR } from '../deps/session.js';
import { appHostname, isAppHost, requestHostname } from './app-host.js';
import {
  isHtmlContentType,
  measureReadiness,
  readApiResponses,
  readinessMet,
  readinessSignalOf,
  responseSignalSeen,
} from './reachability.js';

/**
 * A password input is the strongest generic sign-in signal a page can carry. It is one element
 * type defined by the HTML specification, so it needs no framework knowledge, no wordlist, and no
 * guess about the application's routing. Every other candidate signal is weaker: a URL containing
 * "login" is a naming convention, a "Sign in" string is language dependent, and a form action is
 * whatever the application chose.
 */
const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';

export interface LandingObservation {
  /** The address the scan asked for, from operator config. */
  requestedUrl: string;
  /** `appBaseUrl`, whose hostname is what Rule A counts a refused request against. */
  appBaseUrl: string;
  /** The address the browser reported. Null when the page could not answer, so no claim is made. */
  landedUrl: string | null;
  /** Whether a password input was anywhere in the page. False when the probe could not run. */
  passwordFieldPresent: boolean;
  /** URLs of the page's own fetch or XHR requests that answered 401, unfiltered. */
  unauthorizedApiUrls: string[];
  /**
   * Whether the operator configured a storage state for this run. Rules A and B are claims about
   * a session that was asserted and did not work, so without the assertion they say nothing.
   */
  sessionConfigured: boolean;
  /**
   * The selector part of the operator's readiness signal, measured at the time of the check: null
   * when the surface declared no selector, true when it declared one and it matched, false when it
   * declared one and nothing matched.
   *
   * Measured here as well as after the providers run, because the two answer different questions.
   * The later measurement is the one recorded on the scan for the unseen detector. This one has to
   * be taken before the walk, because the walk and the providers are the thing this decides
   * whether to run at all.
   */
  reachedSelectorPresent: boolean | null;
  /**
   * The response part of the readiness signal, measured at the same moment. Absent or null when
   * the surface declared no response. The signal as a whole holds only when every declared part
   * holds, and only a signal that holds overrides Rule B or lets a recovered refusal stand.
   */
  reachedResponseSeen?: boolean | null;
  /**
   * The response path the surface declared, or absent or null when it declared none. Rule A reads
   * it to decide whether a refusal the application recovered from can stand down, against the
   * response record as it is at that read.
   */
  reachedWhenResponse?: string | null;
  /**
   * Every fetch or XHR response the page recorded, in arrival order. Rule A reads it to tell a
   * refusal the application recovered from from one it did not. Absent means none was recorded.
   */
  apiResponses?: ApiResponse[];
}

/** Whether the observation carries a readiness signal that held as a whole. */
function signalHeld(observation: LandingObservation): boolean {
  return (
    readinessMet({
      selectorPresent: observation.reachedSelectorPresent,
      responseSeen: observation.reachedResponseSeen ?? null,
    }) === true
  );
}

/**
 * Read the facts the rules need, while the live page is in hand.
 *
 * Every read fails soft. A page that cannot report its address, a count that throws, and a
 * network record that cannot be fetched are all absence of evidence, and absence of evidence must
 * never raise a gap: the caller would then drop a real screen's findings over a browser hiccup.
 * Every soft failure lands on "no claim".
 */
export async function observeLanding(
  page: Page,
  options: {
    requestedUrl: string;
    appBaseUrl: string;
    sessionConfigured: boolean;
    reachedWhen: string | ReachedWhenSignal | undefined;
  },
): Promise<LandingObservation> {
  let landedUrl: string | null = null;
  try {
    const reported = await page.currentUrl();
    landedUrl = typeof reported === 'string' && reported.trim().length > 0 ? reported : null;
  } catch {
    landedUrl = null;
  }
  let passwordFieldPresent = false;
  try {
    passwordFieldPresent = (await page.countEverywhere(PASSWORD_INPUT_SELECTOR)) > 0;
  } catch {
    passwordFieldPresent = false;
  }
  const unauthorizedApiUrls = await readRefusedRequests(page);
  const apiResponses = await readApiResponses(page);
  const signal = readinessSignalOf(options.reachedWhen);
  const readiness = await measureReadiness(page, signal, options.appBaseUrl);
  return {
    requestedUrl: options.requestedUrl,
    appBaseUrl: options.appBaseUrl,
    landedUrl,
    passwordFieldPresent,
    unauthorizedApiUrls,
    sessionConfigured: options.sessionConfigured,
    reachedSelectorPresent: readiness.selectorPresent,
    reachedResponseSeen: readiness.responseSeen,
    reachedWhenResponse: signal?.response ?? null,
    apiResponses,
  };
}

/**
 * Re-read the refused-request record on its own.
 *
 * Rule A is checked again once the walk and the providers have finished, because readiness settles
 * about 1.5 seconds after a stable shell appears and an application that sends its identity
 * request later than that has sent nothing yet at the first read. Only this record is re-read: the
 * address and the password count are deliberately left at their load-time values, because a
 * provider click can navigate the page and press keys, so a late DOM read could not tell what the
 * application did from what usabl did to it.
 */
export async function readRefusedRequests(page: Page): Promise<string[]> {
  try {
    const refused = await page.unauthorizedApiRequests();
    return Array.isArray(refused) ? refused.filter((url) => typeof url === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Which refused requests came from the application itself.
 *
 * The match is on hostname, not origin. An origin comparison is too narrow in three ways that all
 * happen in practice, and each one was measured flowing through a real run to a verified receipt
 * with a paid-down entry:
 *
 *   - a different port, because a scan target and its API can sit on different ports of one host;
 *   - a different scheme, because a page served over https can call an http endpoint, or the
 *     reverse in a lab;
 *   - an API subdomain, because `api.example.com` serving `example.com` is the ordinary shape.
 *
 * So a refused request counts when its hostname equals the `appBaseUrl` hostname, or ends with a
 * dot followed by it. Scheme and port are ignored. `api.example.com` counts for `example.com`;
 * `notexample.com` does not, because the dot is required.
 *
 * When `appBaseUrl` does not parse there is no hostname to compare against, and then EVERY
 * page-initiated 401 counts. That is the opposite of the earlier behaviour and it is deliberate.
 * This product fails toward disclosure: a base URL usabl cannot read is a configuration usabl
 * cannot reason about, and reporting not_covered on such a run is the honest outcome, where
 * counting nothing would quietly hand back a verdict. A refused address that will not parse counts
 * for the same reason: it is still a request the page made and the server refused.
 *
 * Exported so the rule that leans on it can be held without a browser.
 */
export function refusalsFromAppHost(urls: readonly string[], appBaseUrl: string): string[] {
  const appHost = appHostname(appBaseUrl);
  if (appHost === null) {
    return [...urls];
  }
  return urls.filter((url) => {
    const host = requestHostname(url);
    return host === null || isAppHost(host, appHost);
  });
}

/**
 * The comparable form of a request address: everything but the fragment. A browser never sends a
 * fragment, so two records of one request can only differ there by accident. The query IS kept: a
 * retry with a different query is a different request, and treating it as the same one would let
 * an unrelated success answer for a refusal.
 */
function requestKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The refused requests the application never recovered from.
 *
 * A refused address is recovered when the LAST answer the page recorded for that same address, by
 * arrival order, was a 2xx that is not an HTML page. That is the token refresh shape: the identity
 * call is refused, the client refreshes its credentials, and the same call is then answered. If
 * the last answer was another refusal, a sign-in page, or nothing, it stays refused. A success on
 * a different address, such as the refresh call itself, says nothing about whether this one was
 * ever answered, so it never counts.
 *
 * This is only consulted when recoveryStandsDown says the screen's own data arrived on its own,
 * because a 401 followed by a 200 on its own does not prove the session worked. An application can
 * drop a stale token on a 401, retry the same call, and be answered as an anonymous visitor.
 *
 * Exported so the rule can be held without a browser.
 */
export function unrecoveredRefusals(refused: readonly string[], responses: readonly ApiResponse[]): string[] {
  const last = new Map<string, ApiResponse>();
  for (const response of responses) {
    last.set(requestKey(response.url), response);
  }
  return refused.filter((url) => {
    const answer = last.get(requestKey(url));
    return (
      answer === undefined || answer.status < 200 || answer.status > 299 || isHtmlContentType(answer.contentType)
    );
  });
}

/**
 * Whether this record is allowed to stand refused requests down at all, before each one is read
 * against its own later answer.
 *
 * It needs positive evidence that is independent of the refusals. The surface has to declare a
 * response path, and that path has to have been answered by an address this record never refused,
 * by the same rule the readiness signal uses: a 2xx on the application's own host, not an HTML
 * page, from a request sent before the walk. A declared selector must not have failed at load.
 *
 * Without the "never refused" part, one 200 would do two jobs. A sign-in wall that refuses
 * /api/users?page=1 and then answers the anonymous retry of that same address with a 200 would
 * hold a "/api/users" signal and recover the refusal with the same answer. A selector on its own
 * never stands Rule A down, because a selector is operator policy and a shell selector matches a
 * login wall.
 */
function recoveryStandsDown(observation: LandingObservation): boolean {
  const declaredPath = observation.reachedWhenResponse ?? null;
  if (declaredPath === null || observation.reachedSelectorPresent === false) {
    return false;
  }
  const responses = observation.apiResponses ?? [];
  const refusedKeys = new Set([
    ...observation.unauthorizedApiUrls.map(requestKey),
    ...responses.filter((response) => response.status === 401).map((response) => requestKey(response.url)),
  ]);
  const neverRefused = responses.filter((response) => !refusedKeys.has(requestKey(response.url)));
  return responseSignalSeen(neverRefused, declaredPath, observation.appBaseUrl);
}

/**
 * The comparable form of an address: origin, path with one trailing slash removed, and fragment.
 * Returns null when the string is not a URL this can parse, which the caller falls back from.
 */
function normalizeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const path =
    parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  return `${parsed.origin}${path.length === 0 ? '/' : path}${parsed.hash}`;
}

/**
 * An address as it is safe to print: scheme, host, port, and path, and nothing else.
 *
 * Three parts of a URL can hold a credential and all three are removed. The userinfo carries HTTP
 * basic credentials as `user:password@host`, which is how a lab or a preview environment is often
 * reached. The query can carry a return address, a CSRF nonce, or an OAuth authorization code. The
 * fragment carries a live access token in the OAuth implicit flow.
 *
 * This is applied to the requested URL as well as the landing URL. The requested URL comes from
 * operator config, which is usually harmless, but "usually" is not a property to publish on: an
 * operator can put a basic-auth credential or a preview token in a configured surface URL, and this
 * text is rendered by the CLI, the overlay, and the pull request comment.
 *
 * Exported so surfaces and tests can hold the one definition rather than each writing their own.
 */
export function sanitizeUrlForDisplay(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'an address usabl could not parse';
  }
  // Rebuilt from the parsed URL rather than assembled from origin and path, so a scheme with no
  // ordinary origin still prints as itself instead of the string "null" and a path.
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * A refused request address, shortened before it is printed.
 *
 * sanitizeUrlForDisplay is not enough here. It keeps the whole path, and a path is a place
 * applications put opaque values: a password reset is `/reset/<token>`, an invitation is
 * `/invite/<token>`, a signed download is `/files/<signature>/name`. The endpoint an operator needs
 * to recognise is the front of the path, so the rest is dropped rather than published.
 *
 * Exactly what this discloses, so a reader can judge the risk rather than trust a summary:
 *
 *   - the scheme;
 *   - the complete hostname, as punycode when it was written in unicode;
 *   - the numeric port, when the address carries one that is not the scheme default;
 *   - either of the FIRST TWO path segments, and only while a segment starts with an ASCII letter,
 *     is at most 24 characters, and contains nothing but lowercase ASCII letters, digits, dot,
 *     underscore, and hyphen. Everything from the first segment that fails those tests is dropped,
 *     and a dropped tail is marked with an ellipsis.
 *
 * Removed in every case: the userinfo, the query string, and the fragment. A unicode path segment
 * fails the character test and is cut.
 *
 * The consequence a reader has to take on board: a secret that is short, lowercase, and sitting in
 * either of the first two path segments WILL be printed. `/reset/<token>` is cut because a token is
 * normally mixed case or long, not because the position is protected. Nothing that prints any part
 * of a path can promise otherwise, and this bounds exposure rather than removing it.
 */
const ROUTE_WORD = /^[a-z][a-z0-9._-]*$/;
const ROUTE_WORD_MAX_LENGTH = 24;
const KEPT_PATH_SEGMENTS = 2;

function isRouteWord(segment: string): boolean {
  return segment.length <= ROUTE_WORD_MAX_LENGTH && ROUTE_WORD.test(segment);
}

export function sanitizeRefusedUrlForDisplay(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'an address usabl could not parse';
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const kept: string[] = [];
  for (const segment of segments.slice(0, KEPT_PATH_SEGMENTS)) {
    if (!isRouteWord(segment)) {
      break;
    }
    kept.push(segment);
  }
  // A path that was cut says so, so nobody reads the short form as the whole endpoint.
  const cut = segments.length > kept.length;
  parsed.pathname = `/${kept.join('/')}${cut ? (kept.length === 0 ? '...' : '/...') : ''}`;
  return parsed.toString();
}

function gapFor(requestedUrl: string, reason: string): CoverageGap {
  return {
    // The configured surface URL, verbatim. The overlay attributes a gap to a screen by matching
    // this against the scan target exactly, and every other gap in the result uses the operator's
    // own configured value, so a sanitized ref here would silently orphan the gap. Nothing is
    // published from this field that the operator did not put in their own config file; the
    // reason below is where the sanitized form goes.
    ref: requestedUrl,
    state: 'not-covered',
    reason,
  };
}

// One closing sentence for all three rules, so an operator meets the same instruction wherever the
// detection came from.
const SESSION_ADVICE =
  `The usual cause is a missing or expired ${STORAGE_STATE_ENV_VAR} session. Mint a new session, ` +
  `point ${STORAGE_STATE_ENV_VAR} at it, and run usabl again.`;

function notMeasured(screenId: string): string {
  return (
    `usabl did not measure ${screenId}: it reports no findings for it and confirms no accepted ` +
    'barrier on it as resolved.'
  );
}

/**
 * Judge one observation. Returns the coverage gap when the screen was not reached signed in, or
 * null when there is no case to answer.
 *
 * Pure, so every rule can be held in tests without a browser. The gap is `not-covered`, the state
 * the codebase already uses for a surface that was in scope and could not be exercised. That state
 * is what the gate reads as unverified, and a screen carrying any gap is excluded from the
 * cleanly-scanned set run() hands the gate, which is what stops a floored barrier on this screen
 * from being claimed as paid down.
 *
 * Rule order is A, then B, then C. It only decides which sentence an operator reads when more than
 * one rule holds, and the most specific evidence goes first: a refused request names an endpoint,
 * a password field names only itself.
 */
export function redirectedAwayGap(screenId: string, observation: LandingObservation): CoverageGap | null {
  const requested = sanitizeUrlForDisplay(observation.requestedUrl);

  // Rule A: the application's own data requests were refused as unauthenticated. A selector does
  // not override this: reachedWhen is operator-supplied policy rather than independent proof, and
  // a selector aimed at a persistent shell is present on a login wall too. The application
  // refusing the session is the stronger evidence. The one exception is a token refresh: the
  // declared response path was answered at an address that was never refused, AND each refused
  // address was answered later. See recoveryStandsDown.
  const fromAppHost = refusalsFromAppHost(observation.unauthorizedApiUrls, observation.appBaseUrl);
  const refused = recoveryStandsDown(observation)
    ? unrecoveredRefusals(fromAppHost, observation.apiResponses ?? [])
    : fromAppHost;
  if (observation.sessionConfigured && refused.length > 0) {
    const example = sanitizeRefusedUrlForDisplay(refused[0] as string);
    const count = refused.length;
    return gapFor(
      observation.requestedUrl,
      `usabl asked for ${requested} with a configured session, and ${count} of the application's ` +
        `own data request${count === 1 ? '' : 's'} came back 401, meaning the server did not accept ` +
        `the session as authenticated. One of them was ${example}. Whatever rendered is what a ` +
        `refused visitor sees, not this screen, so ${notMeasured(screenId)} Addresses are shown ` +
        'without their sign-in credentials, query string, or fragment, and a refused request keeps ' +
        'only the front of its path, because any of those can carry a token. ' +
        `${SESSION_ADVICE}`,
    );
  }

  // Rule B: a password field anywhere, with a session asserted and no positive assertion from the
  // operator that this screen rendered. A readiness signal that held outranks the heuristic, which
  // is what makes a genuine change-password or re-authenticate screen scannable.
  if (observation.sessionConfigured && observation.passwordFieldPresent && !signalHeld(observation)) {
    return gapFor(
      observation.requestedUrl,
      `usabl asked for ${requested} with a configured session and the page it got asks for a ` +
        'password, in this document, a frame of it, or a component inside it. A signed-in session ' +
        `is never shown a password field, so this is a sign-in page and ${notMeasured(screenId)} ` +
        'The address is shown without its sign-in credentials, query string, or fragment, because ' +
        `any of the three can carry a token. ${SESSION_ADVICE}`,
    );
  }

  // Rule C: the browser ended somewhere else and that somewhere asks for a password.
  if (observation.landedUrl === null || !observation.passwordFieldPresent) {
    return null;
  }
  const requestedKey = normalizeUrl(observation.requestedUrl);
  const landedKey = normalizeUrl(observation.landedUrl);
  // When either address will not parse, fall back to comparing the raw strings. That is stricter
  // than parsing, not looser, and the password condition still has to hold.
  const sameScreen =
    requestedKey !== null && landedKey !== null
      ? requestedKey === landedKey
      : observation.requestedUrl.trim() === observation.landedUrl.trim();
  if (sameScreen) {
    return null;
  }
  const landing = sanitizeUrlForDisplay(observation.landedUrl);
  return gapFor(
    observation.requestedUrl,
    `usabl asked for ${requested} and the browser was redirected away, ending on ${landing}, ` +
      `which asks for a password. That is a sign-in page and not this screen, so ${notMeasured(screenId)} ` +
      'Addresses are shown without their sign-in credentials, query string, or fragment, because ' +
      `any of the three can carry a token. ${SESSION_ADVICE}`,
  );
}
