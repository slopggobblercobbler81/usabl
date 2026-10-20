/**
 * Parse operator usabl.config.json into UsablConfig.
 * This unit validates shape only.
 * It must never mint a verdict or choose scan targets on its own.
 */
import type { ReachedWhenSignal, SurfaceConfig, UsablConfig } from '../contracts/index.js';
import { assertSurfaceIds } from './surface-ids.js';
import { configError } from './config-error.js';
import { expandBraces } from '../primitives/match-glob.js';
import { parseNoiseBudgetConfig } from '../output/noise-budget.js';

function expectObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError`${label} must be an object`;
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw configError`${label} must be a string`;
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw configError`${label} must be a string array`;
  }
  return value;
}

// matchGlob supports `*`, `**`, and `{a,b}` brace groups only. File discovery uses Node's
// glob, which supports more. A glob usabl cannot match the same way discovery does would
// select files at discovery and then drop them at enforcement, a silent mismatch that can
// pass a run that should gate. Refuse such a glob here, at config load, before any run
// launches. These are the characters matchGlob cannot faithfully evaluate after braces.
const UNSUPPORTED_GLOB_CHARS = ['[', ']', '(', ')', '?'];

function checkGlobSupported(pattern: string, label: string): void {
  for (const char of UNSUPPORTED_GLOB_CHARS) {
    if (pattern.includes(char)) {
      throw configError`${label} pattern "${pattern}" uses unsupported glob character "${char}". usabl globs support only *, **, and {a,b} brace groups.`;
    }
  }
  // A nested or unbalanced brace cannot be expanded, so matchGlob would treat the braces
  // as literal text while discovery would not. Refuse it for the same reason.
  if (pattern.includes('{') && expandBraces(pattern) === null) {
    throw configError`${label} pattern "${pattern}" uses an unsupported brace form. usabl globs support only *, **, and single-level {a,b} brace groups.`;
  }
}

function expectGlobArray(value: unknown, label: string): string[] {
  const patterns = expectStringArray(value, label);
  for (const pattern of patterns) {
    checkGlobSupported(pattern, label);
  }
  return patterns;
}

// A budget of zero, a negative, a fraction, or a string would either fail every screen or fail
// deep inside a browser call. Refusing it here keeps the failure at config load, before a run
// launches anything.
function expectPositiveWholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw configError`${label} must be a positive whole number of milliseconds`;
  }
  return value;
}

// The readiness signal a surface declares: positive evidence that the screen really rendered. Two
// shapes are accepted. A string is a CSS selector on its own, which is the shape every earlier
// config uses. An object names a selector, a response path, or both, and every part it names has to
// hold for the screen to count as seen.
//
// An empty selector would match nothing and mark every scan of the surface unseen, which is a
// silent failure hiding as coverage loss. Refuse it at config load so the operator fixes it before
// a run.
//
// What the selector should name cannot be checked here, and it matters. A signal that holds is
// read as the operator asserting this screen rendered, and it overrides the password-field rule
// that would otherwise flag a sign-in page. It is policy, not proof: a selector aimed at a
// persistent application shell, a header, a navigation, or a footer is present on a login wall
// too, so it would pass the wrong page. The refusal message says so, because config load is the
// last place an operator reads anything about this field.
//
// The advice is written into each message rather than interpolated, because configError caps
// every interpolated value at a short length and would cut it off.
const REACHED_WHEN_KEYS = new Set(['selector', 'response']);

function parseSelector(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw configError`${label} must be a non-empty CSS selector naming content only this screen has, such as its own table or heading. A shell, header, navigation, or footer selector matches a sign-in page too and would let a wrong page pass as this screen.`;
  }
  return raw;
}

// The response part is a path on the application, matched against the page's own data requests to
// the appBaseUrl host. It is refused unless it is a plain absolute path, because every other shape
// either cannot match what the matcher compares or matches far too much:
//
//   - a full URL or a "//host" address names a host, and the host is always the application's;
//   - a query or a fragment is never compared, so writing one would read as a filter that is not
//     applied;
//   - whitespace and control characters cannot appear in a request path as sent, and URL parsing
//     strips a trailing control character;
//   - a backslash is read as a slash by URL parsing, and a "." or ".." segment, plain or
//     percent-encoded, is resolved away by it, so the path compared is not the path written;
//   - "/" alone, or anything that parses to it, is answered by every data request on the host,
//     including a sign-in wall's own, so it proves nothing about this screen.
//
// The message never repeats the value, because a value that parses differently from how it reads
// is exactly what an operator cannot judge from a quote of it.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

function isPlainResponsePath(raw: string): boolean {
  if (
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('?') ||
    raw.includes('#') ||
    raw.includes('\\') ||
    /\s/.test(raw) ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    return false;
  }
  if (raw.split('/').some((segment) => DOT_SEGMENT.test(segment))) {
    return false;
  }
  try {
    return new URL(raw, 'http://usabl.invalid').pathname !== '/';
  } catch {
    return false;
  }
}

function parseResponsePath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !isPlainResponsePath(raw)) {
    throw configError`${label} must be a path on the application that only this screen requests, such as "/api/users". It starts with one slash, is not the root, and has no host, query, fragment, spaces, control characters, backslashes, or dot segments.`;
  }
  return raw;
}

