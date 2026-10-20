import { describe, it, expect } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { Draft, RuleApplicability, ScreenScan, UsablConfig } from '../src/contracts/index.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
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
  whatUserExperiences: '',
  why: '',
  fix: '',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};
const scanWith = (drafts: Draft[], gaps: ScreenScan['gaps'] = []): ScreenScan => ({
  screenId: 'clusters',
  url: config.surfaces[0]!.url,
  stops: [],
  drafts,
  gaps,
  applicability: [],
  reachedSelectorPresent: null,
});
const guardOk = { files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' } };

describe('run', () => {
  it('is idle (verdict null, exit 0) when no UI files changed', async () => {
    const deps = makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'README.md' }] });
    const r = await run(deps, config);
    expect(r.verdict).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.coverage.nothingToCheck).toBe(true);
  });

  it('verifies and mints a receipt when an affected surface is clean', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      writeTree: 'tree-1',
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([]) },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('verified');
    expect(r.receipt?.sourceTree).toBe('tree-1');
    expect(r.exitCode).toBe(0);
  });

  it('regresses (exit 1) and mints no receipt on a new failure', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([failDraft]) },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('regression');
    expect(r.receipt).toBeNull();
    expect(r.exitCode).toBe(1);
  });

  it('is not_covered (exit 3) when a UI file maps to no surface', async () => {
    const deps = makeFakeDeps({ ...guardOk, changed: [{ code: 'M', path: 'fixtures/app/src/Orphan.tsx' }], scans: {} });
    const r = await run(deps, config);
    expect(r.verdict).toBe('not_covered');
    expect(r.coverage.unresolvedFiles).toContain('fixtures/app/src/Orphan.tsx');
    expect(r.exitCode).toBe(3);
  });

  it('is not_covered (exit 3) when the scan returns coverage gaps', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: {
        clusters: scanWith([], [{ ref: config.surfaces[0]!.url, state: 'not-covered', reason: 'screen failed to open: timeout' }]),
      },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('not_covered');
    expect(r.coverage.gaps).toEqual([
      { ref: config.surfaces[0]!.url, state: 'not-covered', reason: 'screen failed to open: timeout' },
    ]);
    expect(r.exitCode).toBe(3);
  });

  it('carries applicability to the Result without moving any verdict', async () => {
    // Applicability is recorded, never judged. Every other field of the Result has to come
    // out byte-identical whether or not the scan reported which rules applied.
    const applicability: RuleApplicability[] = [
      { screenId: 'clusters', layer: 'axe', rule: 'video-caption', outcome: 'inapplicable', elementCount: 0 },
      { screenId: 'clusters', layer: 'axe', rule: 'html-has-lang', outcome: 'passed', elementCount: 1 },
      { screenId: 'clusters', layer: 'axe', rule: 'color-contrast', outcome: 'failed', elementCount: 1 },
    ];
    const depsFor = (drafts: Draft[], entries?: RuleApplicability[]) =>
      makeFakeDeps({
        ...guardOk,
        writeTree: 'tree-1',
        changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
        scans: {
          clusters: entries === undefined ? scanWith(drafts) : { ...scanWith(drafts), applicability: entries },
        },
      });

    for (const drafts of [[], [failDraft]]) {
      const without = await run(depsFor(drafts), config);
      const withEntries = await run(depsFor(drafts, applicability), config);

      // Applicability moves no verdict. Every field except the screens and the receipt is
      // byte-identical whether or not the scan reported which rules applied. The receipt is
      // excluded here because it records applicability by design (proved in the next test); it
      // is compared separately so this assertion stays about the verdict, not the record.
      expect({ ...withEntries, screens: [], receipt: null }).toEqual({
        ...without,
        screens: [],
        receipt: null,
      });
      expect(withEntries.screens[0]?.applicability).toEqual(applicability);
      expect(without.screens[0]?.applicability).toEqual([]);
    }
  });

  it('records the applicability summary in a verified receipt, and nothing else in it moves', async () => {
    // Decision-of-record for applicability: the receipt states what was examined, so a verified
    // receipt records not only what was found but what was checked. It is informational, so it
    // changes no verdict and is never re-verified.
    const applicability: RuleApplicability[] = [
      { screenId: 'clusters', layer: 'axe', rule: 'video-caption', outcome: 'inapplicable', elementCount: 0 },
      { screenId: 'clusters', layer: 'axe', rule: 'html-has-lang', outcome: 'passed', elementCount: 1 },
      { screenId: 'clusters', layer: 'axe', rule: 'color-contrast', outcome: 'passed', elementCount: 3 },
    ];
    const depsFor = (entries?: RuleApplicability[]) =>
      makeFakeDeps({
        ...guardOk,
        writeTree: 'tree-1',
        changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
        scans: {
          clusters: entries === undefined ? scanWith([]) : { ...scanWith([]), applicability: entries },
        },
      });

    const withEntries = await run(depsFor(applicability), config);
    const without = await run(depsFor(), config);

    // A clean run mints a receipt; it records what was examined: two rules applied, one abstained.
    expect(withEntries.verdict).toBe('verified');
    expect(withEntries.receipt?.applicability).toEqual([{ screenId: 'clusters', applied: 2, abstained: 1 }]);
    // With no applicability reported, the screen carries no examined/abstained claim, so the
    // receipt omits it rather than record 0/0.
    expect(without.receipt?.applicability).toEqual([]);
    // Only the applicability record differs; the rest of the receipt is identical.
    expect({ ...withEntries.receipt, applicability: null }).toEqual({ ...without.receipt, applicability: null });
  });

  it('is approval_required (exit 2) when a guarded path diverged', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"tampered":true}' },
      headContents: { 'usabl.config.json': '{}' },
      changed: [{ code: 'M', path: 'usabl.config.json' }],
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('approval_required');
    expect(r.dirtyGuardedPaths).toEqual(['usabl.config.json']);
    expect(r.exitCode).toBe(2);
    expect(r.accessibilityVerdict).toBeNull();
    expect(r.accessibilityExitCode).toBe(0);
    expect(r.coverage.nothingToCheck).toBe(true);
  });

  it('scans affected UI when policy diverged and keeps accessibility as regression', async () => {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"tampered":true}' },
      headContents: { 'usabl.config.json': '{}' },
      changed: [
        { code: 'M', path: 'usabl.config.json' },
        { code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' },
      ],
      scans: { clusters: scanWith([failDraft]) },
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('approval_required');
    expect(r.exitCode).toBe(2);
    expect(r.receipt).toBeNull();
    expect(r.accessibilityVerdict).toBe('regression');
    expect(r.accessibilityExitCode).toBe(1);
    expect(r.findings.some((finding) => finding.rule === 'color-contrast')).toBe(true);
  });

  it('lists every dirty guarded path when config and evidence both changed', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"tampered":true}',
        '.usabl-evidence.json': '{"version":1,"entries":[]}',
      },
      headContents: {
        'usabl.config.json': '{}',
        '.usabl-evidence.json': '{"version":1,"entries":[{"screenId":"x","layer":"axe","rule":"r","elementKey":null,"identityBasis":"count","count":1}]}',
      },
      changed: [
        { code: 'M', path: 'usabl.config.json' },
        { code: 'M', path: '.usabl-evidence.json' },
      ],
    });
    const r = await run(deps, config);
    expect(r.verdict).toBe('approval_required');
    expect(r.dirtyGuardedPaths).toEqual(['.usabl-evidence.json', 'usabl.config.json']);
  });

  it('scans using trusted-ref config URLs when working-tree config diverged', async () => {
    const goodConfigJson = JSON.stringify({
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['fixtures/app/src/**'],
      discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
      surfaces: [
        { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] },
      ],
      guardedPaths: ['usabl.config.json'],
    });
    const evilConfig = {
      ...config,
      appBaseUrl: 'http://evil.test',
      surfaces: [{ id: 'clusters', url: 'http://evil.test/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
    };
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': '{"appBaseUrl":"http://evil.test"}' },
      headContents: { 'usabl.config.json': goodConfigJson },
      refContents: { 'origin/main': { 'usabl.config.json': goodConfigJson } },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([failDraft]) },
    });
    const r = await run(deps, evilConfig, { trustedRef: 'origin/main' });
    expect(r.verdict).toBe('approval_required');
    expect(r.screens[0]?.url).toBe('http://127.0.0.1:5173/clusters');
    expect(r.accessibilityVerdict).toBe('regression');
  });

  it('marks fixed and counts pay-down only for a cleanly scanned screen, never a gapped one', async () => {
    // Floor has one barrier per screen. This run has two screens: clusters scans cleanly with no
    // barrier (so its floored barrier is resolved), but settings gapped (browser failed). A gapped
    // screen produces no drafts, so an absent barrier there is unproven, not resolved. The gate must
    // mark only the clusters barrier 'fixed' and must NOT emit a 'fixed' for the settings barrier,
    // because that would be a false claim about a screen this run did not measure, and it would reach
    // both Result.findings and the receipt findingsSummary.
    const configWithTwoScreens: UsablConfig = {
      ...config,
      surfaces: [
        { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] },
        { id: 'settings', url: 'http://127.0.0.1:5173/settings', files: ['fixtures/app/src/SettingsPage.tsx'] },
      ],
    };
    const deps = makeFakeDeps({
      ...guardOk,
      files: {
        'usabl.config.json': '{}',
        '.usabl-evidence.json': JSON.stringify({
          version: 1,
          entries: [
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
            {
              screenId: 'settings',
              layer: 'axe',
              rule: 'aria-input-field-name',
              elementKey: 'settings|aria-input-field-name|name:search',
              identityBasis: 'name',
              count: 1,
            },
          ],
        }),
      },
      headContents: {
        'usabl.config.json': '{}',
        '.usabl-evidence.json': JSON.stringify({
          version: 1,
          entries: [
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
            {
              screenId: 'settings',
              layer: 'axe',
              rule: 'aria-input-field-name',
              elementKey: 'settings|aria-input-field-name|name:search',
              identityBasis: 'name',
              count: 1,
            },
          ],
        }),
      },
      changed: [
        { code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' },
        { code: 'M', path: 'fixtures/app/src/SettingsPage.tsx' },
      ],
      scans: {
        clusters: {
          screenId: 'clusters',
          url: 'http://127.0.0.1:5173/clusters',
          stops: [],
          drafts: [],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
        settings: {
          screenId: 'settings',
          url: 'http://127.0.0.1:5173/settings',
          stops: [],
          drafts: [],
          gaps: [{ ref: 'http://127.0.0.1:5173/settings', state: 'not-covered', reason: 'browser failed to load' }],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    });
    const r = await run(deps, configWithTwoScreens);
    // Verify both screens were scanned: clusters cleanly, settings with a gap.
    expect(r.screens).toHaveLength(2);
    const clustersScreen = r.screens.find((s) => s.screenId === 'clusters');
    const settingsScreen = r.screens.find((s) => s.screenId === 'settings');
    expect(clustersScreen).toBeDefined();
    expect(settingsScreen).toBeDefined();
    expect(clustersScreen!.gaps).toHaveLength(0);
    expect(settingsScreen!.gaps).toHaveLength(1);
    // The gate marks only the cleanly scanned screen's barrier 'fixed'. The gapped screen's barrier
    // is omitted entirely: no claim is made about a screen that was not measured.
    const fixedFindings = r.findings.filter((f) => f.status === 'fixed');
    expect(fixedFindings).toHaveLength(1);
    expect(fixedFindings[0]!.screenId).toBe('clusters');
    expect(fixedFindings.some((f) => f.screenId === 'settings')).toBe(false);
    // No false 'fixed' reaches the Result findings for the unmeasured screen.
    expect(r.findings.some((f) => f.status === 'fixed' && f.screenId === 'settings')).toBe(false);
    // paidDownCount counts the one confirmed pay-down on the cleanly scanned screen.
    expect(r.paidDownCount).toBe(1);
  });

  it('never writes a fixed for an out-of-scope screen into the Result or the receipt', async () => {
    // The receipt is the proof artifact, so this is the security-critical case. Only ClustersPage
    // changed, so only clusters is in scope and scanned clean with its barrier gone. The floor also
    // carries a barrier on settings, a screen this run never scanned because nothing routed to it.
    // The old gate emitted a 'fixed' for settings anyway, which reached both Result.findings and the
    // receipt findingsSummary. It must now be omitted: no claim about a screen we did not measure.
    // Version 2 so the floor's name-basis entries carry real observed counts and do not raise the
    // version-1 stale-floor coverage gap, which would make the run not_covered and mint no receipt.
    const floorJson = JSON.stringify({
      version: 2,
      entries: [
        {
          screenId: 'clusters',
          layer: 'axe',
          rule: 'color-contrast',
          elementKey: 'clusters|color-contrast|name:save',
          identityBasis: 'name',
          count: 1,
        },
        {
          screenId: 'settings',
          layer: 'axe',
          rule: 'aria-input-field-name',
          elementKey: 'settings|aria-input-field-name|name:search',
          identityBasis: 'name',
          count: 1,
        },
      ],
    });
    const deps = makeFakeDeps({
      ...guardOk,
      writeTree: 'tree-164',
      files: { 'usabl.config.json': '{}', '.usabl-evidence.json': floorJson },
      headContents: { 'usabl.config.json': '{}', '.usabl-evidence.json': floorJson },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([], []) },
    });
    const r = await run(deps, config);

    // The run verified over the one clean in-scope screen and minted a receipt.
    expect(r.verdict).toBe('verified');
    expect(r.receipt).not.toBeNull();

    // Result findings: exactly one fixed, on clusters. Nothing about settings.
    const fixed = r.findings.filter((f) => f.status === 'fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]!.screenId).toBe('clusters');
    expect(r.findings.some((f) => f.screenId === 'settings')).toBe(false);

    // Receipt findingsSummary: the fixed tally is 1, not 2. No false pay-down is recorded as proof.
    expect(r.receipt!.findingsSummary.fixed).toBe(1);
    expect(r.paidDownCount).toBe(1);
  });

  it('counts a resolved barrier on a cleanly scanned screen in paidDownCount', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      files: {
        'usabl.config.json': '{}',
        '.usabl-evidence.json': JSON.stringify({
          version: 1,
          entries: [
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ],
        }),
      },
      headContents: {
        'usabl.config.json': '{}',
        '.usabl-evidence.json': JSON.stringify({
          version: 1,
          entries: [
            {
              screenId: 'clusters',
              layer: 'axe',
              rule: 'color-contrast',
              elementKey: 'clusters|color-contrast|name:save',
              identityBasis: 'name',
              count: 1,
            },
          ],
        }),
      },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: { clusters: scanWith([], []) },
    });
    const r = await run(deps, config);
    expect(r.findings.filter((f) => f.status === 'fixed')).toHaveLength(1);
    expect(r.paidDownCount).toBe(1);
  });

  it('surfaces loadRequirements failure reason as a coverage gap', async () => {
    const deps = makeFakeDeps({
      ...guardOk,
      files: {
        'usabl.config.json': JSON.stringify({ ...config, requirements: 'requirements' }),
      },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    });
    const r = await run(deps, { ...config, requirements: 'requirements' });
    expect(r.coverage.gaps.some((g) => g.reason.includes('requirements directory had no yaml files'))).toBe(true);
  });
});
