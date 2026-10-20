/**
 * `run(deps, config)` is the whole engine sequencer: guard, cover, scan, gate, maybe receipt.
 * It never decides a verdict. The gate does. This file only sequences injected I/O.
 *
 * Guard runs first. Diverged working-tree floor and waiver bytes are not parsed,
 * because a crash would fail open (exit 4) instead of blocking as approval_required.
 * Affected UI still scans so mixed policy PRs keep accessibility findings.
 *
 * Coverage mapping comes from the planner shared by tests and production code.
 * A local fallback mapper is forbidden because it could hide unmapped UI as idle.
 *
 * No hidden filesystem, git, or browser. Callers pass Deps (real or `makeFakeDeps`).
 * Sampling is forbidden: every affected surface is scanned, or we do not claim verified.
 */
import type {
  Coverage,
  CoverageGap,
  Deps,
  EvidenceFloor,
  Finding,
  Result,
  ScreenScan,
  UsablConfig,
  Waiver,
  WaiverLedger,
} from './contracts/index.js';
import { computeCoverage } from './coverage/planner.js';
import { parseDocsManifest, type DocsManifest } from './coverage/docs-manifest.js';
import { computeDocsCoverage } from './coverage/docs-planner.js';
import { markUnseenScreens } from './coverage/unseen.js';
import { mapFindingToSource, type DocsPageClosure } from './docs/source-map.js';
import { enrichAppFindings } from './app/source-map.js';
import { gate } from './gate/index.js';
import { mintReceipt, summarizeApplicability } from './evidence/receipt.js';
import { parseEvidenceFloor } from './evidence/floor.js';
import { parseUsablConfig } from './intake/config.js';
import { loadRequirements } from './intake/load.js';
import { overlayRequirementsFs } from './intake/overlay-fs.js';
import { assertIso8601Utc } from './primitives/iso8601.js';
import { checkGuard } from './trust/guard.js';

// Declared here rather than imported from baseline/, which imports run() and would cycle.
const EVIDENCE_FLOOR_PATH = '.usabl-evidence.json';
const CONFIG_PATH = 'usabl.config.json';
// Synthesized now, so it is version 2. It holds nothing, so nothing can hide behind it.
const EMPTY_FLOOR: EvidenceFloor = { version: 2, entries: [] };

