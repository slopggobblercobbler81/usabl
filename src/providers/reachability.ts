/**
 * The per-screen readiness signal: positive evidence that this screen really rendered.
 *
 * A surface can declare a reachedWhen signal with up to two parts, and every declared part has to
 * hold:
 *
 *   selector  a CSS selector that must match at least one element in the rendered page;
 *   response  a URL path that a fetch or XHR request to the application's own host must have
 *             answered with a 2xx status.
 *
 * This is the opposite of inferring a blank page from what two screens have in common, and of the
 * session heuristics in redirected.ts, which look for signs of a sign-in page. A sign-in page that
 * makes no API call and has no password field (a passkey prompt, a magic-link page), and an
 * authentication wall that answers 200 to everything, give those heuristics nothing to see. They
 * fail a selector for this screen's own content, because none of them renders it. They fail a
 * response path when their page does not request this screen's data, or answers that request with
 * an HTML page. A wall that answers the screen's data path with a 200 that is not HTML holds the
 * response part, which is why a path is best paired with a selector.
 *
 * The signal is general on purpose. It answers "did this screen render", not "is the session
 * alive", so anything that needs that answer can use it.
 *
 * Every part is measured as a plain presence test, so nothing that leans on it can depend on how
 * many nodes matched, on DOM iteration order, or on the order responses arrived in.
 *
 * Each part reads as a tri-state:
 *   null  = the part was not declared, so no claim is made.
 *   true  = the part was declared and held.
 *   false = the part was declared and did not hold, so the screen did not show what the operator
 *           said proves it loaded.
 *
 * A probe that fails reads as false, never as true. A malformed selector cannot match anything, and
 * a response record that cannot be read has shown nothing. Either way the screen becomes a gap
 * rather than a pass, and the gap names the part, which is what the operator needs to fix it.
 */
import type { ApiResponse, Page, ReachedWhenSignal } from '../contracts/index.js';
import { appHostname, isAppHost, requestHostname } from './app-host.js';

/** A declared signal with both parts spelled out. Null means the part was not declared. */
export interface ReadinessSignal {
  selector: string | null;
  response: string | null;
}

/** What one measurement of a signal found, part by part. */
export interface ReadinessMeasurement {
  selectorPresent: boolean | null;
  responseSeen: boolean | null;
}

/**
 * The declared signal in one shape. The string form of reachedWhen is a selector on its own, which
 * is the shape every config written before the object form existed uses.
 */
export function readinessSignalOf(reachedWhen: string | ReachedWhenSignal | undefined): ReadinessSignal | null {
  if (reachedWhen === undefined) {
    return null;
  }
  if (typeof reachedWhen === 'string') {
    return { selector: reachedWhen, response: null };
  }
  return { selector: reachedWhen.selector ?? null, response: reachedWhen.response ?? null };
}

/**
 * Whether the signal held as a whole: null when nothing was declared, true only when every declared
 * part held, false when any declared part did not.
 */
export function readinessMet(measured: ReadinessMeasurement): boolean | null {
  const parts = [measured.selectorPresent, measured.responseSeen].filter((part) => part !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.every((part) => part === true);
}

/**
 * The configured path in the form a browser puts on the wire. URL parsing percent-encodes what a
 * request line cannot carry, so a path written with a non-ASCII letter compares equal to the
 * request the browser actually sent for it.
 */
function encodedPath(path: string): string | null {
  try {
    return new URL(path, 'http://usabl.invalid').pathname;
  } catch {
    return null;
  }
}

function pathContinues(requestPath: string, declared: string): boolean {
  if (requestPath === declared) {
    return true;
  }
  const prefix = declared.endsWith('/') ? declared : `${declared}/`;
  return requestPath.startsWith(prefix);
}

/**
 * Whether a Content-Type names an HTML document. Compared on the media type alone, without its
 * parameters and in any case, so "text/html; charset=utf-8" and "TEXT/HTML" are both HTML.
 * XHTML is a page too.
 */
export function isHtmlContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
}

