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
 *   - A write never changes a pin file in place. The new contents go to a temp file in the same
 *     directory, created the same way, and the temp file is then renamed over the pin file (or,
 *     for a first pin, linked to its name, which fails if anything is there). A process killed
 *     part way leaves the old pin file whole, never an empty one.
 *
 * Where the directory is. On Linux with systemd, XDG_RUNTIME_DIR names a directory the system
 * creates for each user at login, owned by that user with mode 0700. When it is set, absolute,
 * and passes the same lstat checks, pins go in `usabl-pins` inside it, where no other user can
 * create anything first. Otherwise they go in `usabl-pins-<uid>` under the temp directory.
 *
 * Any failed check refuses the operation with a plain reason and a fix, and writes nothing. The
 * caller decides what a refusal means for the stop; it must never treat one as "no pins yet",
 * because that is what would let a planted file be adopted.
 *
 * What this does not cover. Windows reports no user id, so there the directory carries no id and
 * the owner and mode checks are skipped: Windows reports modes such as 0o666 that say nothing
 * about who can read a file. The per-user temp directory Windows gives each account is what keeps
 * it private. The checks also assume the temp directory itself only lets an entry's owner remove
 * or rename it, which the sticky bit on /tmp provides; a temp directory without that lets another
 * user replace the pin directory between the check and the open.
 */
import { randomBytes } from 'node:crypto';
import { constants, lstatSync, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

// Why the store would not use a pin location, and what the user can do so pins work again.
export interface PinRefusal {
  status: 'refused';
  reason: string;
  fix: string;
}

export type PinReadResult = { status: 'missing' } | { status: 'found'; contents: string } | PinRefusal;

export type PinWriteResult = { status: 'written' } | PinRefusal;

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
  // Where a name is kept, for a message that tells the user what to delete. Touches nothing.
  locate(name: string): string;
}

export interface FsSessionPinStoreOptions {
  // The per-user directory, from resolveSessionPinDir.
  dir: string;
  // The user the pins belong to. Null where the platform reports no user id.
  uid: number | null;
  // The owner read off a directory or a file. Injected only by tests: a test cannot chown, so it
  // cannot otherwise produce a file owned by another user. Absent means the owner the operating
  // system reports.
  ownerOf?: (stats: Stats, kind: 'directory' | 'file') => number;
  // Runs after the new contents are written and before they are put in place. Injected only by
  // tests, to stand for a process killed at that point.
  beforeCommit?: () => Promise<void>;
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

/**
 * The fix for a pin file that cannot be used. Deleting it resets the session baseline: the next
 * stop records new pins, with no other message. That is the same reset any process running as this
 * user can make, which is why pins are best-effort against an agent with a shell.
 */
export function deletePinFileFix(path: string): string {
  return `delete ${path}. The next stop records new pins for this session.`;
}

export interface ResolveSessionPinDirOptions {
  env: Record<string, string | undefined>;
  tmpDir: string;
  uid: number | null;
  // The owner read off XDG_RUNTIME_DIR. Injected only by tests, as for the store.
  ownerOf?: (stats: Stats) => number;
}

/**
 * The pin directory to use: `usabl-pins` inside XDG_RUNTIME_DIR when that is a private directory
 * of this user, otherwise `usabl-pins-<uid>` under the temp directory.
 *
 * XDG_RUNTIME_DIR is used only when it is set, absolute, and passes the same lstat checks as the
 * pin directory: a real directory, not a symlink, owned by this user, with no permission bits for
 * group or others. A host can set it to a directory that fails them, such as one root owns with
 * mode 0755, and then the temp directory is used instead. Where the platform reports no user id
 * the owner cannot be checked, so the temp directory is always used.
 */
export function resolveSessionPinDir(options: ResolveSessionPinDirOptions): string {
  const fallback = sessionPinDir(options.tmpDir, options.uid);
  const runtime = options.env['XDG_RUNTIME_DIR'];
  if (options.uid === null || runtime === undefined || runtime.length === 0 || !isAbsolute(runtime)) {
    return fallback;
  }
  let stats: Stats;
  try {
    stats = lstatSync(runtime);
  } catch {
    return fallback;
  }
  const ownerOf = options.ownerOf ?? ((s: Stats) => s.uid);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    ownerOf(stats) !== options.uid ||
    (stats.mode & SHARED_BITS) !== 0
  ) {
    return fallback;
  }
  return join(runtime, 'usabl-pins');
}
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