export interface RunOptions {
  changedFiles?: string[];
  trustedRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseWaiver(value: unknown): Waiver {
  if (!isRecord(value)) {
    throw new Error('waiver entry must be an object');
  }

  const rule = value['rule'];
  const surface = value['surface'];
  const scope = value['scope'];
  const reason = value['reason'];
  const owner = value['owner'];
  const approvedBy = value['approvedBy'];
  const created = value['created'];
  const expires = value['expires'];

  if (typeof rule !== 'string') throw new Error('waiver rule must be a string');
  if (typeof surface !== 'string') throw new Error('waiver surface must be a string');
  if (typeof scope !== 'string') throw new Error('waiver scope must be a string');
  if (typeof reason !== 'string') throw new Error('waiver reason must be a string');
  if (typeof owner !== 'string') throw new Error('waiver owner must be a string');
  if (typeof approvedBy !== 'string') throw new Error('waiver approvedBy must be a string');
  if (typeof created !== 'string') throw new Error('waiver created must be a string');
  if (typeof expires !== 'string') throw new Error('waiver expires must be a string');
  assertIso8601Utc(created, 'waiver created');
  assertIso8601Utc(expires, 'waiver expires');

  return { rule, surface, scope, reason, owner, approvedBy, created, expires };
}

// Exported so the read-only doctor projection can report waiver-ledger parse health without
// re-implementing a weaker validator. run() stays the only caller that acts on the result.
export function parseWaiverLedger(value: unknown): WaiverLedger {
  if (!isRecord(value)) {
    throw new Error('waiver ledger must be an object');
  }
  if (value['version'] !== 1) {
    throw new Error('waiver ledger version must be 1');
  }
  const waiversRaw = value['waivers'];
  if (!Array.isArray(waiversRaw)) {
    throw new Error('waiver ledger waivers must be an array');
  }
  return { version: 1, waivers: waiversRaw.map((waiver) => parseWaiver(waiver)) };
}

async function readJson(read: (path: string) => Promise<string | null>, path: string): Promise<unknown | null> {
  const raw = await read(path);
  if (raw === null) return null;
  return JSON.parse(raw);
}

export async function run(deps: Deps, config: UsablConfig, opts: RunOptions = {}): Promise<Result> {
  try {
    const changed = opts.changedFiles ?? (await deps.git.statusZ()).map((c) => c.path);
    const guardDivergedPaths = await checkGuard(deps, config, opts.trustedRef ?? 'HEAD');
    const scanConfigResolution = await scanConfigForCoverage(deps, config, guardDivergedPaths, opts.trustedRef);
    const scanConfig = scanConfigResolution.config;
    const coverageFs = overlayUntrustedManifests(deps, guardDivergedPaths, opts.trustedRef);
    const docsManifest = await parseDocsManifest(coverageFs);
    const discoveredCoverage = await computeCoverage(coverageFs, scanConfig, changed, docsManifest);
    const docsCoverage = computeDocsCoverage(docsManifest, changed);
    const affected = [...discoveredCoverage.affected, ...docsCoverage.affected];
    // Idle means nothing UI-touching changed. A run whose scan configuration could not be read
    // cannot tell whether anything UI-touching changed, because the globs that decide it are the
    // ones it failed to read. Both states plan zero screens, so without this the two arrive at the
    // gate as the same fact and an unreadable configuration exits 0 as an accessibility pass. The
    // gap below then carries the reason, and the gate ranks it as not_covered.
    const nothingToCheck =
      scanConfigResolution.unreadable === null &&
      discoveredCoverage.nothingToCheck &&
      docsCoverage.nothingToCheck;
    const intakeFs = overlayRequirementsFs(deps.fs, deps.git, scanConfig, opts.trustedRef);
    const loadedRequirements = await loadRequirements(intakeFs, scanConfig);
    const requirementsGap: CoverageGap | null = loadedRequirements.ok
      ? null
      : {
          ref: loadedRequirements.path ?? config.requirements ?? 'requirements',
          state: 'not-covered',
          reason: loadedRequirements.reason,
        };
    const intakePolicyPaths =
      loadedRequirements.ok
        ? []
        : [loadedRequirements.path ?? config.requirements ?? 'requirements'].filter((path) => path.length > 0);
    const policyDivergedPaths = [...new Set([...guardDivergedPaths, ...intakePolicyPaths])].sort();

    // Malformed intake cannot self-grade. The harness stays closed until policy is valid.
    // Guarded-file edits still scan affected UI so mixed PRs keep accessibility findings.
    const scanned: ScreenScan[] = [];
    const canScan = loadedRequirements.ok && !nothingToCheck;
    if (canScan) {
      for (const s of affected) {
        scanned.push(await deps.checkRunner.scan({
          id: s.screenId,
          url: s.url,
          ...(s.profile !== undefined ? { profile: s.profile } : {}),
        }));
      }
    }
    // A screen the engine never reached still returns a scan, and axe still fires document-level
    // rules on the blank document it got. Those drafts are removed here, before the gate sees
    // them, because a finding about a page nobody rendered is not evidence at all.
    const { screens, unseenScreenIds } = markUnseenScreens(scanned);
    const drafts = screens.flatMap((s) => s.drafts);

    const policyUntrusted = policyDivergedPaths.length > 0;
    const readTrustFile = (path: string): Promise<string | null> => {
      // Floor and waivers can be pinned to a trusted ref so a PR cannot claim
      // verified against acceptance bytes it just changed in the working tree.
      if (opts.trustedRef !== undefined) {
        return deps.git.show(opts.trustedRef, path);
      }
      if (policyUntrusted) {
        return Promise.resolve(null);
      }
      return deps.fs.readFile(path);
    };
    const floor = await readFloorOrEmpty(readTrustFile, policyUntrusted);
    const waivers = await readWaiversOrEmpty(readTrustFile, policyUntrusted);

    const coverage: Coverage = {
      ...discoveredCoverage,
      affected,
      nothingToCheck,
      unresolvedFiles: [...discoveredCoverage.unresolvedFiles, ...docsCoverage.unresolvedFiles],
      gaps: [
        ...(scanConfigResolution.unreadable === null ? [] : [scanConfigResolution.unreadable]),
        ...(requirementsGap === null ? [] : [requirementsGap]),
        ...discoveredCoverage.gaps,
        ...docsCoverage.gaps,
        ...screens.flatMap((screen) => screen.gaps),
      ],
    };

    // Some screens unseen is a partial run: the gaps above carry it to not_covered and the screens
    // that were reached still report. Every screen unseen is not a partial run. Nothing was
    // measured, so no accessibility verdict would be honest and there is nothing for the gate to
    // weigh. Refuse on the channel a crash already uses: no verdict, exit 4, the reason in the
    // summary. This is not idle, because nothingToCheck stays false when UI files did change.
    if (screens.length > 0 && unseenScreenIds.length === screens.length) {
      return {
        schemaVersion: 'usabl.result.v1',
        verdict: null,
        summary: unseenRunSummary(unseenScreenIds),
        screens,
        coverage,
        findings: [],
        receipt: null,
        dirtyGuardedPaths: policyDivergedPaths,
        exitCode: 4,
        accessibilityVerdict: null,
        accessibilityExitCode: 4,
        paidDownCount: 0,
        floorHeadroom: [],
      };
    }

    // One definition of "measured this run and clean": a scanned screen with no coverage gap. The
    // gate uses it to decide which floored identities it may claim `fixed`, and paidDownCount below
    // reuses the `fixed` status the gate produced, so the two cannot drift. A cleanly scanned screen
    // with no barrier and a screen nobody scanned both produce zero drafts, which is why the gate
    // cannot infer this from the drafts and needs it as input.
    const cleanlyScannedScreens = new Set(
      screens.filter((screen) => screen.gaps.length === 0).map((screen) => screen.screenId),
    );

    const gated = gate({
      coverage,
      guardDivergedPaths: policyDivergedPaths,
      drafts,
      floor,
      waivers,
      now: deps.clock(),
      cleanlyScannedScreens,
    });

    // The gate is the only unit that counts the evidence floor, so it is the only one that can see
    // a floor which predates count tracking or one whose recorded counts stand above what this run
    // observed. It has already weighed both into its verdict and named them in its summary, so
    // appending them here is disclosure catching up with a decision, never a second decision. The
    // Result must carry them or a reader sees a not_covered run whose coverage names no cause.
    const coverageWithFloorGaps: Coverage =
      gated.floorGaps.length === 0
        ? coverage
        : { ...coverage, gaps: [...coverage.gaps, ...gated.floorGaps] };

    // Enrich docs findings so they speak the author's markup: source file, AsciiDoc construct, and a
    // syntax-aware fix. This runs after the gate on purpose. It reads source, never a verdict, and
    // never changes identity, status, or the floor. Source is read from the working tree (deps.fs),
    // where the author fixes it, even when the manifest itself was read from a trusted ref.
    const docsEnriched = await enrichDocsFindings(gated.findings, docsManifest, deps.fs);
    const findings = enrichAppFindings(docsEnriched, coverageWithFloorGaps);

    // Receipts are reserved for verified. Preview and model-judgment cannot mint one.
    const receipt =
      gated.verdict === 'verified'
        ? await mintReceipt(deps, config, {
            surfaces: ['cli'],
            checked: coverageWithFloorGaps.affected.map((a) => a.screenId),
            notCovered: coverageWithFloorGaps.unresolvedFiles,
            applicability: summarizeApplicability(screens),
            findingsSummary: summarize(gated.findings),
            activeWaivers: gated.findings.filter((f) => f.status === 'waived').length,
          })
        : null;

    // Count the floored barriers this run did not observe. The gate marks an identity `fixed` only
    // when its screen was scanned cleanly and the barrier was not seen, so every `fixed` finding
    // here is an observed absence. Whether it was fixed is not knowable from here, because a screen
    // rendering fewer rows produces the same absence, and the surfaces word it that way. Counting
    // the status directly keeps this on
    // the same single definition the gate used, rather than re-deriving the cleanly-scanned filter.
    const paidDownCount = gated.findings.filter((f) => f.status === 'fixed').length;

    return {
      schemaVersion: 'usabl.result.v1',
      verdict: gated.verdict,
      summary: gated.summary,
      screens,
      coverage: coverageWithFloorGaps,
      findings,
      receipt,
      dirtyGuardedPaths: policyDivergedPaths,
      exitCode: gated.exitCode,
      accessibilityVerdict: gated.accessibilityVerdict,
      accessibilityExitCode: gated.accessibilityExitCode,
      paidDownCount,
      floorHeadroom: gated.floorHeadroom,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Crash: disclose and fail open (exit 4). verdict is null because the gate never ran.
    // This is not idle (`nothingToCheck` is false). Never mint verified from a crash.
    return {
      schemaVersion: 'usabl.result.v1',
      verdict: null,
      summary: `unhandled error: ${message}`,
      screens: [],
      coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
      findings: [],
      receipt: null,
      dirtyGuardedPaths: [],
      exitCode: 4,
      accessibilityVerdict: null,
      accessibilityExitCode: 4,
      paidDownCount: 0,
      floorHeadroom: [],
    };
  }
}

// Read by the CLI, by `usabl enforce`, and by the baseline and prune refusals, so it has to say
// what happened on its own. Per-screen detail is already on coverage.gaps.
function unseenRunSummary(unseenScreenIds: string[]): string {
  const count = unseenScreenIds.length;
  return (
    `usabl never saw the application: all ${count} affected screen${count === 1 ? '' : 's'} ` +
    `(${unseenScreenIds.join(', ')}) scanned without rendering, so nothing was measured and no ` +
    'accessibility verdict would be honest. See coverage gaps for what each screen returned.'
  );
}

async function readFloorOrEmpty(
  read: (path: string) => Promise<string | null>,
  policyUntrusted: boolean,
): Promise<EvidenceFloor> {
  try {
    const floorValue = await readJson(read, EVIDENCE_FLOOR_PATH);
    return floorValue === null ? EMPTY_FLOOR : parseEvidenceFloor(floorValue);
  } catch (err) {
    if (policyUntrusted) return EMPTY_FLOOR;
    throw err;
  }
}

async function readWaiversOrEmpty(
  read: (path: string) => Promise<string | null>,
  policyUntrusted: boolean,
): Promise<Waiver[]> {
  try {
    const ledgerValue = await readJson(read, '.usabl-waivers.json');
    return ledgerValue === null ? [] : parseWaiverLedger(ledgerValue).waivers;
  } catch (err) {
    if (policyUntrusted) return [];
    throw err;
  }
}

/**
 * The scan configuration this run planned coverage with, plus the disclosure owed when it is not
 * the configuration the operator wrote.
 *
 * `unreadable` is null when the document was read and parsed. When it is set, the config carried
 * here declares no surfaces and no UI globs, which is a placeholder and not a statement that the
 * repository has no UI. Those are opposite facts and the caller must keep them apart.
 */
interface ScanConfigResolution {
  config: UsablConfig;
  unreadable: CoverageGap | null;
}

// The configuration only plans app screens. Docs screens are planned from usabl.docs.json, which
// this run still reads, so a changed docs page can still be scanned. Whether it was scanned is
// decided later, by the same policy checks every scan waits on, so the wording must not claim it.
// It points the reader at the docs screens and gaps on this Result, which record what happened.
function unreadableScanConfigGap(trustedRef: string, detail: string): CoverageGap {
  return {
    ref: CONFIG_PATH,
    state: 'not-covered',
    reason:
      `${CONFIG_PATH} changed on this branch, so the app configuration was read from ${trustedRef} ` +
      `instead of the working tree, and that document could not be read: ${detail}. usabl therefore ` +
      'does not know which app screens the changed files belong to, so no app screen was planned ' +
      'or checked. Docs coverage is planned separately under usabl.docs.json; see this run\'s docs ' +
      'screens and gaps for what was actually checked. This run cannot verify accessibility. ' +
      `Repair the configuration at ${trustedRef}, then run usabl again.`,
  };
}

/**
 * What this guarantees: a trusted configuration usabl cannot read never reads as idle or verified
 * and never mints a receipt. This resolver returns a missing, unparseable, or schema-invalid
 * document as a coverage gap. Whether that gap reaches the gate depends on the rest of the run,
 * which can still crash on an independent failure, such as an invalid docs manifest. A raw read
 * failure, where the git call itself throws (for example permission denied or an I/O error), is
 * disclosed as a crash instead (exit 4, the fail-open disclosure path below: no verdict, no
 * receipt, and CI blocks it): the guard reads the same document at the same ref before this runs,
 * so the failure surfaces there, outside any handler here. The read below sits inside the handler
 * so that if the guard's read succeeded and this one fails, that later failure is also returned
 * as the gap rather than a crash.
 */
async function scanConfigForCoverage(
  deps: Deps,
  config: UsablConfig,
  guardDivergedPaths: string[],
  trustedRef: string | undefined,
): Promise<ScanConfigResolution> {
  // Working-tree config URLs are untrusted when config diverged. Scan the
  // trusted-ref document so a policy PR cannot point the CI browser at a new origin.
  if (!guardDivergedPaths.includes(CONFIG_PATH) || trustedRef === undefined) {
    return { config, unreadable: null };
  }
  try {
    const raw = await deps.git.show(trustedRef, CONFIG_PATH);
    if (raw === null) {
      return {
        config: { ...config, surfaces: [], uiFileGlobs: [] },
        unreadable: unreadableScanConfigGap(trustedRef, `no ${CONFIG_PATH} exists at that ref`),
      };
    }
    return { config: parseUsablConfig(raw), unreadable: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: { ...config, surfaces: [], uiFileGlobs: [] },
      unreadable: unreadableScanConfigGap(trustedRef, message),
    };
  }
}

function overlayUntrustedManifests(
  deps: Deps,
  guardDivergedPaths: string[],
  trustedRef: string | undefined,
): Deps['fs'] {
  // Coverage planning reads usabl.routes.json and usabl.docs.json. Both control
  // scan targets (routes controls app scan targets, docs controls the docs scan surface).
  // If either file diverged, use the trusted ref (or nothing) so a PR cannot steer scans
  // at attacker-chosen URLs.
  const overlaidManifests = ['usabl.routes.json', 'usabl.docs.json'];
  const divergedManifests = overlaidManifests.filter((path) => guardDivergedPaths.includes(path));
  if (divergedManifests.length === 0) {
    return deps.fs;
  }
  const divergedSet = new Set(divergedManifests);
  return {
    glob: (patterns) => deps.fs.glob(patterns),
    readFile: async (path) => {
      if (!divergedSet.has(path)) {
        return deps.fs.readFile(path);
      }
      if (trustedRef !== undefined) {
        return deps.git.show(trustedRef, path);
      }
      return null;
    },
  };
}

// Attach a source mapping to every finding on a docs page (its screenId matches a manifest pageId).
// App findings and docs findings whose page cannot be resolved pass through unchanged. mapFindingToSource
// fails open, so a missing or unreadable source yields a fallback mapping, never a throw.
async function enrichDocsFindings(
  findings: Finding[],
  docsManifest: DocsManifest | null,
  fs: Deps['fs'],
): Promise<Finding[]> {
  if (docsManifest === null) {
    return findings;
  }
  const closureByPageId = new Map<string, DocsPageClosure>();
  for (const page of docsManifest.pages) {
    closureByPageId.set(page.pageId, { assemblyFile: page.assemblyFile, sources: page.sources });
  }
  const enriched: Finding[] = [];
  for (const finding of findings) {
    const closure = closureByPageId.get(finding.screenId);
    if (closure === undefined) {
      enriched.push(finding);
      continue;
    }
    const docsSource = await mapFindingToSource(finding, closure, fs);
    enriched.push({ ...finding, docsSource });
  }
  return enriched;
}

function summarize(findings: Finding[]) {
  return {
    new: findings.filter((f) => f.status === 'new').length,
    carried: findings.filter((f) => f.status === 'carried').length,
    fixed: findings.filter((f) => f.status === 'fixed').length,
    unverified: findings.filter((f) => f.confidence === 'unverified').length,
  };
}
