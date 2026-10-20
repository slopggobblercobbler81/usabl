import { describe, expect, it } from 'vitest';
import type { Draft, EvidenceFloor, ScreenScan, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { run } from '../src/run.js';
import { evaluateStopDecision } from '../src/surfaces/stop-hook.js';
import { runStopHookFromStdin } from '../src/surfaces/stop-hook-runner.js';
import { memoryPinStore } from './support/memory-pin-store.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const configBytes = JSON.stringify(config);
const emptyFloor = JSON.stringify({ version: 1, entries: [] });
const emptyWaivers = JSON.stringify({ version: 1, waivers: [] });
const emptyRoutes = JSON.stringify({ routes: [] });
const corrupt = '{not-json';

const cleanScan: ScreenScan = {
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts: [],
  gaps: [],
  applicability: [],
  reachedSelectorPresent: null,
};

const failDraft: Draft = {
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button',
  elementName: 'Save',
  role: 'button',
  whatUserExperiences: 'Save is hard to read',
  why: 'contrast too low',
  fix: 'Increase contrast',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};

const selfAcceptFloor: EvidenceFloor = {
  version: 1,
  entries: [
    {
      screenId: 'clusters',
      layer: 'axe',
      rule: 'color-contrast',
      elementKey: 'button-save',
      identityBasis: 'name',
      count: 1,
    },
  ],
};

function policyFiles(overrides: {
  files?: Record<string, string>;
  headContents?: Record<string, string>;
}): { files: Record<string, string>; headContents: Record<string, string> } {
  const base = {
    'usabl.config.json': configBytes,
    'usabl.routes.json': emptyRoutes,
    '.usabl-evidence.json': emptyFloor,
    '.usabl-waivers.json': emptyWaivers,
  };
  return {
    files: { ...base, ...overrides.files },
    headContents: { ...base, ...overrides.headContents },
  };
}

describe('run refuses to crash-open on corrupt guarded policy', () => {
  it('is approval_required (exit 2) when working-tree usabl.routes.json is corrupt', async () => {
    const deps = makeFakeDeps({
      ...policyFiles({ files: { 'usabl.routes.json': corrupt } }),
      writeTree: 'tree-routes',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.receipt).toBeNull();
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.dirtyGuardedPaths).toContain('usabl.routes.json');
  });

  it('is approval_required (exit 2) when working-tree .usabl-evidence.json is corrupt', async () => {
    const deps = makeFakeDeps({
      ...policyFiles({ files: { '.usabl-evidence.json': corrupt } }),
      writeTree: 'tree-evidence',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.receipt).toBeNull();
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.dirtyGuardedPaths).toContain('.usabl-evidence.json');
  });

  it('is approval_required (exit 2) when working-tree .usabl-waivers.json is corrupt', async () => {
    const deps = makeFakeDeps({
      ...policyFiles({ files: { '.usabl-waivers.json': corrupt } }),
      writeTree: 'tree-waivers',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });

    const result = await run(deps, config);

    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.receipt).toBeNull();
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.dirtyGuardedPaths).toContain('.usabl-waivers.json');
  });

  it('cannot mint verified from a corrupt floor committed at the trusted ref', async () => {
    const deps = makeFakeDeps({
      ...policyFiles({
        files: { '.usabl-evidence.json': JSON.stringify(selfAcceptFloor) },
        headContents: { '.usabl-evidence.json': corrupt },
      }),
      writeTree: 'tree-trusted-corrupt',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: { ...cleanScan, drafts: [failDraft] } },
    });

    const result = await run(deps, config, { trustedRef: 'HEAD' });

    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.receipt).toBeNull();
    expect(result.dirtyGuardedPaths).toContain('.usabl-evidence.json');
  });
});

describe('Stop hook blocks corrupt guarded policy', () => {
  it('emits a block decision when run() returns approval_required for corrupt routes', async () => {
    const deps = makeFakeDeps({
      ...policyFiles({ files: { 'usabl.routes.json': corrupt } }),
      writeTree: 'tree-stop-routes',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: cleanScan },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runStopHookFromStdin('{}', {
      fs: {
        readFile: async () => null,
        writeFile: async () => {},
        mkdir: async () => {},
        unlink: async () => {},
      },
      pins: memoryPinStore(),
      cwd: () => '/repo/one',
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      loadConfig: async () => config,
      buildDeps: async () => deps,
      runEngine: async (engineDeps, engineConfig) => run(engineDeps, engineConfig),
      evaluateDecision: evaluateStopDecision,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.join('').trim()) as { decision: string; reason: string };
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('approval required');
    expect(stderr.join('')).not.toContain('NOT verified - error during run');
  });
});