export function makeFsSessionPinStore(options: FsSessionPinStoreOptions): SessionPinStore {
  const ownerOf = options.ownerOf ?? ((stats: Stats) => stats.uid);
  const dir = options.dir;
  // Owner and mode checks run only where the platform reports a user id. Without one, as on
  // Windows, mode bits say nothing about who can read a file.
  const checkOwnership = options.uid !== null;

  // The fixes. Removing the directory or a file resets the baseline: the next stop records new
  // pins. That is the same reset a user gets by deleting the file, so it hides nothing new.
  const removeDir = `remove ${dir} (ask an administrator if another user owns it). usabl creates it again on the next stop.`;
  const fixParent = `make sure ${dirname(dir)} exists and you can write to it.`;

  function refused(reason: string, fix: string): PinRefusal {
    return { status: 'refused', reason, fix };
  }

  /** Null when the directory is private to this user, or why it is not. */
  async function checkDirectory(): Promise<PinRefusal | null> {
    try {
      await mkdir(dir, { mode: PRIVATE_DIR_MODE });
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        return refused(`the session pin directory ${dir} could not be created`, fixParent);
      }
    }
    let stats: Stats;
    try {
      stats = await lstat(dir);
    } catch {
      return refused(`the session pin directory ${dir} could not be read`, fixParent);
    }
    if (stats.isSymbolicLink()) {
      return refused(`the session pin directory ${dir} is a symbolic link`, removeDir);
    }
    if (!stats.isDirectory()) {
      return refused(`the session pin directory ${dir} is not a directory`, removeDir);
    }
    if (checkOwnership && ownerOf(stats, 'directory') !== options.uid) {
      return refused(`the session pin directory ${dir} is owned by another user`, removeDir);
    }
    if (checkOwnership && (stats.mode & SHARED_BITS) !== 0) {
      return refused(`the session pin directory ${dir} can be read or changed by other users`, removeDir);
    }
    return null;
  }

  /** Null when the opened file is private to this user, or why it is not. */
  function checkFile(stats: Stats, path: string): PinRefusal | null {
    if (!stats.isFile()) {
      return refused('the session pin file is not a regular file', deletePinFileFix(path));
    }
    if (checkOwnership && ownerOf(stats, 'file') !== options.uid) {
      return refused('the session pin file is owned by another user', deletePinFileFix(path));
    }
    if (checkOwnership && (stats.mode & SHARED_BITS) !== 0) {
      return refused('the session pin file can be read or changed by other users', deletePinFileFix(path));
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
  async function refuseLink(path: string): Promise<PinRefusal | null> {
    try {
      const stats = await lstat(path);
      return stats.isSymbolicLink() ? refused('the session pin file is a symbolic link', deletePinFileFix(path)) : null;
    } catch {
      return null;
    }
  }

  async function prepare(name: string): Promise<{ path: string } | PinRefusal> {
    const path = pathFor(name);
    if (path === null) {
      // Session ids are checked before they reach the store, so this means a bug in usabl.
      return refused(
        'the session pin file name would leave the pin directory',
        'report this as a usabl bug. Nothing needs to be removed.',
      );
    }
    const directoryProblem = await checkDirectory();
    if (directoryProblem !== null) {
      return directoryProblem;
    }
    const linkProblem = await refuseLink(path);
    if (linkProblem !== null) {
      return linkProblem;
    }
    return { path };
  }

  async function withFile<T>(
    handle: FileHandle,
    path: string,
    use: (handle: FileHandle) => Promise<T>,
  ): Promise<T | PinRefusal> {
    try {
      const problem = checkFile(await handle.stat(), path);
      if (problem !== null) {
        return problem;
      }
      return await use(handle);
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes the contents to a new temp file in the pin directory and hands its path to `commit`,
   * which puts it in place. The temp file is created the same way as a pin file, exclusively with
   * mode 0600 and no symlink following, and it is removed if anything fails before the commit.
   */
  async function writeThenCommit(
    path: string,
    contents: string,
    commit: (tempPath: string) => Promise<PinWriteResult>,
  ): Promise<PinWriteResult> {
    const tempPath = join(dir, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
    const notWritten = refused(
      'the new session pins could not be written',
      `make sure you can write to ${dir} and that the disk is not full.`,
    );
    let handle: FileHandle;
    try {
      handle = await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE,
      );
    } catch {
      return notWritten;
    }
    try {
      const written = await withFile(handle, tempPath, async (opened) => {
        await opened.writeFile(contents, { encoding: 'utf8' });
        await opened.sync();
        return null;
      });
      if (written !== null) {
        return written;
      }
      if (options.beforeCommit !== undefined) {
        await options.beforeCommit();
      }
      return await commit(tempPath);
    } catch {
      return notWritten;
    } finally {
      // After a rename the temp name is already gone. After a link it is a second name for the
      // pin file, and after a failure it is a stray file; both are removed.
      await unlink(tempPath).catch(() => undefined);
    }
  }

  return {
    locate(name) {
      return pathFor(name) ?? join(dir, basename(name));
    },

    async read(name) {
      const prepared = await prepare(name);
      if (!('path' in prepared)) {
        return prepared;
      }
      let handle: FileHandle;
      try {
        handle = await open(prepared.path, constants.O_RDONLY | NO_FOLLOW);
      } catch (err) {
        if (errorCode(err) === 'ENOENT') {
          return { status: 'missing' };
        }
        if (isSymlinkRefusal(err)) {
          return refused('the session pin file is a symbolic link', deletePinFileFix(prepared.path));
        }
        return refused('the session pin file could not be opened', deletePinFileFix(prepared.path));
      }
      return withFile(handle, prepared.path, async (opened) => ({
        status: 'found' as const,
        contents: await opened.readFile({ encoding: 'utf8' }),
      }));
    },

    async create(name, contents) {
      const prepared = await prepare(name);
      if (!('path' in prepared)) {
        return prepared;
      }
      const path = prepared.path;
      return writeThenCommit(path, contents, async (tempPath) => {
        try {
          // A hard link fails if anything is at the name, a symlink included, so a file that is
          // already there is never adopted, and the pin file appears with all its contents.
          await link(tempPath, path);
        } catch (err) {
          if (errorCode(err) === 'EEXIST') {
            return refused('a session pin file already exists where usabl was about to create one', deletePinFileFix(path));
          }
          throw err;
        }
        return { status: 'written' };
      });
    },

    async replace(name, contents) {
      const prepared = await prepare(name);
      if (!('path' in prepared)) {
        return prepared;
      }
      const path = prepared.path;
      // The pin file being replaced must still pass every check, so a planted file is refused
      // rather than quietly swapped out.
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
      } catch (err) {
        if (isSymlinkRefusal(err)) {
          return refused('the session pin file is a symbolic link', deletePinFileFix(path));
        }
        if (errorCode(err) === 'ENOENT') {
          return refused(
            'the session pin file disappeared before usabl could update it',
            'nothing. The next stop records new pins for this session.',
          );
        }
        return refused('the session pin file could not be opened', deletePinFileFix(path));
      }
      const problem = await withFile(handle, path, async () => null);
      if (problem !== null) {
        return problem;
      }
      return writeThenCommit(path, contents, async (tempPath) => {
        // rename replaces the name in one step and never follows a symlink at the target.
        await rename(tempPath, path);
        return { status: 'written' };
      });
    },
  };
}
