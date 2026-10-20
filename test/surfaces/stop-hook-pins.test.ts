/**
 * Session pins on a shared machine, through the real Stop hook ports and the real filesystem.
 *
 * The hook keeps a fingerprint of every guarded policy file per session and per repository, and
 * compares it on each stop to catch a committed tamper. Those pins live under the system temp
 * directory, which other local users share. Each case here plants what another user could plant at
 * the place the hook keeps its pins, and checks that the hook refuses it with a plain message and
 * writes nothing.
 *
 * The cases find that place by running the hook once in an empty temp directory and looking at
 * what it wrote, so they hold the behaviour rather than one layout of file names.
 *
 * A file owned by another user cannot be made in a test without root, because a test cannot
 * chown. The hook's notion of the current user is injected instead: the test runs the hook as a
 * user id one higher than the real one, so everything the real user created reads as another
 * user's.
 */
import { lstat, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeStopHookRunnerPorts, runStopHookFromStdin } from '../../src/surfaces/stop-hook-runner.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const verified: Result = {
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
};

const REAL_UID = typeof process.getuid === 'function' ? process.getuid() : null;

let scratch = '';
let savedTmpdir: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'usabl-pin-test-'));
  savedTmpdir = process.env['TMPDIR'];
  // The hook asks the operating system for its temp directory on every stop, so this points it
  // at a directory only this test uses.
  process.env['TMPDIR'] = scratch;
});

afterEach(async () => {
  if (savedTmpdir === undefined) {
    delete process.env['TMPDIR'];
  } else {
    process.env['TMPDIR'] = savedTmpdir;
  }
  await rm(scratch, { recursive: true, force: true });
});

async function stop(sessionId: string, options: { uid?: number } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let engineRan = false;
  const ports = {
    ...makeStopHookRunnerPorts(options.uid === undefined ? {} : { uid: options.uid }),
    cwd: () => '/repo/one',
    stdoutWrite: async (text: string) => {
      stdout.push(text);
    },
    stderrWrite: async (text: string) => {
      stderr.push(text);
    },
    loadConfig: async () => config,
    buildDeps: async () => makeFakeDeps({ headContents: { 'usabl.config.json': 'committed config' } }),
    runEngine: async () => {
      engineRan = true;
      return verified;
    },
  };
  const exitCode = await runStopHookFromStdin(JSON.stringify({ session_id: sessionId, stop_hook_active: false }), ports);
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join(''), engineRan: () => engineRan };
}

/** Every pin file under the scratch temp directory, as full paths. */
async function pinFiles(): Promise<string[]> {
  const entries = await readdir(scratch, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Where the hook keeps the pins for one session, found by letting it write them once. */
async function pinPathFor(sessionId: string): Promise<string> {
  await stop(sessionId);
  const files = await pinFiles();
  expect(files).toHaveLength(1);
  return files[0] as string;
}

describe.skipIf(REAL_UID === null)('Stop hook session pins on a shared temp directory', () => {
  it('keeps pins private: the file is 0600 and its directory is 0700, both owned by this user', async () => {
    const path = await pinPathFor('session-private');
    const file = await lstat(path);
    expect(file.isFile()).toBe(true);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.uid).toBe(REAL_UID);
    const directory = await lstat(join(path, '..'));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(directory.uid).toBe(REAL_UID);
    // The directory is not the shared temp directory itself, and its name binds the user.
    expect(join(path, '..')).not.toBe(scratch);
    expect(join(path, '..')).toContain(String(REAL_UID));
  });

  it('refuses a symlink at the pin path and never writes through it', async () => {
    const path = await pinPathFor('session-link');
    const victim = join(scratch, 'victim.txt');
    await writeFile(victim, 'a file the victim can write\n');
    await unlink(path);
    await symlink(victim, path);

    const result = await stop('session-link');

    expect(result.exitCode).toBe(0);
    await expect(readFile(victim, 'utf8')).resolves.toBe('a file the victim can write\n');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(result.stderr).toContain('NOT verified');
    expect(result.stderr).toContain('symbolic link');
    // The stop still runs the check; it only goes without the drift comparison, and says so.
    expect(result.engineRan()).toBe(true);
  });

  it('refuses a precreated pin file other users can write, and neither reads nor replaces it', async () => {
    // Pin poisoning: another user plants pins that do not match the repository, so the next stop
    // reports drift that never happened, or plants matching pins to hide a later tamper.
    const path = await pinPathFor('session-planted');
    const planted = JSON.stringify({ 'usabl.config.json': 'planted digest' });
    await writeFile(path, planted);
    await chmod(path, 0o666);

    const result = await stop('session-planted');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('guarded policy drift');
    expect(result.stderr).not.toContain('guarded policy drift');
    expect(result.stderr).toContain('NOT verified');
    expect(result.stderr).toContain('other users');
    await expect(readFile(path, 'utf8')).resolves.toBe(planted);
    expect((await lstat(path)).mode & 0o777).toBe(0o666);
  });

  it('refuses a pin directory owned by another user and writes nothing in it', async () => {
    // The hook runs as a user id one higher than the real one, so the directory at its pin path,
    // which the real user owns, is another user's directory from where the hook stands. That is
    // what another local user precreating the victim's pin directory looks like.
    const first = await stop('session-owner', { uid: (REAL_UID as number) + 1 });
    const second = await stop('session-owner', { uid: (REAL_UID as number) + 1 });

    for (const result of [first, second]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('NOT verified');
      expect(result.stderr).toContain('another user');
      expect(result.engineRan()).toBe(true);
    }
    // No pin file was written anywhere under the temp directory.
    expect(await pinFiles()).toEqual([]);
  });

  it('still compares pins and reports real drift on an ordinary second stop', async () => {
    const path = await pinPathFor('session-drift');
    const recorded = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    expect(Object.keys(recorded)).toContain('usabl.config.json');

    // Rewrite the pins the way this user's own earlier stop would have, with a different digest,
    // keeping the private mode. The next stop sees the committed bytes differ from the pin.
    await writeFile(path, JSON.stringify({ ...recorded, 'usabl.config.json': 'an older digest' }));

    const result = await stop('session-drift');

    expect(result.stdout).toContain('guarded policy drift');
  });
});
