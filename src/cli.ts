/**
 * CLI command implementation.
 * Check, comment, and self-check project a gated Result from `run()`.
 * `enforce` reads that Result from stdin and exits a CI status. It never
 * calls `gate()`. GitHub review lookup lives here, not in `run()`.
 * `init` writes draft policy only and must return before `loadConfig` / `run`
 * so this process cannot consume files it just generated.
 * The CLI never mints verdicts.
 * Sample `usabl.config.json` URLs (`http://127.0.0.1:5173`) are the fixture app's
 * Vite origin, not a hardcoded engine target. The engine always reads operator config.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { run } from './run.js';
import type { UsablConfig } from './contracts/index.js';
import { buildDeps } from './deps/build.js';
import { makeFsGlob } from './deps/fs.js';
import { readStorageStateEnv } from './deps/session.js';
import { formatInitReport, inferInit, writeInitDrafts, type InitFs } from './init/index.js';
import {
  formatDocsInitReport,
  inferDocsInit,
  writeDocsInitDraft,
  type DocsInitFs,
} from './init/docs/index.js';
import { runBaseline, type BaselineFs } from './baseline/index.js';
import { runFloorPrune, type FloorPruneFs } from './floor/prune.js';
import { makeGitReader } from './deps/git.js';
import { parseUsablConfig } from './intake/config.js';
import { ciRefusal, installRefusal, mergeChangedPaths, parseCliArgs, projectCli, type CliOptions } from './surfaces/cli.js';
import { runStopHookFromStdin } from './surfaces/stop-hook-runner.js';
import { formatInstallReport, type InstallFs, type InstallResult } from './install/index.js';
import { planOverlay, writeOverlay } from './install/overlay.js';
import { planClaude, writeClaude } from './install/claude.js';
import { installClaudeSkills } from './install/claude-skill.js';
import { planCursor, readCursorUiFileGlobs, writeCursor } from './install/cursor.js';
import { planCi, planDocsCi, writeCi, writeDocsCi } from './install/ci.js';
import { verifyBranchRule, type GhReader } from './install/branch-rule.js';
import { projectDocs } from './surfaces/docs.js';
import { renderDocsHtml } from './surfaces/docs-html.js';
import { projectPrComment } from './surfaces/pr-comment.js';
import { collectReviews, enforceAccessibility, enforcePolicy, parsePullRequestEvent, parseResultJson } from './surfaces/policy-enforce.js';
import { projectSelfCheck } from './surfaces/self-check.js';
import { BYPASS_ONCE_PATH, RECEIPT_DIR, saveReceipt, type ReceiptFs } from './surfaces/receipt-store.js';
import { runRoutesDrift } from './drift/routes.js';
import { runDoctor, type DoctorDeps } from './doctor/index.js';
import { probePlaywrightChromium } from './doctor/playwright-bootstrap.js';

export async function loadConfig(path = 'usabl.config.json'): Promise<UsablConfig> {
  // Targets come from config so the same engine can run in local, CI, and preview environments.
  return parseUsablConfig(await readFile(path, 'utf8'));
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function runEnforce(opts: CliOptions): Promise<number> {
  try {
    if (opts.enforceCheck !== 'accessibility' && opts.enforceCheck !== 'policy') {
      process.stderr.write('usabl: enforce requires accessibility or policy\n');
      return 2;
    }
    const parsed: unknown = JSON.parse(await readStdin());
    const result = parseResultJson(parsed);
    if (opts.enforceCheck === 'accessibility') {
      const outcome = enforceAccessibility(result);
      process.stdout.write(`${outcome.message}\n`);
      return outcome.exitCode;
    }
    if (opts.trustedRef === null) {
      process.stderr.write('usabl: enforce policy requires --trusted-ref\n');
      return 2;
    }
    const pr = parsePullRequestEvent(readEventPayload());
    if (pr === null) {
      process.stderr.write('usabl: GITHUB_EVENT_PATH must describe a pull request\n');
      return 2;
    }
    const git = makeGitReader();
    const outcome = await enforcePolicy(result, {
      trustedRef: opts.trustedRef,
      pr,
      git: { show: (ref, path) => git.show(ref, path), lsFiles: (ref, prefix) => git.lsFiles(ref, prefix) },
      listReviews: () => listPullReviews(pr.number),
    });
    process.stdout.write(`${outcome.message}\n`);
    return outcome.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`usabl: ${message}\n`);
    return 4;
  }
}

function readEventPayload(): unknown {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined || eventPath.length === 0) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
}

async function listPullReviews(pullNumber: number): Promise<Array<{ userLogin: string; state: string; commitId: string }>> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (token === undefined || token.length === 0 || repo === undefined || repo.length === 0) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required for enforce policy');
  }
  return collectReviews(async (page) => {
    const url = `https://api.github.com/repos/${repo}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'usabl',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub reviews request failed (${response.status})`);
    }
    return response.json();
  });
}

const execFileAsync = promisify(execFile);

// A read-only gh reader for the branch-rule check. The only method issues a GET against an
// api endpoint, building the argument list internally as ['api', endpoint] and never adding
// -X or --method, so it is read-only by construction rather than by convention. The call
// uses the list form, never a shell string. gh missing (ENOENT) returns null so the
// generator can refuse honestly instead of pretending the setting was verified.
function makeGhReader(): GhReader {
  return {
    getJson: async (endpoint) => {
      // Defense in depth: the endpoint is a fixed constant today, but reject anything shaped
      // like a flag or carrying extra tokens so it can never smuggle in a method change.
      if (endpoint.startsWith('-') || /\s/.test(endpoint)) {
        return null;
      }
      try {
        const { stdout, stderr } = await execFileAsync('gh', ['api', endpoint], { encoding: 'utf8' });
        return { code: 0, stdout, stderr };
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          // gh is not installed at all. The generator turns this into cannot-verify.
          return null;
        }
        // A non-zero exit carries a numeric code plus captured output. Surface it so the
        // generator can tell "branch not protected" from an auth or network failure.
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        if (typeof failure.code === 'number') {
          return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
        }
        return null;
      }
    },
  };
}

async function runInstall(opts: CliOptions): Promise<number> {
  // Exactly one target per run. Zero or several is refused before any file is touched.
  const refusal = installRefusal(opts);
  if (refusal !== null) {
    process.stderr.write(`usabl: ${refusal.message}\n`);
    return refusal.exitCode;
  }

  // branch-rule is read-only. It writes nothing and only verifies through a read-only gh
  // GET, so it takes the gh reader rather than a filesystem port.
  if (opts.installTarget === 'branch-rule') {
    const outcome = await verifyBranchRule(makeGhReader());
    const stream = outcome.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(formatInstallReport(outcome));
    return outcome.exitCode;
  }

  const globber = makeFsGlob();
  const installFs: InstallFs = {
    readFile: globber.readFile,
    glob: globber.glob,
    writeFile: async (path, contents) => {
      // Create the parent folder (.claude, .github/workflows) before writing the draft.
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, 'utf8');
    },
  };

  // Each generator splits into a pure plan step and a write step, mirroring init. Nothing
  // here reads a verdict, calls the gate, or consumes a file it just wrote.
  let result: InstallResult;
  if (opts.installTarget === 'overlay') {
    result = await writeOverlay(installFs, await planOverlay(installFs));
  } else if (opts.installTarget === 'claude') {
    result = await writeClaude(installFs, await planClaude(installFs));
  } else if (opts.installTarget === 'claude-skill') {
    result = await installClaudeSkills(installFs);
  } else if (opts.installTarget === 'cursor') {
    const uiFileGlobs = await readCursorUiFileGlobs(installFs, opts.configPath);
    result = await writeCursor(installFs, await planCursor(installFs, uiFileGlobs));
  } else if (opts.installTarget === 'docs-ci') {
    result = await writeDocsCi(installFs, await planDocsCi(installFs));
  } else {
    result = await writeCi(installFs, await planCi(installFs));
  }

  // Exit 0 (written or already wired) goes to stdout; a refusal (exit 2) goes to stderr,
  // matching the baseline and floor commands.
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(formatInstallReport(result));
  return result.exitCode;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`usabl: ${message}\n`);
    return 2;
  }

  if (
    opts.command !== 'check' &&
    opts.command !== 'comment' &&
    opts.command !== 'bypass' &&
    opts.command !== 'init' &&
    opts.command !== 'baseline' &&
    opts.command !== 'floor' &&
    opts.command !== 'drift' &&
    opts.command !== 'enforce' &&
    opts.command !== 'install' &&
    opts.command !== 'stop-hook' &&
    opts.command !== 'doctor' &&
    opts.command !== 'docs'
  ) {
    process.stderr.write(`unknown command: ${opts.command}\n`);
    return 2;
  }

  if (opts.command === 'stop-hook') {
    // The stable entry point wired into .claude/settings.json and .cursor/hooks.json.
    // It reads stdin and hands off to the shared runner, which always returns 0 so a
    // wedged hook can never block continuation through an exit code. --cursor switches
    // the output protocol from Claude's decision: block to Cursor's followup_message.
    return runStopHookFromStdin(await readStdin(), undefined, { cursorMode: opts.cursorStopHook });
  }

  if (opts.command === 'install') {
    return runInstall(opts);
  }

  if (opts.command === 'init') {
    // Init is a generator, not a check. Returning here keeps draft writes off
    // the verdict path and prevents a same-run consume of the new sidecar.
    const globber = makeFsGlob();

    if (opts.docs) {
      // --docs drafts the usabl.docs.json sidecar for the detected docs format. It is a
      // separate onboarding from app-config init: a docs repo has no usabl.config.json to draft.
      const docsInitFs: DocsInitFs = {
        readFile: globber.readFile,
        glob: globber.glob,
        writeFile: async (path, contents) => {
          await writeFile(path, contents, 'utf8');
        },
      };
      let draft;
      try {
        // The adapter throws when it detects a format but cannot map a single page. A wrong
        // mapping is worse than a gap, so that surfaces as an error rather than a silent draft.
        draft = await inferDocsInit(docsInitFs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`usabl: ${message}\n`);
        return 2;
      }
      if (draft === null) {
        // Deferred formats (Antora, MkDocs, Docusaurus) and no-docs repos are a clean no-op,
        // not a failure: there is simply no docs surface init can draft here.
        process.stdout.write(
          'No supported docs format detected (looked for a Pantheon titles/*/master.adoc or an AsciiBinder _topic_maps/_topic_map.yml). Nothing written.\n',
        );
        return 0;
      }
      const result = await writeDocsInitDraft(docsInitFs, draft, { force: opts.force });
      process.stdout.write(formatDocsInitReport(draft, result));
      return result.ok ? 0 : 2;
    }

    const initFs: InitFs = {
      readFile: globber.readFile,
      glob: globber.glob,
      writeFile: async (path, contents) => {
        await writeFile(path, contents, 'utf8');
      },
    };
    let draft;
    try {
      // Init throws when a derived screen id is one the parser would refuse. A draft without
      // that route would hide it from coverage, so the refusal surfaces as an error and nothing
      // is written, the same way docs init refuses.
      draft = await inferInit(initFs, { sessionConfigured: readStorageStateEnv(process.env) !== null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`usabl: ${message}\n`);
      return 2;
    }
    const result = await writeInitDrafts(initFs, draft, { force: opts.force });
    process.stdout.write(formatInitReport(draft, result));
    return result.ok ? 0 : 2;
  }

  if (opts.command === 'bypass') {
    await mkdir(RECEIPT_DIR, { recursive: true });
    await writeFile(BYPASS_ONCE_PATH, `${new Date().toISOString()}\n`, 'utf8');
    process.stdout.write('NOT verified - BYPASS set for the next stop only.\n');
    return 0;
  }

  if (opts.command === 'baseline') {
    // Baseline is an explicit local generator. It writes only the floor draft and returns.
    const config = await loadConfig(opts.configPath);
    const deps = await buildDeps(config, {
      ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
    });
    try {
      const baselineFs: BaselineFs = {
        writeFile: async (path, contents) => {
          await writeFile(path, contents, 'utf8');
        },
      };
      const outcome = await runBaseline(deps, config, baselineFs, {
        ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
        partial: opts.partial,
      });
      if (outcome.exitCode === 0) {
        process.stdout.write(`${outcome.message}\n`);
      } else {
        process.stderr.write(`usabl: ${outcome.message}\n`);
      }
      return outcome.exitCode;
    } finally {
      await deps.browser.close();
    }
  }

  if (opts.command === 'floor') {
    if (opts.floorSubcommand !== 'prune') {
      process.stderr.write('usabl: floor supports only the prune subcommand\n');
      return 2;
    }
    const config = await loadConfig(opts.configPath);
    const deps = await buildDeps(config, {
      ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
    });
    try {
      const floorFs: FloorPruneFs = {
        readFile: async (path) => {
          try {
            return await readFile(path, 'utf8');
          } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
              return null;
            }
            throw error;
          }
        },
        writeFile: async (path, contents) => {
          await writeFile(path, contents, 'utf8');
        },
      };
      const outcome = await runFloorPrune(deps, config, floorFs, {
        ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
      });
      if (outcome.exitCode === 0) {
        process.stdout.write(`${outcome.message}\n`);
      } else {
        process.stderr.write(`usabl: ${outcome.message}\n`);
      }
      return outcome.exitCode;
    } finally {
      await deps.browser.close();
    }
  }

  if (opts.command === 'drift') {
    if (opts.driftSubcommand !== 'routes') {
      process.stderr.write('usabl: drift supports only the routes subcommand\n');
      return 2;
    }
    const config = await loadConfig(opts.configPath);
    const outcome = await runRoutesDrift(makeFsGlob(), config.discovery.routerFile);
    if (outcome.stdout) {
      process.stdout.write(outcome.stdout);
    }
    if (outcome.stderr) {
      process.stderr.write(outcome.stderr);
    }
    return outcome.exitCode;
  }

  if (opts.command === 'doctor') {
    // Doctor is a read-only projection. It reads the working tree and a read-only gh GET,
    // reports each surface state, and always exits 0 because it mints no verdict. The
    // read-only fs writeFile throws so any accidental write fails loudly instead of mutating.
    const globber = makeFsGlob();
    const doctorFs: InstallFs = {
      readFile: globber.readFile,
      glob: globber.glob,
      writeFile: async () => {
        throw new Error('doctor is read-only and never writes');
      },
    };
    // The environment is read here, at the edge, so no collector reaches for a global.
    const deps: DoctorDeps = {
      fs: doctorFs,
      gh: makeGhReader(),
      configPath: opts.configPath,
      env: process.env,
      probePlaywrightChromium,
    };
    const outcome = await runDoctor(deps);
    process.stdout.write(outcome.stdout);
    return outcome.exitCode;
  }

  if (opts.command === 'comment') {
    // Comment mode is a pure projection from stdin so CI does not import package internals.
    const parsed: unknown = JSON.parse(await readStdin());
    const result = parseResultJson(parsed);
    // Load config best-effort so a repo's noiseBudget applies to the comment. Absent config falls
    // back to the default budget rather than failing the projection.
    let commentConfig: UsablConfig | undefined;
    try {
      commentConfig = await loadConfig(opts.configPath);
    } catch {
      commentConfig = undefined;
    }
    process.stdout.write(projectPrComment(result, commentConfig) + '\n');
    return result.exitCode;
  }

  if (opts.command === 'enforce') {
    return runEnforce(opts);
  }

  if (opts.command === 'docs') {
    // Docs is a generator, not a gate. It projects design-intake and transcript artifacts
    // from a full run and always exits 0. Artifact honesty comes from receipt binding
    // (unverified surfaces carry no evidenceRef), never from a verdict this command invents.
    const config = await loadConfig(opts.configPath);
    const deps = await buildDeps(config, {
      allowedCapabilities: opts.staticOnly ? [] : ['live'],
    });
    try {
      const result = await run(deps, config);
      const projected = projectDocs(result, deps.requirements);
      // --html renders the same artifacts as one accessible, self-contained page.
      // The page carries the honesty invariant on its face: only receipt-bound
      // cards are shown as verified; everything else is labelled an observation.
      const output = opts.html ? renderDocsHtml(projected.artifacts) : projected.json;
      process.stdout.write(output + '\n');
      return 0;
    } finally {
      await deps.browser.close();
    }
  }

  const refusal = ciRefusal(opts);
  if (refusal !== null) {
    process.stderr.write(`usabl: ${refusal.message}\n`);
    return refusal.exitCode;
  }

  const config = await loadConfig(opts.configPath);
  const deps = await buildDeps(config, {
    // Static-only denies live checks as explicit capability gaps instead of silent omission.
    allowedCapabilities: opts.staticOnly ? [] : ['live'],
    ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
  });
  try {
    let changedFiles: string[] | undefined;
    if (opts.trustedRef !== null) {
      // Merge-base diff covers CI checkouts; status paths keep local dirty files in scope.
      const diffNames = await deps.git.diffNameOnly(opts.trustedRef);
      const statusPaths = (await deps.git.statusZ()).map((entry) => entry.path);
      changedFiles = mergeChangedPaths(diffNames, statusPaths);
    }

    const result = await run(deps, config, {
      ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
      ...(changedFiles === undefined ? {} : { changedFiles }),
    });
    if (result.verdict === 'verified' && result.receipt !== null) {
      const receiptFs: ReceiptFs = {
        readFile: async () => null,
        writeFile: async (path, contents) => {
          await writeFile(path, contents, 'utf8');
        },
        mkdir: async (path) => {
          await mkdir(path, { recursive: true });
        },
      };
      // Verified checks persist local proof so the stop-hook fast path can re-check without a browser.
      await saveReceipt(receiptFs, result.receipt);
    }
    if (opts.selfCheck) {
      // Self-check is advisory and keeps exit 0 so stop-hook remains the only gate for continuation.
      const advisory = projectSelfCheck(result, config);
      process.stdout.write(advisory.message + '\n');
      return advisory.advisoryExitCode;
    }
    const projected = projectCli(result);
    process.stdout.write((opts.json ? projected.json : projected.text) + '\n');
    return projected.exitCode;
  } finally {
    // Always close browser resources, even when run() throws before returning a Result.
    await deps.browser.close();
  }
}