/**
 * Whether the declared response path was answered with a success on the application's own host.
 *
 * Host: the appBaseUrl hostname or a subdomain of it, on any scheme and port, the same match the
 * refused-request rule uses. A third-party service answering a request with the same path must not
 * stand in for this screen. When appBaseUrl cannot be read there is no host to match, and nothing
 * counts: the screen becomes a gap, which is the safe direction for a positive signal.
 *
 * Path: the request path equals the declared path, or continues it after a slash. So "/api/users"
 * matches "/api/users", "/api/users?page=2", and "/api/users/42", and does not match
 * "/api/users-archive". The query string is never compared.
 *
 * Status: 200 to 299 only. A refusal, a redirect, and a server error are not the screen's data.
 *
 * Kind: an HTML answer never counts. A sign-in page, an SSO or proxy login, and a development
 * server's history fallback all answer a data call with a page and a 200. An API that really
 * answers with HTML therefore never satisfies the signal, and the screen becomes a gap, which is
 * the safe direction. An answer with no Content-Type counts.
 *
 * When: only a request sent before the walk began counts, whenever its answer arrived. A request
 * sent after that was caused by usabl's own key presses or checks, or by the page during them,
 * and is not evidence that the screen loaded.
 *
 * Exported so the rule can be held without a browser.
 */
export function responseSignalSeen(
  responses: readonly ApiResponse[],
  declaredPath: string,
  appBaseUrl: string,
): boolean {
  const appHost = appHostname(appBaseUrl);
  const declared = encodedPath(declaredPath);
  if (appHost === null || declared === null) {
    return false;
  }
  return responses.some((response) => {
    if (response.status < 200 || response.status > 299) {
      return false;
    }
    if (!response.sentBeforeWalk || isHtmlContentType(response.contentType)) {
      return false;
    }
    const host = requestHostname(response.url);
    if (host === null || !isAppHost(host, appHost)) {
      return false;
    }
    return pathContinues(new URL(response.url).pathname, declared);
  });
}

/**
 * Measure the selector part on its own. Kept as its own export because the password-field rule
 * and older callers ask only this question.
 */
export async function measureReachability(
  page: Page,
  reachedWhen: string | undefined,
): Promise<boolean | null> {
  if (reachedWhen === undefined) {
    return null;
  }
  try {
    const matches = await page.queryAll(reachedWhen);
    return matches.length > 0;
  } catch {
    return false;
  }
}

/**
 * Read the page's data responses. A record that cannot be read is an empty one. An entry without a
 * readable address or status is left out. An entry that does not say it was sent before the walk
 * reads as sent after it, and an unreadable content type as none.
 */
export async function readApiResponses(page: Page): Promise<ApiResponse[]> {
  try {
    const responses: unknown = await page.apiResponses();
    if (!Array.isArray(responses)) {
      return [];
    }
    const read: ApiResponse[] = [];
    for (const response of responses as unknown[]) {
      if (typeof response !== 'object' || response === null) {
        continue;
      }
      const url: unknown = Reflect.get(response, 'url');
      const status: unknown = Reflect.get(response, 'status');
      if (typeof url !== 'string' || typeof status !== 'number') {
        continue;
      }
      const contentType: unknown = Reflect.get(response, 'contentType');
      read.push({
        url,
        status,
        contentType: typeof contentType === 'string' ? contentType : null,
        sentBeforeWalk: Reflect.get(response, 'sentBeforeWalk') === true,
      });
    }
    return read;
  } catch {
    return [];
  }
}

/**
 * Measure every declared part of a signal against the live page, at one moment.
 */
export async function measureReadiness(
  page: Page,
  signal: ReadinessSignal | null,
  appBaseUrl: string,
): Promise<ReadinessMeasurement> {
  const selectorPresent = await measureReachability(page, signal?.selector ?? undefined);
  const responseSeen =
    signal === null || signal.response === null
      ? null
      : responseSignalSeen(await readApiResponses(page), signal.response, appBaseUrl);
  return { selectorPresent, responseSeen };
}
