#!/usr/bin/env node
/**
 * Stop-hook runner for Claude Code and Cursor protocol integration.
 * This unit projects existing trust signals and prints protocol output only.
 * It must never block via exit code or mint a verdict outside the gate.
 *
 * Two output protocols:
 *   Claude Code (default): {"decision":"block","reason":"..."} on stdout to block.
 *   Cursor (--cursor):     {"followup_message":"..."} on stdout to loop the agent,
 *                          {} to allow it to finish. Cursor's stop event receives
 *                          {"status":"...","loop_count":N} on stdin; loop_count > 0
 *                          maps to stopHookActive to prevent recursive loops.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Deps, Result, UsablConfig } from '../contracts/index.js';
import { buildDeps } from '../deps/build.js';
import { verifyReceipt } from '../evidence/receipt.js';
import { run } from '../run.js';
import { checkGuard, computeSessionPins, diffSessionPins, type SessionPins } from '../trust/guard.js';
import { loadConfig } from '../cli.js';
import { evaluateStopDecision, type HookContext } from './stop-hook.js';
import { BYPASS_ONCE_PATH, loadReceipt, saveReceipt, type ReceiptFs } from './receipt-store.js';
import {
  currentUid,
  deletePinFileFix,
  makeFsSessionPinStore,
  resolveSessionPinDir,
  type SessionPinStore,
} from './session-pin-store.js';

export interface StopHookInput {
  stopHookActive: boolean;
  sessionId: string | null;
}

export interface StopHookRunnerFs extends ReceiptFs {
  unlink(path: string): Promise<void>;
}

export interface StopHookRunnerPorts {
  fs: StopHookRunnerFs;
  // Where session pins are kept. The real one is private to the user; see session-pin-store.ts.
  pins: SessionPinStore;
  cwd: () => string;
  stdoutWrite: (text: string) => Promise<void> | void;
  stderrWrite: (text: string) => Promise<void> | void;
  loadConfig: () => Promise<UsablConfig>;
  buildDeps: (config: UsablConfig) => Promise<Deps>;
  runEngine: (deps: Deps, config: UsablConfig) => Promise<Result>;
  evaluateDecision: (result: Result, ctx: HookContext, config?: UsablConfig) => { block: boolean; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStopHookInput(raw: unknown): StopHookInput {
  if (!isRecord(raw)) {
    return { stopHookActive: false, sessionId: null };
  }
  const stopHookActive = raw['stop_hook_active'] === true;
  const sessionIdRaw = raw['session_id'];
  const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null;
  return { stopHookActive, sessionId };
}

function isSessionPins(value: unknown): value is SessionPins {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Pin file name for one session in one repository, inside the user's pin directory.
 *
 * The key includes the repository because the hook runs in the session's current working
 * directory, and that directory moves when the assistant changes directories. A session
 * that stops in a demo app and then in a second app would otherwise compare the second
 * app's guarded digests against pins written from the first, and report guarded policy
 * drift that never happened. The repository key is the first 16 hex characters of the
 * SHA-256 of the resolved working directory. Config is loaded from that directory, so it
 * is the repository root by construction.
 *
 * The user is bound by the directory, which only that user can use: see resolveSessionPinDir
 * in session-pin-store.ts.
 *
 * Pure: it derives a name and touches no filesystem.
 */
export function sessionPinFileName(sessionId: string, cwd: string): string {
  const repoKey = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return `${sessionId}-${repoKey}.json`;
}

function parseSessionId(raw: string | null): { sessionId: string | null; warning: string | null } {
  if (raw === null) {
    return { sessionId: null, warning: null };
  }
  const candidate = raw.trim();
  const safePattern = /^[A-Za-z0-9._-]{1,128}$/;
  if (!safePattern.test(candidate) || candidate.includes('..')) {
    return {
      sessionId: null,
      warning: `NOT verified - ignored unsafe session_id: ${JSON.stringify(raw)}.`,
    };
  }
  return { sessionId: candidate, warning: null };
}

