/**
 * Where the Stop hook keeps session pins, and how it reads and writes them safely.
 *
 * Pins live under the system temp directory, which on a multi-user host every local user shares.
 * A name there is predictable, so another user can get to the path first: precreate a file with
 * pins of their choosing, or put a symlink there that points at a file the victim can write. The
 * old layout followed whatever was at the path and wrote with the process umask, so pins were
 * usually readable by everyone. That allowed false drift blocks, persistent pin poisoning, a
 * trust check that a later tamper could slip past, and an overwrite of another file.
 *
 * What this store does instead:
 *
 *   - Every pin file lives in one directory per user, named with the user id, created with mode
 *     0700. Before any read or write the directory is checked with lstat: it must be a real
 *     directory, not a symlink, owned by this user, with no permission bits for group or others.
 *   - A pin file is created exclusively (O_CREAT with O_EXCL) with mode 0600, so a file that is
 *     already there is never adopted as ours.
 *   - A pin file is opened with O_NOFOLLOW, so a symlink at the path is refused rather than
 *     followed. Where the platform has no O_NOFOLLOW, an lstat check runs first instead.
 *   - An opened pin file is checked with fstat on the open handle: a regular file, owned by this
 *     user, with no permission bits for group or others. Checking the handle rather than the path
 *     means the file that passed the check is the file that is read or written.
 *
 * Any failed check refuses the operation with a plain reason and writes nothing. The caller
 * decides what a refusal means for the stop; it must never treat one as "no pins yet", because
 * that is what would let a planted file be adopted.
 *
 * What this does not cover. Windows reports no user id, so there the directory carries no id and
 * the owner checks are skipped; the per-user temp directory Windows gives each account is what
 * keeps it private. The checks also assume the temp directory itself only lets an entry's owner
 * remove or rename it, which the sticky bit on /tmp provides; a temp directory without that lets
 * another user replace the pin directory between the check and the open.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type PinReadResult =
  | { status: 'missing' }
  | { status: 'found'; contents: string }
  | { status: 'refused'; reason: string };

export type PinWriteResult = { status: 'written' } | { status: 'refused'; reason: string };

/**
 * Session pin storage. Names are bare file names inside the store's own directory; a name that
 * would leave it is refused.
 */
export interface SessionPinStore {
  read(name: string): Promise<PinReadResult>;
  // Writes a new pin file. Refuses if anything is already at the name.
  create(name: string, contents: string): Promise<PinWriteResult>;
  // Overwrites an existing pin file that passes every check. Refuses if there is none.
  replace(name: string, contents: string): Promise<PinWriteResult>;
}

export interface FsSessionPinStoreOptions {
  // The per-user directory, from sessionPinDir.
  dir: string;
  // The user the pins belong to. Null where the platform reports no user id.
  uid: number | null;
  // The owner read off a directory or a file. Injected only by tests: a test cannot chown, so it
  // cannot otherwise produce a file owned by another user. Absent means the owner the operating
  // system reports.
  ownerOf?: (stats: Stats, kind: 'directory' | 'file') => number;
}

/** The current user id, or null where the platform reports none. */
export function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** The per-user pin directory under a temp directory. The user id is part of the name. */
export function sessionPinDir(tmpDirPath: string, uid: number | null): string {
  return join(tmpDirPath, uid === null ? 'usabl-pins' : `usabl-pins-${uid}`);
}

// Any permission bit for group or others. A pin directory or file with one of these set can be
// read or changed by someone other than its owner.
const SHARED_BITS = 0o077;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
// Zero where the platform has no such flag, which turns the open into an ordinary one; the lstat
// check before every open covers that case.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

// ELOOP is what Linux and macOS report for O_NOFOLLOW on a symlink; some BSDs report EMLINK.
function isSymlinkRefusal(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ELOOP' || code === 'EMLINK';
}

function refused(reason: string): { status: 'refused'; reason: string } {
  return { status: 'refused', reason };
}

