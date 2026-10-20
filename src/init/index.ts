/**
 * Draft policy generation for first-run onboarding.
 * This unit infers config and route sidecars from the working tree.
 * It must never mint a verdict, write waivers or evidence, or consume the
 * files it just wrote in the same run. A wrong mapping is worse than a gap.
 */
import { posix } from 'node:path';
import type { SurfaceConfig, UsablConfig } from '../contracts/index.js';
import { operatorText } from '../intake/config-error.js';
import type { RouteEntry, RouteManifest } from '../coverage/route-manifest.js';
import {
  isRouterSource,
  mergeParsedRoutes,
  parseDataRouterRoutes,
  screenIdFromUrl,
  type ParsedRouteSite,
} from '../coverage/router-parse.js';
import { validateId } from '../intake/id-grammar.js';
import { STORAGE_STATE_ENV_VAR } from '../deps/session.js';
import { APP_INIT_REFUSAL, unusableIdsError, type UnusableId } from './unusable-ids.js';

// Init writes only these two drafts. Waivers stay human-authored judgment.
const POLICY_FILES = ['usabl.config.json', 'usabl.routes.json'] as const;
// Include the .cts and .cjs forms Vite also resolves, so init inspects the operator's real
// config instead of missing it and defaulting the origin.
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];
const ROUTER_CANDIDATES = ['src/App.tsx', 'src/App.jsx', 'src/routes.tsx', 'src/router.tsx'];
// Seed guardedPaths to match the engine's always-guarded set so a first draft
// cannot omit a ledger the gate later treats as trusted policy.
const ALWAYS_GUARDED = [
  'usabl.config.json',
  'usabl.routes.json',
  '.usabl-evidence.json',
  '.usabl-waivers.json',
];
const ENTRY_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

export interface InitFs {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface InitDraft {
  config: UsablConfig;
  routes: RouteManifest;
  notes: string[];
}

export interface WriteInitResult {
  ok: boolean;
  written: string[];
  refused: string[];
  message: string;
}

function parseVitePort(raw: string): number | null {
  const match = raw.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d+)/);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return Number(match[1]);
}

function parseLocalImports(raw: string): Map<string, string> {
  // Only relative specifiers (starting with ".") can prove a local entry file.
  // Package imports are left unmapped so init cannot guess across dependencies.
  const imports = new Map<string, string>();
  const named = /import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of raw.matchAll(named)) {
    const names = match[1];
    const specifier = match[2];
    if (typeof names !== 'string' || typeof specifier !== 'string') {
      continue;
    }
    for (const part of names.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length === 0 || trimmed.startsWith('type ')) {
        continue;
      }
      const aliased = trimmed.split(/\s+as\s+/);
      const local = aliased[aliased.length - 1]?.trim();
      if (local !== undefined && local.length > 0) {
        imports.set(local, specifier);
      }
    }
  }
  const defaults = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of raw.matchAll(defaults)) {
    const local = match[1];
    const specifier = match[2];
    if (typeof local === 'string' && typeof specifier === 'string') {
      imports.set(local, specifier);
    }
  }
  return imports;
}

function isProvenRoutePath(path: string): boolean {
  // Root-absolute app paths only. Relative nested paths would be rewritten as
  // /child instead of /parent/child. Protocol-relative and @ URLs can leave
  // the operator origin. Catch-alls are not screens.
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('@') && path !== '*';
}

// The tag name the route regex below matches. The attribute group starts immediately after it,
// which is what turns an offset inside the attributes into an offset in the file.
const ROUTE_TAG_PREFIX = '<Route';

