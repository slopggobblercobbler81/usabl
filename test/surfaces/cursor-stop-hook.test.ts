/**
 * Cursor stop-hook protocol tests.
 * Cursor's stop event sends {"status":"...","loop_count":N} on stdin and expects
 * {"followup_message":"..."} to loop the agent, or {} to let it finish.
 * This is a different contract from Claude Code's {"decision":"block","reason":"..."}.
 * The --cursor flag on `npx usabl stop-hook` switches the output protocol.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { runStopHookFromStdin } from '../../src/surfaces/stop-hook-runner.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const configFixture: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: {
    changedFiles: [],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  ...over,
});

class MemoryRunnerFs {
  private readonly files = new Map<string, string>();
  readonly deleted: string[] = [];
  readonly writes: string[] = [];

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, contents);
  }

  async mkdir(_path: string): Promise<void> {}

  async unlink(path: string): Promise<void> {
    this.deleted.push(path);
    this.files.delete(path);
  }
}

function makePorts(overrides: {
  runEngine?: (deps: Deps, config: UsablConfig) => Promise<Result>;
} = {}) {
  const fs = new MemoryRunnerFs();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = makeFakeDeps();

  return {
    fs,
    stdout,
    stderr,
    ports: {
      fs,
      pins: memoryPinStore(),
      cwd: () => '/repo/one',
      stdoutWrite: async (text: string) => {
        stdout.push(text);
      },
      stderrWrite: async (text: string) => {
        stderr.push(text);
      },
      loadConfig: async () => configFixture,
      buildDeps: async (_config: UsablConfig) => deps,
      runEngine: overrides.runEngine ?? (async () => baseResult({ verdict: 'verified' })),
      evaluateDecision: evaluateStopDecision,
    },
  };
}

describe('Cursor stop-hook protocol (--cursor)', () => {
  it('emits empty object on verified (agent finishes normally)', async () => {
    const { ports, stdout, stderr } = makePorts();

    const exitCode = await runStopHookFromStdin('{}', ports, { cursorMode: true });

    expect(exitCode).toBe(0);
    const output = stdout.join('').trim();
    // Cursor mode always emits something on stdout so the hook protocol is satisfied.
    expect(output).toBe('{}');
    expect(stderr.join('')).toContain('verified');
  });

  it('emits followup_message on regression instead of decision: block', async () => {
    const { ports, stdout } = makePorts({
      runEngine: async () =>
        baseResult({
          verdict: 'regression',
          summary: 'regression: 1 new deterministic finding(s)',
          findings: [
            {
              rule: 'color-contrast',
              layer: 'axe',
              severity: 'serious',
              evidenceClass: 'deterministic',
              screenId: 'clusters',
              elementPath: 'button',
              elementName: 'Save',
              role: 'button',
              whatUserExperiences: 'Save button text is hard to read',
              why: 'contrast too low',
              fix: 'increase contrast',
              evidence: {},
              confidence: 'fail',
              elementKey: 'button-save',
              identityBasis: 'name',
              status: 'new',
            },
          ],
          exitCode: 1,
        }),
    });

    const exitCode = await runStopHookFromStdin('{}', ports, { cursorMode: true });

    expect(exitCode).toBe(0);
    const output = stdout.join('').trim();
    const payload = JSON.parse(output) as { followup_message?: string; decision?: string };
    // Cursor protocol: followup_message loops the agent.
    expect(payload.followup_message).toBeDefined();
    expect(typeof payload.followup_message).toBe('string');
    expect(payload.followup_message!.length).toBeGreaterThan(0);
    // Must NOT emit Claude's decision: block protocol.
    expect(payload.decision).toBeUndefined();
  });

  it('emits empty object on error (fail open with disclosure)', async () => {
    const { ports, stdout, stderr } = makePorts({
      runEngine: async () => {
        throw new Error('browser crashed');
      },
    });

    const exitCode = await runStopHookFromStdin('{}', ports, { cursorMode: true });

    expect(exitCode).toBe(0);
    const output = stdout.join('').trim();
    expect(output).toBe('{}');
    expect(stderr.join('')).toContain('NOT verified');
    expect(stderr.join('')).toContain('browser crashed');
  });

  it('emits empty object on nothing-to-check', async () => {
    const { ports, stdout } = makePorts({
      runEngine: async () =>
        baseResult({
          verdict: null,
          coverage: {
            changedFiles: [],
            affected: [],
            unresolvedFiles: [],
            gaps: [],
            nothingToCheck: true,
          },
        }),
    });

    const exitCode = await runStopHookFromStdin('{}', ports, { cursorMode: true });

    expect(exitCode).toBe(0);
    expect(stdout.join('').trim()).toBe('{}');
  });

  it('maps Cursor stdin loop_count > 0 to stopHookActive', async () => {
    const { ports, stdout, stderr } = makePorts({
      runEngine: async () =>
        baseResult({
          verdict: 'regression',
          summary: 'regression: still failing',
          exitCode: 1,
        }),
    });

    // loop_count > 0 means the agent already looped once, so stopHookActive is true.
    // This should NOT block (allows continuation to avoid recursive loops).
    const exitCode = await runStopHookFromStdin(
      JSON.stringify({ status: 'stop', loop_count: 1 }),
      ports,
      { cursorMode: true },
    );

    expect(exitCode).toBe(0);
    const output = stdout.join('').trim();
    // On continuation-active, Cursor mode emits empty object (allow), not followup_message.
    expect(output).toBe('{}');
    expect(stderr.join('')).toContain('continuation already active');
  });

  it('never emits decision: block regardless of the verdict', async () => {
    for (const verdict of ['regression', 'not_covered', 'approval_required'] as const) {
      const { ports, stdout } = makePorts({
        runEngine: async () =>
          baseResult({
            verdict,
            summary: `${verdict}: test`,
            exitCode: 1,
          }),
      });

      await runStopHookFromStdin('{}', ports, { cursorMode: true });

      const output = stdout.join('');
      expect(output).not.toContain('"decision"');
    }
  });
});