async function writeStderr(ports: StopHookRunnerPorts, text: string): Promise<void> {
  await ports.stderrWrite(text.endsWith('\n') ? text : `${text}\n`);
}

async function writePinNotice(ports: StopHookRunnerPorts, notice: PinNotice | null): Promise<void> {
  if (notice !== null) {
    await writeStderr(ports, notice.message);
  }
}

// Cursor stdin carries loop_count so we can detect re-entry. Claude stdin carries
// stop_hook_active as a boolean. This parser reads both shapes into the shared input type.
function parseCursorStopInput(raw: unknown): StopHookInput {
  if (!isRecord(raw)) {
    return { stopHookActive: false, sessionId: null };
  }
  // Cursor sends loop_count as an integer. Values above 0 mean the agent already looped,
  // which maps to stopHookActive to prevent recursive block-loop cycles.
  const loopCount = raw['loop_count'];
  const stopHookActive = typeof loopCount === 'number' && loopCount > 0;
  // Cursor does not send session_id today. If it does later, the same parse applies.
  const sessionIdRaw = raw['conversation_id'] ?? raw['session_id'];
  const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null;
  return { stopHookActive, sessionId };
}

async function emitBlock(ports: StopHookRunnerPorts, reason: string): Promise<void> {
  // Claude Code only blocks when stdout receives a decision object, so exit codes stay non-blocking.
  await ports.stdoutWrite(JSON.stringify({ decision: 'block', reason }) + '\n');
}

async function emitCursorBlock(ports: StopHookRunnerPorts, reason: string): Promise<void> {
  // Cursor's stop hook loops the agent by receiving a followup_message. The message becomes
  // additional context for the agent's next turn, telling it what failed and why.
  await ports.stdoutWrite(JSON.stringify({ followup_message: reason }) + '\n');
}

async function emitCursorAllow(ports: StopHookRunnerPorts): Promise<void> {
  // An empty object lets the agent finish. Cursor requires valid JSON on stdout.
  await ports.stdoutWrite('{}\n');
}

async function consumeBypassOnce(fs: StopHookRunnerFs): Promise<boolean> {
  const bypass = await fs.readFile(BYPASS_ONCE_PATH);
  if (bypass === null) {
    return false;
  }
  await fs.unlink(BYPASS_ONCE_PATH);
  return true;
}

function parseSessionPins(raw: string): SessionPins | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSessionPins(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// What the operator reads when session pins were not used or not recorded on a stop. The stop goes
// on rather than blocking: a block here would trap the session behind a file another user may
// control, which is the fail-open decision the threat model records for a wedged hook. It is never
// silent. It is written after the decision line, so stderr never ends on a line that reads as a
// pass, and it always ends with what to change so pins work again.
interface PinNotice {
  // False when this stop did not compare pins, so the decision line must say so.
  driftChecked: boolean;
  message: string;
}

function pinsNotUsed(reason: string, fix: string): PinNotice {
  return {
    driftChecked: false,
    message:
      `NOT verified - usabl did not use session pins for this stop because ${reason}. ` +
      'Guarded policy drift during this session was not checked. usabl changed nothing there. ' +
      `To fix: ${fix}`,
  };
}

function pinsNotRecorded(reason: string, fix: string, driftChecked: boolean): PinNotice {
  const consequence = driftChecked
    ? 'usabl checked guarded policy drift on this stop, but the next stop compares against the older pins.'
    : 'Guarded policy drift during this session cannot be checked until pins are recorded.';
  return {
    driftChecked,
    message: `NOT verified - usabl could not record session pins for this stop because ${reason}. ${consequence} To fix: ${fix}`,
  };
}

async function verifyStoredReceipt(
  ports: StopHookRunnerPorts,
  deps: Deps,
  config: UsablConfig,
): Promise<{ verified: boolean; details: string }> {
  const receipt = await loadReceipt(ports.fs);
  if (receipt === null) {
    return { verified: false, details: 'no local receipt found' };
  }

  // Fast-path verification reuses the same verifier as run() so trust rules cannot diverge.
  const currentSourceTree = await deps.git.writeTree();
  const verification = await verifyReceipt(deps, config, receipt, currentSourceTree);
  if (verification.valid) {
    return { verified: true, details: `verified receipt sourceTree ${receipt.sourceTree}` };
  }
  return {
    verified: false,
    details: `receipt mismatch in ${verification.failedFields.join(', ') || 'unknown field'}`,
  };
}

function defaultFs(): StopHookRunnerFs {
  return {
    readFile: async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },
    writeFile: async (path: string, contents: string) => {
      await writeFile(path, contents, 'utf8');
    },
    mkdir: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    unlink: async (path: string) => {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    },
  };
}

