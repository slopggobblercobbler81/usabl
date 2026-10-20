/**
 * In-memory Deps so tests can run the whole engine without git, a browser, or a network.
 * Scripted maps are the only source of truth. `browser.open` never fetches the URL; it only
 * hands it back as the page's own address, so a fake page is always where it was sent.
 * Unused Page methods throw: a test that hits them is lying about coverage, not passing.
 */
import type { Deps, RequirementBundle, ScreenScan, Page } from '../contracts/index.js';
import { matchGlob } from '../primitives/match-glob.js';

export interface FakeDepsSpec {
  now: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  changed: Array<{ code: string; path: string }>;
  diffNames?: string[];
  files: Record<string, string>; // working-tree contents by path
  headContents: Record<string, string>; // HEAD contents by path (for git.show)
  refContents?: Record<string, Record<string, string>>; // other refs by path
  headBlobs: Record<string, string>; // blob shas by path (for git.lsTree / policyHash)
  writeTree: string; // git write-tree result
  headRef: string;
  scans: Record<string, ScreenScan>; // by screenId
  requirements?: RequirementBundle; // design-intake bundle for the docs surface
}

const DEFAULTS: FakeDepsSpec = {
  now: '2026-01-01T00:00:00.000Z',
  runnerVersion: '0.0.0-test',
  scannerVersions: { axeCore: '0.0.0', playwright: '0.0.0', chromium: '0.0.0' },
  changed: [],
  diffNames: [],
  files: {},
  headContents: {},
  headBlobs: {},
  writeTree: 'tree-0000',
  headRef: 'HEAD-0000',
  scans: {},
  requirements: { version: 1, requirements: [] },
};

const notUsed = (name: string) => async (): Promise<never> => {
  throw new Error(`fake Page.${name} not used in this test`);
};

export function makeFakePage(overrides: Partial<Page> = {}): Page {
  return {
    gotoReady: async () => {},
    // An empty address is "this fake cannot say where it is", which is the honest default for a
    // page that never navigated. Consumers must make no redirect claim from it. Fakes handed a
    // URL by browser.open report that URL instead.
    currentUrl: async () => '',
    // A fake page issues no requests, so it saw no refused one. Not a claim that a session worked.
    unauthorizedApiRequests: async () => [],
    // Nor any data response, so a declared readiness response is never seen on a fake by default.
    apiResponses: async () => [],
    // A fake page sends nothing, so there is nothing to date against the walk.
    markWalkStart: async () => {},
    // A fake page has no DOM to search, so nothing matches anywhere.
    countEverywhere: async () => 0,
    focusBody: async () => {},
    tab: async () => {},
    press: async () => {},
    click: async () => {},
    activeElementIs: async () => false,
    activeElementWithin: async () => false,
    armAnnouncementCapture: async () => {},
    drainAnnouncements: async () => [],
    activeNode: async () => null,
    activePath: async () => 'body',
    axAt: async () => null,
    getAttribute: async () => null,
    queryAll: async () => [],
    close: async () => {},
    setViewport: async () => {},
    setZoom: async () => {},
    setReducedMotion: async () => {},
    getComputedStyle: notUsed('getComputedStyle'),
    screenshot: notUsed('screenshot'),
    ...overrides,
  };
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

export function makeFakeDeps(overrides: Partial<FakeDepsSpec> = {}): Deps {
  const spec: FakeDepsSpec = { ...DEFAULTS, ...overrides };
  return {
    clock: () => spec.now,
    runnerVersion: spec.runnerVersion,
    scannerVersions: spec.scannerVersions,
    // Fakes never fetch the URL. They do report it back as the page's address, so a fake page
    // stands where it was sent and no test reads a redirect that never happened.
    browser: {
      open: async (url: string) => makeFakePage({ currentUrl: async () => url }),
      close: async () => {},
    },
    git: {
      writeTree: async () => spec.writeTree,
      show: async (ref, path) => (spec.refContents?.[ref] ?? spec.headContents)[path] ?? null,
      statusZ: async () => spec.changed,
      diffNameOnly: async () => spec.diffNames ?? [],
      lsTree: async (_ref, paths) => {
        const blobs: Array<[string, string]> = [];
        for (const path of paths) {
          const blob = spec.headBlobs[path];
          if (blob !== undefined) {
            blobs.push([path, blob]);
          }
        }
        return Object.fromEntries(blobs);
      },
      lsFiles: async (ref, prefix) => {
        const normalized = normalizePrefix(prefix);
        const childrenPrefix = normalized + '/';
        return Object.keys(spec.refContents?.[ref] ?? spec.headContents)
          .filter((path) => path === normalized || path.startsWith(childrenPrefix))
          .sort();
      },
      headRef: async () => spec.headRef,
    },
    fs: {
      readFile: async (path) => spec.files[path] ?? null,
      glob: async (patterns) => Object.keys(spec.files).filter((f) => patterns.some((p) => matchGlob(p, f))),
    },
    requirements: spec.requirements ?? { version: 1, requirements: [] },
    checkRunner: {
      scan: async ({ id, url }) =>
        spec.scans[id] ?? {
          screenId: id,
          url,
          stops: [],
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
          reachedWhenSelector: null,
        },
    },
  };
}