function parseReachedWhen(raw: unknown, index: number): string | ReachedWhenSignal | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const label = `surfaces[${index}].reachedWhen`;
  if (typeof raw === 'string') {
    return parseSelector(raw, label);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw configError`${label} must be a CSS selector string, or an object with a selector, a response, or both`;
  }
  // A misspelled key would drop that part of the signal without a word, and the screen would be
  // judged on less evidence than the operator wrote down. Refuse it.
  for (const key of Object.keys(raw)) {
    if (!REACHED_WHEN_KEYS.has(key)) {
      throw configError`${label} has an unknown key "${key}". The keys it accepts are selector and response.`;
    }
  }
  const selectorRaw = Reflect.get(raw, 'selector');
  const responseRaw = Reflect.get(raw, 'response');
  if (selectorRaw === undefined && responseRaw === undefined) {
    throw configError`${label} must declare a selector, a response, or both`;
  }
  return {
    ...(selectorRaw === undefined ? {} : { selector: parseSelector(selectorRaw, `${label}.selector`) }),
    ...(responseRaw === undefined ? {} : { response: parseResponsePath(responseRaw, `${label}.response`) }),
  };
}

// A surface id and a discovered route screen id are one namespace. This declaration is how an
// operator says the two name the same screen, so the planner never has to guess. Only a boolean is
// accepted: a string naming the route would be a second copy of the surface's own id, since the
// planner matches an override by id, and two copies of one fact can disagree.
function parseOverridesDiscoveredRoute(raw: unknown, index: number): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'boolean') {
    throw configError`surfaces[${index}].overridesDiscoveredRoute must be true or false`;
  }
  return raw;
}

function parseSurface(raw: unknown, index: number): SurfaceConfig {
  const surface = expectObject(raw, `surfaces[${index}]`);
  const reachedWhen = parseReachedWhen(Reflect.get(surface, 'reachedWhen'), index);
  const overridesDiscoveredRoute = parseOverridesDiscoveredRoute(
    Reflect.get(surface, 'overridesDiscoveredRoute'),
    index,
  );
  return {
    id: expectString(Reflect.get(surface, 'id'), `surfaces[${index}].id`),
    url: expectString(Reflect.get(surface, 'url'), `surfaces[${index}].url`),
    files: expectStringArray(Reflect.get(surface, 'files'), `surfaces[${index}].files`),
    ...(reachedWhen === undefined ? {} : { reachedWhen }),
    ...(overridesDiscoveredRoute === undefined ? {} : { overridesDiscoveredRoute }),
  };
}

export function parseUsablConfig(raw: string): UsablConfig {
  // A JSON.parse failure message quotes the offending input back, so it is operator text on the
  // same egress as every other message here and cannot be allowed to pass through unscrubbed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configError`usabl.config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const root = expectObject(parsed, 'config');
  const discovery = expectObject(Reflect.get(root, 'discovery'), 'discovery');
  const surfacesRaw = Reflect.get(root, 'surfaces');
  if (!Array.isArray(surfacesRaw)) {
    throw configError`surfaces must be an array`;
  }

  const surfaces = surfacesRaw.map((surface, index) => parseSurface(surface, index));
  // Shape is checked per entry above. Identity is a property of the whole list, so it is
  // checked once the list exists.
  assertSurfaceIds(surfaces);

  const requirementsRaw = Reflect.get(root, 'requirements');
  const requirements =
    requirementsRaw === undefined ? undefined : expectString(requirementsRaw, 'requirements');

  const promotedRaw = Reflect.get(root, 'promotedObligations');
  const promotedObligations =
    promotedRaw === undefined ? undefined : expectStringArray(promotedRaw, 'promotedObligations');

  const readyTimeoutRaw = Reflect.get(root, 'readyTimeoutMs');
  const readyTimeoutMs =
    readyTimeoutRaw === undefined
      ? undefined
      : expectPositiveWholeNumber(readyTimeoutRaw, 'readyTimeoutMs');

  const noiseBudgetRaw = Reflect.get(root, 'noiseBudget');
  const noiseBudget =
    noiseBudgetRaw === undefined ? undefined : parseNoiseBudgetConfig(noiseBudgetRaw);

  return {
    appBaseUrl: expectString(Reflect.get(root, 'appBaseUrl'), 'appBaseUrl'),
    uiFileGlobs: expectGlobArray(Reflect.get(root, 'uiFileGlobs'), 'uiFileGlobs'),
    discovery: {
      // routerFile is an exact path read with fs.readFile, never matched by matchGlob, so it
      // is not glob-validated. surfaces[].files are compared with exact string equality in the
      // planner, so they are exact paths too and stay plain string arrays.
      routerFile: expectString(Reflect.get(discovery, 'routerFile'), 'discovery.routerFile'),
      wideBlastGlobs: expectGlobArray(Reflect.get(discovery, 'wideBlastGlobs'), 'discovery.wideBlastGlobs'),
    },
    surfaces,
    guardedPaths: expectGlobArray(Reflect.get(root, 'guardedPaths'), 'guardedPaths'),
    ...(requirements === undefined ? {} : { requirements }),
    ...(promotedObligations === undefined ? {} : { promotedObligations }),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    ...(noiseBudget === undefined ? {} : { noiseBudget }),
  };
}