export interface StopHookRunnerPortOptions {
  // The user the session pins belong to. Absent means the user this process runs as. Tests set
  // it to another id, because a test cannot chown a file to make it another user's.
  uid?: number | null;
  // Where XDG_RUNTIME_DIR is read from. Absent means the process environment. Tests inject one
  // so a host setting never moves the pins they inspect.
  env?: Record<string, string | undefined>;
}

export function makeStopHookRunnerPorts(options: StopHookRunnerPortOptions = {}): StopHookRunnerPorts {
  const uid = options.uid === undefined ? currentUid() : options.uid;
  const dir = resolveSessionPinDir({ env: options.env ?? process.env, tmpDir: tmpdir(), uid });
  return {
    fs: defaultFs(),
    pins: makeFsSessionPinStore({ dir, uid }),
    cwd: () => process.cwd(),
    stdoutWrite: async (text: string) => {
      process.stdout.write(text);
    },
    stderrWrite: async (text: string) => {
      process.stderr.write(text);
    },
    loadConfig: async () => loadConfig(),
    buildDeps: async (config: UsablConfig) => buildDeps(config),
    runEngine: async (deps: Deps, config: UsablConfig) => run(deps, config),
    evaluateDecision: evaluateStopDecision,
  };
}

export interface StopHookOptions {
  cursorMode: boolean;
}

const DEFAULT_OPTIONS: StopHookOptions = { cursorMode: false };

// Protocol-aware block emitter. Claude uses decision: block, Cursor uses followup_message.
async function emitProtocolBlock(ports: StopHookRunnerPorts, reason: string, options: StopHookOptions): Promise<void> {
  if (options.cursorMode) {
    await emitCursorBlock(ports, reason);
  } else {
    await emitBlock(ports, reason);
  }
}

// Protocol-aware allow emitter. Claude emits nothing to stdout (stderr only).
// Cursor must emit {} so the hook protocol response is valid JSON.
async function emitProtocolAllow(ports: StopHookRunnerPorts, message: string, options: StopHookOptions): Promise<void> {
  await writeStderr(ports, message);
  if (options.cursorMode) {
    await emitCursorAllow(ports);
  }
}