export function makeFsSessionPinStore(options: FsSessionPinStoreOptions): SessionPinStore {
  const ownerOf = options.ownerOf ?? ((stats: Stats) => stats.uid);
  const dir = options.dir;

  /** Null when the directory is private to this user, or the reason it is not. */
  async function checkDirectory(): Promise<string | null> {
    try {
      await mkdir(dir, { mode: PRIVATE_DIR_MODE });
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        return `the session pin directory ${dir} could not be created`;
      }
    }
    let stats: Stats;
    try {
      stats = await lstat(dir);
    } catch {
      return `the session pin directory ${dir} could not be read`;
    }
    if (stats.isSymbolicLink()) {
      return `the session pin directory ${dir} is a symbolic link`;
    }
    if (!stats.isDirectory()) {
      return `the session pin directory ${dir} is not a directory`;
    }
    if (options.uid !== null && ownerOf(stats, 'directory') !== options.uid) {
      return `the session pin directory ${dir} is owned by another user`;
    }
    if ((stats.mode & SHARED_BITS) !== 0) {
      return `the session pin directory ${dir} can be read or changed by other users`;
    }
    return null;
  }

  /** Null when the opened file is private to this user, or the reason it is not. */
  function checkFile(stats: Stats): string | null {
    if (!stats.isFile()) {
      return 'the session pin file is not a regular file';
    }
    if (options.uid !== null && ownerOf(stats, 'file') !== options.uid) {
      return 'the session pin file is owned by another user';
    }
    if ((stats.mode & SHARED_BITS) !== 0) {
      return 'the session pin file can be read or changed by other users';
    }
    return null;
  }

  /** The full path for a bare name, or null when the name would leave the directory. */
  function pathFor(name: string): string | null {
    if (name.length === 0 || name === '.' || name === '..' || basename(name) !== name) {
      return null;
    }
    return join(dir, name);
  }

  /**
   * Null when nothing is at the path or a regular entry is, or the reason to refuse. Runs before
   * every open, so a symlink is refused on a platform with no O_NOFOLLOW too.
   */
  async function refuseLink(path: string): Promise<string | null> {
    try {
      const stats = await lstat(path);
      return stats.isSymbolicLink() ? 'the session pin file is a symbolic link' : null;
    } catch {
      return null;
    }
  }

  async function prepare(name: string): Promise<{ path: string } | { reason: string }> {
    const path = pathFor(name);
    if (path === null) {
      return { reason: 'the session pin file name would leave the pin directory' };
    }
    const directoryProblem = await checkDirectory();
    if (directoryProblem !== null) {
      return { reason: directoryProblem };
    }
    const linkProblem = await refuseLink(path);
    if (linkProblem !== null) {
      return { reason: linkProblem };
    }
    return { path };
  }

  async function withFile<T>(
    handle: FileHandle,
    use: (handle: FileHandle) => Promise<T>,
  ): Promise<T | { status: 'refused'; reason: string }> {
    try {
      const problem = checkFile(await handle.stat());
      if (problem !== null) {
        return refused(problem);
      }
      return await use(handle);
    } finally {
      await handle.close();
    }
  }

  return {
    async read(name) {
      const prepared = await prepare(name);
      if ('reason' in prepared) {
        return refused(prepared.reason);
      }
      let handle: FileHandle;
      try {
        handle = await open(prepared.path, constants.O_RDONLY | NO_FOLLOW);
      } catch (err) {
        if (errorCode(err) === 'ENOENT') {
          return { status: 'missing' };
        }
        if (isSymlinkRefusal(err)) {
          return refused('the session pin file is a symbolic link');
        }
        return refused('the session pin file could not be opened');
      }
      return withFile(handle, async (opened) => ({
        status: 'found' as const,
        contents: await opened.readFile({ encoding: 'utf8' }),
      }));
    },

    async create(name, contents) {
      const prepared = await prepare(name);
      if ('reason' in prepared) {
        return refused(prepared.reason);
      }
      let handle: FileHandle;
      try {
        handle = await open(
          prepared.path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          PRIVATE_FILE_MODE,
        );
      } catch (err) {
        // O_EXCL also fails on a symlink at the path, which is the case the lstat above missed
        // only if the link appeared after it.
        if (errorCode(err) === 'EEXIST') {
          return refused('a session pin file already exists where usabl was about to create one');
        }
        if (isSymlinkRefusal(err)) {
          return refused('the session pin file is a symbolic link');
        }
        return refused('the session pin file could not be created');
      }
      return withFile(handle, async (opened) => {
        await opened.writeFile(contents, { encoding: 'utf8' });
        return { status: 'written' as const };
      });
    },

    async replace(name, contents) {
      const prepared = await prepare(name);
      if ('reason' in prepared) {
        return refused(prepared.reason);
      }
      let handle: FileHandle;
      try {
        // No O_CREAT and no O_TRUNC: the file must already exist, and nothing is cut until the
        // handle has passed its checks.
        handle = await open(prepared.path, constants.O_WRONLY | NO_FOLLOW);
      } catch (err) {
        if (isSymlinkRefusal(err)) {
          return refused('the session pin file is a symbolic link');
        }
        if (errorCode(err) === 'ENOENT') {
          return refused('the session pin file disappeared before usabl could update it');
        }
        return refused('the session pin file could not be opened');
      }
      return withFile(handle, async (opened) => {
        await opened.truncate(0);
        await opened.write(contents, 0, 'utf8');
        return { status: 'written' as const };
      });
    },
  };
}
