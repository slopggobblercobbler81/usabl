/**
 * Coverage planning maps changed UI files to affected screens and explicit gaps.
 * It feeds the gate with evidence only. It must never mint or imply a verdict.
 * `run()` calls this planner directly, so unmapped UI must stay explicit evidence.
 * Unmapped UI becomes a written gap so the gate can return not_covered.
 */
import type { AffectedScreen, Coverage, CoverageGap, FsGlob, UsablConfig } from '../contracts/index.js';
import { loadAliasConfig } from './alias-config.js';
import { buildUnresolvedReason } from './discovery-diagnostics.js';
import { buildImportGraph, inspectDirectImports } from './import-graph.js';
import { parseRouteManifest, type RouteEntry, type RouteManifest } from './route-manifest.js';
import { parseDocsManifest, type DocsManifest } from './docs-manifest.js';
import { assertSurfaceIds } from '../intake/surface-ids.js';
import { configError } from '../intake/config-error.js';
import { matchGlob } from '../primitives/match-glob.js';

function isWideBlastFile(file: string, globs: string[]): boolean {
  return globs.some((glob) => matchGlob(glob, file));
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)/u.test(file) || /\.(test|spec)\.[^/]+$/u.test(file);
}

function routeUrl(baseUrl: string, routePath: string): string {
  const joinBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const expectedOrigin = new URL(baseUrl).origin;
  const resolved = new URL(routePath, joinBaseUrl);
  // Route paths must remain on the operator app origin. A sidecar entry that
  // changes origin would mint dishonest scan targets outside declared scope.
  if (resolved.origin !== expectedOrigin) {
    throw configError`route url must stay on app origin: ${routePath}`;
  }
  return resolved.toString();
}

function addAffected(target: Map<string, AffectedScreen>, candidate: AffectedScreen): void {
  if (!target.has(candidate.screenId)) {
    target.set(candidate.screenId, candidate);
  }
}

function hasAffectedUrl(target: Map<string, AffectedScreen>, url: string): boolean {
  return [...target.values()].some((screen) => screen.url === url);
}

function manualUrlOverride(config: UsablConfig, file: string, screenId: string): string | null {
  for (const surface of config.surfaces) {
    if (surface.id === screenId && surface.files.includes(file)) {
      return surface.url;
    }
  }
  return null;
}

/**
 * Refuses any screen id that could stand for more than one screen.
 *
 * Three sources mint screen ids and all three land in the same identity space: operator surfaces,
 * discovered routes, and docs manifest pages. App coverage and docs coverage are concatenated by
 * the caller, and downstream the id alone keys floor identity, finding identity, waiver matching,
 * applicability, and source lookup. So one id shared by two screens does not merely drop a screen
 * from the scan. It also lets a floor entry belonging to one screen absorb a genuinely new barrier
 * on the other, which reads as carried debt and mints a verified receipt over a real failure.
 * Each source checks itself for duplicates. Nothing checked across them until here.
 *
 * A surface and a discovered route may share an id, because that is how a surface overrides the
 * scan url for a screen discovery already owns. usabl does not try to work out whether a given
 * pair is that override or two different screens. It cannot: a url does not determine a screen.
 * Applications select screens by query, fragment, trailing slash, and userinfo, servers do not
 * treat percent spellings as interchangeable, and a redirect can send two requests for one url to
 * two different screens depending on session, server state, or time. Even exact string equality
 * proves only that the same address was requested. So the config declares the relationship with
 * `overridesDiscoveredRoute` and nothing is inferred from the url at all.
 *
 * No such declaration exists for docs pages, because a docs page is never an alias for an app
 * screen, so any overlap involving a docs page is refused outright.
 */