export async function runStopHook(
  input: StopHookInput,
  ports: StopHookRunnerPorts,
  options: StopHookOptions = DEFAULT_OPTIONS,
): Promise<number> {
  let deps: Deps | null = null;
  let pinNotice: PinNotice | null = null;
  try {
    if (await consumeBypassOnce(ports.fs)) {
      // One-shot bypass is loud so temporary overrides cannot become sticky silent greens.
      await emitProtocolAllow(ports, 'NOT verified - BYPASS consumed for this stop only.', options);
      return 0;
    }

    const config = await ports.loadConfig();
    deps = await ports.buildDeps(config);
    const dirtyGuardedPaths = await checkGuard(deps, config);
    if (dirtyGuardedPaths.length === 0) {
      // Receipt trust binds committed state, while checkGuard catches local guarded edits before any fast allow.
      const receiptCheck = await verifyStoredReceipt(ports, deps, config);
      if (receiptCheck.verified) {
        await emitProtocolAllow(ports, receiptCheck.details, options);
        return 0;
      }
    }

    const parsedSession = parseSessionId(input.sessionId);
    if (parsedSession.warning !== null) {
      await writeStderr(ports, parsedSession.warning);
    }
    if (parsedSession.sessionId !== null) {
      const pinName = sessionPinFileName(parsedSession.sessionId, ports.cwd());
      const stored = await ports.pins.read(pinName);
      const previousPins = stored.status === 'found' ? parseSessionPins(stored.contents) : null;
      if (stored.status === 'refused') {
        // Never read as "no pins yet": that is exactly what would adopt a planted file.
        pinNotice = pinsNotUsed(stored.reason, stored.fix);
      } else if (stored.status === 'found' && previousPins === null) {
        // A pin file of ours that does not parse is not "no pins yet" either. Recording fresh pins
        // over it would take whatever is committed now, a tamper included, as the baseline.
        pinNotice = pinsNotUsed(
          'the session pin file does not hold pins usabl can read',
          deletePinFileFix(ports.pins.locate(pinName)),
        );
      } else {
        const nextPins = await computeSessionPins(deps, config);
        const serialized = JSON.stringify(nextPins, null, 2);

        if (previousPins === null) {
          // No pins yet: this stop records the first pins for the session.
          const written = await ports.pins.create(pinName, serialized);
          if (written.status === 'refused') {
            pinNotice = pinsNotRecorded(written.reason, written.fix, false);
          }
        } else {
          const drift = diffSessionPins(previousPins, nextPins);
          if (drift.length > 0) {
            const message = `NOT verified - guarded policy drift during this session: ${drift.join(', ')}`;
            if (input.stopHookActive) {
              // Allow one continuation while active to avoid recursive stop-hook loops.
              // We keep the previous pins so a retry cannot convert detected drift into a silent allow.
              await emitProtocolAllow(ports, `${message}. continuation already active.`, options);
              return 0;
            }
            // Drift is a trust boundary. Overwriting pins here would let "retry stop" clear the evidence.
            await emitProtocolBlock(ports, message, options);
            return 0;
          }
          const written = await ports.pins.replace(pinName, serialized);
          if (written.status === 'refused') {
            pinNotice = pinsNotRecorded(written.reason, written.fix, true);
          }
        }
      }
    }

    const result = await ports.runEngine(deps, config);
    if (result.verdict === 'verified' && result.receipt !== null) {
      await saveReceipt(ports.fs, result.receipt);
    }

    const ctx: HookContext =
      pinNotice === null
        ? { stopHookActive: input.stopHookActive }
        : { stopHookActive: input.stopHookActive, sessionDriftChecked: pinNotice.driftChecked };
    const decision = ports.evaluateDecision(result, ctx, config);
    if (decision.block) {
      await emitProtocolBlock(ports, decision.message, options);
    } else {
      await emitProtocolAllow(ports, decision.message, options);
    }
    await writePinNotice(ports, pinNotice);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Hook errors fail open with disclosure because a wedged stop hook is worse than an honest unverified allow.
    await emitProtocolAllow(ports, `NOT verified - stop hook error: ${message}`, options);
    await writePinNotice(ports, pinNotice);
    return 0;
  } finally {
    if (deps !== null) {
      await deps.browser.close();
    }
  }
}

export async function runStopHookFromStdin(
  stdinText: string,
  ports: StopHookRunnerPorts = makeStopHookRunnerPorts(),
  options: StopHookOptions = DEFAULT_OPTIONS,
): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(stdinText);
    // Cursor sends a different stdin shape (status, loop_count) than Claude (stop_hook_active, session_id).
    const input = options.cursorMode ? parseCursorStopInput(parsed) : parseStopHookInput(parsed);
    return runStopHook(input, ports, options);
  } catch {
    if (options.cursorMode) {
      await writeStderr(ports, 'NOT verified - invalid stop hook input JSON.');
      await emitCursorAllow(ports);
    } else {
      await writeStderr(ports, 'NOT verified - invalid stop hook input JSON.');
    }
    return 0;
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

export async function main(): Promise<number> {
  const cursorMode = process.argv.includes('--cursor');
  return runStopHookFromStdin(await readStdin(), makeStopHookRunnerPorts(), { cursorMode });
}