function parseRouteTags(raw: string): ParsedRouteSite[] {
  const routes: ParsedRouteSite[] = [];
  // Self-closing tags only. Opening <Route> parents are layouts; inferring
  // their children would require a nesting walk this draft does not claim.
  const tags = /<Route\b([^>]*?)\/>/g;
  for (const match of raw.matchAll(tags)) {
    const attrs = match[1];
    if (typeof attrs !== 'string' || match.index === undefined) {
      continue;
    }
    const pathMatch = attrs.match(/\bpath\s*=\s*['"`]([^'"`]+)['"`]/);
    if (pathMatch === null || pathMatch[1] === undefined || pathMatch.index === undefined) {
      continue;
    }
    const path = pathMatch[1];
    if (path === '*') {
      continue;
    }
    const elementMatch = attrs.match(/\belement\s*=\s*\{\s*<\s*([A-Za-z_$][\w$]*)/);
    // Point at the path attribute, not at the start of the tag, so a tag spread over several
    // lines is reported at the line that carries the path.
    routes.push({
      path,
      component: elementMatch?.[1] ?? null,
      offset: match.index + ROUTE_TAG_PREFIX.length + pathMatch.index,
    });
  }
  return routes;
}

// One-based line number of a source offset, the way an editor numbers lines.
function lineAtOffset(raw: string, offset: number): number {
  return raw.slice(0, offset).split('\n').length;
}

async function resolveEntryFile(
  fs: InitFs,
  routerFile: string,
  specifier: string,
): Promise<string | null> {
  const resolved = posix.normalize(posix.join(posix.dirname(routerFile), specifier));
  // Stay inside the project tree. A `..` after normalize is an unproven path,
  // not an entry file we are willing to attribute.
  if (resolved.startsWith('..') || posix.isAbsolute(resolved)) {
    return null;
  }
  const hasExtension = ENTRY_EXTENSIONS.some((ext) => resolved.endsWith(ext));
  const candidates = hasExtension
    ? [resolved]
    : ENTRY_EXTENSIONS.map((ext) => resolved + ext);
  for (const candidate of candidates) {
    if ((await fs.readFile(candidate)) !== null) {
      return candidate;
    }
  }
  return null;
}

function surfaceUrl(baseUrl: string, routePath: string): string | null {
  try {
    const origin = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const expectedOrigin = new URL(baseUrl).origin;
    const resolved = new URL(routePath, origin);
    // Same origin lock as coverage planning. A draft surface off the declared
    // app origin would point later scans at the wrong host.
    if (resolved.origin !== expectedOrigin) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

export interface InferInitOptions {
  // Whether the operator ran init with a storage state configured. That is the operator saying
  // this application is scanned signed in, which is the strongest sign init can read that it
  // needs a login. Absent means no session was configured.
  sessionConfigured?: boolean;
}

// Route path segments that name a sign-in, sign-out, or identity step. A naming convention, not
// proof, which is fine here: it only decides whether init prints a recommendation, and a
// recommendation on an application that needs no login costs the operator one line to ignore.
const SIGN_IN_SEGMENT = /^(login|log-in|logon|signin|sign-in|sign_in|logout|log-out|signout|sign-out|auth|sso)$/i;

function signInRoutePath(routes: readonly RouteEntry[]): string | null {
  for (const route of routes) {
    if (route.url.split('/').some((segment) => SIGN_IN_SEGMENT.test(segment))) {
      return route.url;
    }
  }
  return null;
}

/**
 * The readiness signal recommendation for a login-gated application.
 *
 * A scan whose session has died can be handed a sign-in page instead of the screen it asked for.
 * The session rules catch a refused data request, a password field, and a redirect to a page with a
 * password field. They do not catch a passkey prompt, a magic-link page, or an authentication wall
 * that answers 200 to everything: those are scored as the screen. Only a declared readiness signal
 * tells those apart, and only the operator knows what each screen shows, so init recommends one
 * for every screen and writes none itself. A guessed selector would be worse than none, because a
 * selector that a sign-in page also matches reads as proof the screen rendered.
 */
function readinessRecommendation(reason: string, surfaces: readonly SurfaceConfig[]): string[] {
  if (surfaces.length === 0) {
    return [];
  }
  return [
    `Review: this application looks login-gated (${reason}). Add a reachedWhen readiness signal to ` +
      'every surface: a selector for content only that screen has, such as its own table or heading, ' +
      'a response path for a data request only that screen makes, such as "/api/users", or both. ' +
      'Without one, a sign-in page with no password field and no refused request, such as a passkey ' +
      'or magic-link page, is scored as the screen.',
    ...surfaces.map(
      (surface) =>
        `Review: surface "${operatorText(surface.id)}" has no reachedWhen readiness signal yet.`,
    ),
  ];
}

export async function inferInit(fs: InitFs, options: InferInitOptions = {}): Promise<InitDraft> {
  const notes: string[] = [];
  // Vite's default origin when server.port is absent. Call it out as a review
  // note so the operator does not treat the fallback as a measured fact.
  let appBaseUrl = 'http://127.0.0.1:5173';
  let viteSource: string | null = null;
  for (const candidate of VITE_CONFIG_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw === null) {
      continue;
    }
    viteSource = candidate;
    const port = parseVitePort(raw);
    if (port !== null) {
      appBaseUrl = `http://127.0.0.1:${port}`;
      notes.push(`Inferred appBaseUrl from ${candidate} port ${port}.`);
    } else {
      notes.push(`Review: ${candidate} has no server.port; using ${appBaseUrl}.`);
    }
    break;
  }
  if (viteSource === null) {
    notes.push(`Review: no Vite config found; using ${appBaseUrl}.`);
  }

  let routerFile = '';
  let routerRaw: string | null = null;
  for (const candidate of ROUTER_CANDIDATES) {
    const raw = await fs.readFile(candidate);
    if (raw !== null && isRouterSource(raw)) {
      routerFile = candidate;
      routerRaw = raw;
      notes.push(`Inferred router file ${candidate}.`);
      break;
    }
  }
  if (routerFile.length === 0) {
    notes.push('Review: no router file found. Routes sidecar will be empty.');
  }

  const routes: RouteEntry[] = [];
  const unusable: UnusableId[] = [];
  if (routerRaw !== null) {
    const imports = parseLocalImports(routerRaw);
    const parsed = mergeParsedRoutes(parseRouteTags(routerRaw), parseDataRouterRoutes(routerRaw));
    if (routerRaw.includes('createBrowserRouter')) {
      notes.push('Review: data-router routes detected; verify entry file attribution.');
    }
    let attributed = 0;
    for (const route of parsed) {
      if (!isProvenRoutePath(route.path)) {
        notes.push(
          `Review: skipped unproven route path "${route.path}". Nested or relative paths are not attributed.`,
        );
        continue;
      }
      let entryFile: string | null = null;
      if (route.component !== null) {
        const specifier = imports.get(route.component);
        if (specifier !== undefined) {
          entryFile = await resolveEntryFile(fs, routerFile, specifier);
        }
      }
      // Ask the question the parser is going to ask, at the point the id is made. A route path
      // can hold a raw space, a joining character, or a blank glyph, and the derived id would
      // carry it, so writing that route would produce a sidecar usabl then refuses to read. The
      // route is not skipped either: a written sidecar takes precedence over router fallback and
      // the planner records no gap for a route that is not in it, so a sidecar without this route
      // would let a change to a shared entry file or a wide-blast file look fully checked while
      // the route is never scanned. Every such route is collected so the whole draft can be
      // refused at once. The route is named by file and line, never by its path, because the
      // path is what carries the refused character. The line comes from the offset the parser
      // recorded for the path literal it matched, so it is the line of that match and not the
      // first place the same text appears in the file. The parser does not strip comments, so a
      // commented-out route is matched like any other and the line can name a commented
      // declaration. The operator still gets the file and a line to open.
      const screenId = screenIdFromUrl(route.path);
      const refusal = validateId(screenId);
      if (!refusal.ok) {
        unusable.push({
          source: `${routerFile} line ${lineAtOffset(routerRaw, route.offset)}`,
          origin: 'the screen id derived from the route path there',
          refusal,
        });
        continue;
      }
      // Missing attribution stays null. Guessing an entry file would hide a
      // coverage gap behind a mapping we cannot prove.
      if (entryFile !== null) {
        attributed += 1;
      } else {
        notes.push(`Review: ${route.path} has no proven entry file.`);
      }
      routes.push({
        screenId,
        url: route.path,
        entryFile,
      });
    }
    notes.push(`Attributed ${attributed} of ${routes.length} routes to local entry files.`);
    if (routerRaw.includes('path="*"') || routerRaw.includes("path='*'")) {
      notes.push('Review: skipped catch-all route path="*".');
    }
  }

  // Refuse once every route has been seen, so one run shows the whole fix.
  if (unusable.length > 0) {
    throw unusableIdsError(APP_INIT_REFUSAL, unusable);
  }

  const srcTsx = await fs.glob(['src/**/*.tsx']);
  const uiFileGlobs = srcTsx.length > 0 ? ['src/**/*.tsx'] : [];
  const wideCandidates = [
    'src/main.tsx',
    'src/main.ts',
    'src/App.tsx',
    'src/App.jsx',
    'index.html',
    'vite.config.ts',
    'vite.config.js',
    ...(await fs.glob(['src/**/*.css'])),
  ];
  const wideBlastGlobs: string[] = [];
  for (const candidate of wideCandidates) {
    if ((await fs.readFile(candidate)) !== null && !wideBlastGlobs.includes(candidate)) {
      wideBlastGlobs.push(candidate);
    }
  }

  const origin = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`;
  const surfaces: SurfaceConfig[] = [];
  for (const route of routes) {
    const url = surfaceUrl(appBaseUrl, route.url);
    if (url === null) {
      notes.push(`Review: skipped surface URL for ${operatorText(route.url)}; it leaves ${origin}.`);
      continue;
    }
    // Every route here already passed the id grammar when its id was derived above, so a surface
    // taken from it is one the parser will accept.
    surfaces.push({
      id: route.screenId,
      url,
      files: route.entryFile === null ? [] : [route.entryFile],
      // Every surface here takes its id from a discovered route by construction, so the config has
      // to say the two are one screen. Without it the planner refuses the pair, because it cannot
      // tell an intended url override from two different screens and will not guess from the url.
      overridesDiscoveredRoute: true,
    });
  }

  const config: UsablConfig = {
    appBaseUrl,
    uiFileGlobs,
    discovery: {
      routerFile: routerFile.length > 0 ? routerFile : 'src/App.tsx',
      wideBlastGlobs,
    },
    surfaces,
    guardedPaths: [...ALWAYS_GUARDED],
  };

  const signInRoute = signInRoutePath(routes);
  const loginReason =
    options.sessionConfigured === true
      ? `${STORAGE_STATE_ENV_VAR} is set, so scans run signed in`
      : signInRoute === null
        ? null
        : `the router has a sign-in route, ${operatorText(signInRoute)}`;
  if (loginReason !== null) {
    notes.push(...readinessRecommendation(loginReason, surfaces));
  }

  notes.push('Review: these files are drafts. Merge only after you check routes, globs, and URLs.');

  return {
    config,
    // init authors the sidecar, so the manifest it hands back is a sidecar manifest.
    routes: { routes, source: 'sidecar' },
    notes,
  };
}

export async function writeInitDrafts(
  fs: InitFs,
  draft: InitDraft,
  opts: { force: boolean },
): Promise<WriteInitResult> {
  // Existing policy is operator-owned. Overwrite is explicit so init cannot
  // clobber a reviewed sidecar during a later re-run.
  const refused: string[] = [];
  if (!opts.force) {
    for (const path of POLICY_FILES) {
      if ((await fs.readFile(path)) !== null) {
        refused.push(path);
      }
    }
  }
  if (refused.length > 0) {
    return {
      ok: false,
      written: [],
      refused,
      message: `Refusing to overwrite ${refused.join(', ')} without --force.`,
    };
  }

  const written: string[] = [];
  await fs.writeFile('usabl.config.json', `${JSON.stringify(draft.config, null, 2)}\n`);
  written.push('usabl.config.json');
  await fs.writeFile('usabl.routes.json', `${JSON.stringify(draft.routes, null, 2)}\n`);
  written.push('usabl.routes.json');
  return {
    ok: true,
    written,
    refused: [],
    message: `Wrote ${written.join(', ')}.`,
  };
}

export function formatInitReport(draft: InitDraft, result: WriteInitResult): string {
  const lines = [result.message, ...draft.notes];
  return `${lines.join('\n')}\n`;
}