function assertScreenIdsAreUnambiguous(
  config: UsablConfig,
  manifest: RouteManifest,
  docsPageIds: string[],
): void {
  const routeById = new Map<string, RouteEntry>();
  for (const route of manifest.routes) {
    if (!routeById.has(route.screenId)) {
      routeById.set(route.screenId, route);
    }
  }

  config.surfaces.forEach((surface, index) => {
    const route = routeById.get(surface.id);

    if (route !== undefined && surface.overridesDiscoveredRoute !== true) {
      throw configError`surfaces[${index}].id "${surface.id}" is also the screen id of the discovered route "${route.url}". usabl tracks coverage by screen id, so one of the two would never be scanned and the run would still report both as covered. If this surface is that same screen, add "overridesDiscoveredRoute": true to it. If it is a different screen, give it a different id. usabl does not compare the two urls, because a url does not determine which screen renders.`;
    }

    // A declaration that overrides nothing reads as wired up while the surface stands alone, so
    // the intended url override never applies. Only an authored sidecar lists routes completely
    // enough to prove an id is absent from it. Router-text discovery is documented as recovering
    // paths but not ownership, and 'none' is also what the trust overlay leaves behind when it
    // suppresses a diverged manifest, so absence proves nothing in either of those and saying so
    // would throw away the findings of a run that could still report honestly.
    if (route === undefined && surface.overridesDiscoveredRoute === true && manifest.source === 'sidecar') {
      throw configError`surfaces[${index}] sets overridesDiscoveredRoute, but usabl.routes.json has no route with the screen id "${surface.id}", so the declaration overrides nothing and this surface url will not be used for a discovered screen. Correct the id to the route you meant, or remove the declaration.`;
    }
  });

  // Docs pages share the identity space with both other sources and have no override relationship
  // with either, so any overlap is two screens under one id.
  const surfaceIds = new Set(config.surfaces.map((surface) => surface.id));
  for (const pageId of docsPageIds) {
    if (surfaceIds.has(pageId)) {
      throw configError`usabl.docs.json has a page with the id "${pageId}", which is also a surfaces[].id in usabl.config.json. A docs page and an app screen are never the same screen, and usabl keys coverage, floor identity, and waivers by that id alone, so one would absorb the other's findings. Rename one of them.`;
    }
    if (routeById.has(pageId)) {
      throw configError`usabl.docs.json has a page with the id "${pageId}", which is also the screen id of a discovered route. A docs page and an app screen are never the same screen, and usabl keys coverage, floor identity, and waivers by that id alone, so one would absorb the other's findings. Rename the docs page, or rename the route.`;
    }
  }
}

function importClosure(graph: { get(file: string): string[] }, entryFile: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== 'string' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of graph.get(current)) {
      queue.push(next);
    }
  }
  return seen;
}

