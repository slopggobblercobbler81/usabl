/**
 * The filesystem store behind Stop hook session pins, on the real filesystem.
 *
 * Every refusal is checked for two things: the store says why in plain words, and nothing was
 * written. A file owned by another user cannot be made without root, so the owner the store reads
 * off a file is injected for that case.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeFsSessionPinStore,
  sessionPinDir,
  type FsSessionPinStoreOptions,
} from '../../src/surfaces/session-pin-store.js';

const REAL_UID = typeof process.getuid === 'function' ? process.getuid() : null;

let scratch = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'usabl-pin-store-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('sessionPinDir', () => {
  it('binds the user id into a directory under the temp directory', () => {
    expect(sessionPinDir('/tmp', 1000)).toBe('/tmp/usabl-pins-1000');
    expect(sessionPinDir('/tmp', 1001)).not.toBe(sessionPinDir('/tmp', 1000));
  });
});

describe.skipIf(REAL_UID === null)('makeFsSessionPinStore', () => {
  const uid = REAL_UID as number;
  const storeIn = (dir: string, over: Partial<FsSessionPinStoreOptions> = {}) =>
    makeFsSessionPinStore({ dir, uid, ...over });

  it('creates a 0700 directory and a 0600 file, then reads and replaces it', async () => {
    const dir = join(scratch, 'pins');
    const store = storeIn(dir);

    await expect(store.read('s.json')).resolves.toEqual({ status: 'missing' });
    await expect(store.create('s.json', '{"a":"1"}')).resolves.toEqual({ status: 'written' });
    await expect(store.read('s.json')).resolves.toEqual({ status: 'found', contents: '{"a":"1"}' });
    await expect(store.replace('s.json', '{"a":"2"}')).resolves.toEqual({ status: 'written' });
    await expect(store.read('s.json')).resolves.toEqual({ status: 'found', contents: '{"a":"2"}' });

    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dir, 's.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that appears between the read and the exclusive create, and leaves it alone', async () => {
    const dir = join(scratch, 'pins');
    const store = storeIn(dir);
    await expect(store.read('s.json')).resolves.toEqual({ status: 'missing' });
    await writeFile(join(dir, 's.json'), 'planted', { mode: 0o600 });

    const result = await store.create('s.json', '{"a":"1"}');

    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toContain('already exists');
    await expect(readFile(join(dir, 's.json'), 'utf8')).resolves.toBe('planted');
  });

  it('refuses a precreated file other users can read or write', async () => {
    const dir = join(scratch, 'pins');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 's.json'), '{"a":"planted"}');
    await chmod(join(dir, 's.json'), 0o644);
    const store = storeIn(dir);

    for (const result of [await store.read('s.json'), await store.replace('s.json', '{"a":"1"}')]) {
      expect(result.status).toBe('refused');
      expect(result.status === 'refused' && result.reason).toContain('other users');
    }
    await expect(readFile(join(dir, 's.json'), 'utf8')).resolves.toBe('{"a":"planted"}');
  });

  it('refuses a symlink at the pin path for every operation and never touches its target', async () => {
    const dir = join(scratch, 'pins');
    await mkdir(dir, { mode: 0o700 });
    const victim = join(scratch, 'victim.txt');
    await writeFile(victim, 'victim\n');
    await symlink(victim, join(dir, 's.json'));
    const store = storeIn(dir);

    for (const result of [
      await store.read('s.json'),
      await store.create('s.json', '{"a":"1"}'),
      await store.replace('s.json', '{"a":"1"}'),
    ]) {
      expect(result.status).toBe('refused');
      expect(result.status === 'refused' && result.reason).toContain('symbolic link');
    }
    await expect(readFile(victim, 'utf8')).resolves.toBe('victim\n');
  });

  it('refuses a pin file owned by another user and writes nothing', async () => {
    const dir = join(scratch, 'pins');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 's.json'), '{"a":"theirs"}', { mode: 0o600 });
    // The directory reads as this user's and the file as someone else's.
    const store = storeIn(dir, { ownerOf: (_stats, kind) => (kind === 'file' ? uid + 1 : uid) });

    for (const result of [await store.read('s.json'), await store.replace('s.json', '{"a":"1"}')]) {
      expect(result.status).toBe('refused');
      expect(result.status === 'refused' && result.reason).toContain('another user');
    }
    await expect(readFile(join(dir, 's.json'), 'utf8')).resolves.toBe('{"a":"theirs"}');
  });

  it('refuses a pin directory owned by another user and creates nothing in it', async () => {
    const dir = join(scratch, 'pins');
    const store = storeIn(dir, { uid: uid + 1 });

    for (const result of [await store.read('s.json'), await store.create('s.json', '{"a":"1"}')]) {
      expect(result.status).toBe('refused');
      expect(result.status === 'refused' && result.reason).toContain('another user');
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a pin directory that is a symlink, and writes nothing where it points', async () => {
    const elsewhere = join(scratch, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    const dir = join(scratch, 'pins');
    await symlink(elsewhere, dir);
    const store = storeIn(dir);

    const result = await store.create('s.json', '{"a":"1"}');

    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toContain('symbolic link');
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses a pin directory other users can write', async () => {
    const dir = join(scratch, 'pins');
    await mkdir(dir);
    await chmod(dir, 0o777);
    const store = storeIn(dir);

    const result = await store.create('s.json', '{"a":"1"}');

    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toContain('other users');
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a name that would leave the pin directory', async () => {
    const dir = join(scratch, 'pins');
    const store = storeIn(dir);

    const result = await store.create('../escape.json', '{"a":"1"}');

    expect(result.status).toBe('refused');
    await expect(readFile(join(scratch, 'escape.json'), 'utf8')).rejects.toThrow();
  });
});