export async function computeCoverage(
  fs: FsGlob,
  config: UsablConfig,
  changedFiles: string[],
  preloadedDocsManifest?: DocsManifest | null,
): Promise<Coverage> {
  assertSurfaceIds(config.surfaces);

  const manifest = await parseRouteManifest(fs, config.discovery);
  const docsManifest = preloadedDocsManifest !== undefined ? preloadedDocsManifest : await parseDocsManifest(fs);
  assertScreenIdsAreUnambiguous(config, manifest, (docsManifest?.pages ?? []).map((page) => page.pageId));

  const uiFiles = changedFiles.filter(
    (file) => !isTestFile(file) && config.uiFileGlobs.some((glob) => matchGlob(glob, file)),
  );
  // No UI-touching files means idle. That is not the same claim as "covered".
  if (uiFiles.length === 0) {
    return { changedFiles, affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true };
  }
  const affectedByScreen = new Map<string, AffectedScreen>();
  const unresolvedFiles: string[] = [];
  const gaps: CoverageGap[] = [];

  const hasWideBlast = uiFiles.some((file) => isWideBlastFile(file, config.discovery.wideBlastGlobs));
  let wideBlastAttributedAnyScreen = false;
  if (hasWideBlast) {
    // A shell or global file can influence any route, so queue every discovered
    // route instead of pretending we can prove a single-screen blast radius.
    const affectedCountBeforeWideBlast = affectedByScreen.size;
    for (const route of manifest.routes) {
      addAffected(affectedByScreen, {
        screenId: route.screenId,
        url: routeUrl(config.appBaseUrl, route.url),
        provenance: 'wide-blast',
      });
    }
    wideBlastAttributedAnyScreen = affectedByScreen.size > affectedCountBeforeWideBlast;
    // The router fallback can find a route whose path yields no valid screen id. Wide blast would
    // have queued that route, so leaving it out in silence would report the blast as covered
    // while one discovered screen was never opened. It is written down as a gap instead, with
    // the position and code point of the refused character and never the id itself, and the
    // gate reads it as not covered. The route url is the ref, as a file path is for other gaps.
    for (const route of manifest.unusable ?? []) {
      gaps.push({
        ref: route.url,
        state: 'skipped',
        reason: `${route.reason} Name this route in usabl.routes.json with a visible screen id, or change the route path.`,
      });
    }
  }

  const attributedRoutes = manifest.routes.filter(
    // Regex fallback routes have entryFile: null, so they cannot truthfully
    // participate in route-graph closure matching.
    (route): route is { screenId: string; url: string; entryFile: string } => route.entryFile !== null,
  );
  const routeEntries = [...new Set(attributedRoutes.map((route) => route.entryFile))];
  const aliasConfig = await loadAliasConfig(fs);
  const graph = await buildImportGraph(fs, routeEntries, aliasConfig);
  // Graph unresolvable entries are diagnostics about discovery fidelity.
  // They are not coverage gaps unless a changed UI file maps to no screen.
  const routeClosures = new Map<string, Set<string>>();
  for (const route of attributedRoutes) {
    routeClosures.set(route.screenId, importClosure(graph, route.entryFile));
  }

  for (const file of uiFiles) {
    const isWideBlastMatch = isWideBlastFile(file, config.discovery.wideBlastGlobs);
    // Wide-blast already covered discovered routes for this file, so per-file
    // route-graph matching adds no new evidence.
    // Manual surfaces are still additive because operators can declare URLs that
    // discovery did not find and those URLs still need scans.
    // An empty route list is not coverage evidence, so this branch only applies
    // when wide-blast actually attributed at least one discovered route.
    if (isWideBlastMatch && wideBlastAttributedAnyScreen) {
      for (const surface of config.surfaces) {
        if (!surface.files.includes(file) || hasAffectedUrl(affectedByScreen, surface.url)) {
          continue;
        }
        addAffected(affectedByScreen, {
          screenId: surface.id,
          url: surface.url,
          provenance: 'manual',
        });
      }
      continue;
    }

    let mapped = false;
    for (const route of attributedRoutes) {
      const closure = routeClosures.get(route.screenId);
      if (closure === undefined || !closure.has(file)) {
        continue;
      }
      mapped = true;
      // Route graph decides affected screen identity. Manual surfaces may still
      // override that screen's scan URL so query variants remain operator-controlled.
      const url = manualUrlOverride(config, file, route.screenId) ?? routeUrl(config.appBaseUrl, route.url);
      addAffected(affectedByScreen, {
        screenId: route.screenId,
        url,
        provenance: 'route-graph',
        importChain: [route.entryFile, file],
      });
    }

    if (mapped) {
      continue;
    }

    let manualMatch = false;
    // Manual surfaces are additive fallback after discovery. They can rescue
    // known files, but they never replace route discovery or hide unmapped UI.
    for (const surface of config.surfaces) {
      if (!surface.files.includes(file)) {
        continue;
      }
      manualMatch = true;
      addAffected(affectedByScreen, {
        screenId: surface.id,
        url: surface.url,
        provenance: 'manual',
      });
    }

    if (!manualMatch) {
      // A changed UI file with no route-graph, wide-blast, or manual mapping is a
      // real coverage gap. Silent empties would let the gate misread this as safe.
      unresolvedFiles.push(file);
      const directDiagnostics = await inspectDirectImports(fs, file, aliasConfig);
      const combinedUnresolvable = [...graph.unresolvable, ...directDiagnostics];
      gaps.push({
        ref: file,
        state: 'unresolved',
        reason: buildUnresolvedReason(file, combinedUnresolvable, graph.visited),
      });
    }
  }

  return {
    changedFiles,
    affected: [...affectedByScreen.values()],
    unresolvedFiles,
    gaps,
    nothingToCheck: false,
  };
}
