/**
 * usabl kernel vocabulary for verdicts, evidence, coverage, and injected seams.
 * This unit defines shared shapes only.
 * It must never mint a verdict, infer a pass, or hide not-covered work.
 * Layers project a Result, but the gate remains the only verdict authority.
 */

// ---- verdict + evidence vocabulary ----
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
// Evidence class is provenance, not authority. Deterministic can gate today (or later by promotion).
// Preview and model-judgment stay visible for operator context and never mint a gate verdict.
export type EvidenceClass =
  | 'deterministic'
  | 'preview'
  | 'model-judgment'
  | 'human-confirmed';
// Verdict is the gate output when gating ran. `verdict: null` is intentional disclosure for idle
// or fail-open runs, not a fifth verdict and not a synonym for not_covered.
export type Verdict =
  | 'verified'
  | 'regression'
  | 'not_covered'
  | 'approval_required';
// Accessibility fields never carry approval_required. That verdict is policy, not a scan outcome.
export type AccessibilityVerdict = Exclude<Verdict, 'approval_required'>;
// AccessibilityExitCode never includes 2. Crash is 4.
export type AccessibilityExitCode = 0 | 1 | 3 | 4;
export type FactSource = 'ax-tree' | 'attribute';
export type IdentityBasis = 'name' | 'structural' | 'count';

// ---- evidence + findings ----
export interface Fact<T = string | null> {
  value: T;
  source: FactSource;
  fromTree: boolean;
}
export interface EvidenceFacts {
  name?: Fact;
  role?: Fact;
  state?: Record<string, Fact<unknown>>;
  extra?: Record<string, unknown>;
}
// Providers emit Draft only. They report observations and confidence, but never set status or verdict.
export interface Draft {
  rule: string;
  layer: string; // contest ids: 'axe' | 'pf' | 'walk'; stays open
  severity: Severity;
  evidenceClass: EvidenceClass; // only 'deterministic' (or later promoted) mints the gate verdict; preview and model-judgment surface, they never gate
  screenId: string;
  elementPath: string;
  elementName: string | null;
  role: string | null;
  whatUserExperiences: string;
  why: string;
  fix: string;
  evidence: EvidenceFacts;
  confidence: 'fail' | 'unverified';
}
// ---- docs source mapping (presentation-only enrichment for docs findings) ----
// Which tier resolved a docs finding to its AsciiDoc source. renderer = exact file+line from a
// cooperating sourcemap pass; content = file+construct matched in the include closure; fallback =
// the page's assembly file with the whole closure disclosed. See src/docs/source-map.ts.
export type SourceMapTier = 'renderer' | 'content' | 'fallback';
// How a docs finding maps back to the markup its author edits. run() attaches this after the gate,
// so it never influences identity, the floor, or the verdict; it only makes a finding speak source.
export interface DocsSourceMapping {
  tier: SourceMapTier;
  file: string | null; // primary attributed source file; null only when a fallback has no assembly
  candidates: string[]; // every source that could own the construct; the whole closure on fallback
  construct: string | null; // the author's markup (image::x, link:..., '=== Title'); null on fallback
  line: number | null; // exact source line, from the renderer tier only
  fix: string; // the fix phrased in the format's own syntax where a construct is known
}

// Finding is gate-owned enrichment. The gate adds identity and lifecycle status to each Draft.
export interface Finding extends Draft {
  elementKey: string | null; // null when identityBasis is 'count'
  identityBasis: IdentityBasis;
  status: 'new' | 'carried' | 'fixed' | 'waived';
  // Docs findings only: source mapping run() attaches after the gate. Absent on app findings and on
  // docs findings whose page closure could not be resolved. Presentation only, never gates.
  docsSource?: DocsSourceMapping;
  // App findings only: source mapping run() attaches after the gate. Uses renderer attrs on the
  // DOM when present, otherwise the route import chain or coverage hints. Presentation only.
  appSource?: AppSourceMapping;
}

// ---- app source mapping ----
// renderer = data-source-file/line from the cooperating Vite dev transform or DOM attrs;
// import-chain = the changed UI file on the route graph path to this screen;
// coverage = changed UI files disclosed as candidates when ownership is ambiguous.
export type AppSourceTier = 'renderer' | 'import-chain' | 'coverage';
export interface AppSourceMapping {
  tier: AppSourceTier;
  file: string | null;
  line: number | null;
  candidates: string[];
}

// ---- announcement / transcript (voicing lane; unused until that lane is wired) ----
export interface AnnouncementToken {
  kind: 'name' | 'role' | 'state' | 'live';
  text: string | null;
  fromTree: boolean;
  source: FactSource;
}
export interface TranscriptStop {
  index: number;
  elementPath: string;
  announcement: AnnouncementToken[];
}
// ---- applicability (what a rule did on a screen, recorded and never judged) ----
// Silence from a check has two meanings that look identical in a findings list: the rule ran
// against matching elements and found nothing wrong, or the rule matched nothing at all and
// never had an opinion. Recording the outcome per rule per screen keeps those apart.
// Nothing here classifies an outcome as expected or suspicious, and nothing here gates.
export type RuleOutcome = 'failed' | 'incomplete' | 'passed' | 'inapplicable';
export interface RuleApplicability {
  screenId: string;
  layer: string;
  rule: string;
  outcome: RuleOutcome;
  // Elements the rule matched on this screen. axe reports zero for an inapplicable rule, and the
  // count is read from what the run returned rather than assumed from the outcome.
  elementCount: number;
}

export interface ScreenScan {
  screenId: string;
  url: string;
  stops: TranscriptStop[];
  drafts: Draft[];
  gaps: CoverageGap[];
  // Required, never optional. An absent field would read as "nothing applied here", which is the
  // confusion this record exists to remove. Empty means nothing was reported, which is honest for
  // a scan that failed or for providers that say nothing about applicability.
  applicability: RuleApplicability[];
  // Positive reachability evidence, measured during the scan while the live DOM was available.
  // The tri-state is deliberate:
  //   null  = the surface declared no reachedWhen selector, so we make no claim either way.
  //   true  = a reachedWhen selector was declared and at least one element matched it, so the
  //           screen provably rendered.
  //   false = a reachedWhen selector was declared and nothing matched it, so the screen did not
  //           render what the operator said proves it loaded.
  // Only false triggers an unseen gap in markUnseenScreens. The value is a plain presence test,
  // never a count or a DOM walk, so a verdict that leans on it cannot depend on iteration order.
  reachedSelectorPresent: boolean | null;
  // The reachedWhen selector the surface declared, carried so a coverage gap can name it in plain
  // English. Optional and only meaningful when reachedSelectorPresent is false. Absent or null when
  // the surface declared no selector.
  reachedWhenSelector?: string | null;
  // The response half of the readiness signal, measured at the same moment as the selector. The
  // same tri-state: absent or null when the surface declared no response, true when a fetch or XHR
  // request to the declared path on the application's own host answered with a 2xx status, false
  // when no such answer was seen. Only false triggers an unseen gap in markUnseenScreens.
  reachedResponseSeen?: boolean | null;
  // The response path the surface declared, carried so a coverage gap can name it. Absent or null
  // when the surface declared no response.
  reachedWhenResponse?: string | null;
}

// ---- coverage ----
export interface AffectedScreen {
  screenId: string;
  url: string;
  provenance: 'route-graph' | 'wide-blast' | 'manual' | 'docs-manifest';
  importChain?: string[];
  profile?: ProfileName;
}
/**
 * One floored identity where the evidence floor records more barriers than the run observed.
 *
 * Disclosure, never a verdict input. The recorded count is a high-water mark that only
 * `usabl floor prune` lowers, so the difference is room a new barrier can take at a collapsed
 * identity while the tally stays at or under what was accepted. That hole is open until the floor
 * is re-armed, and usabl says so on every run rather than blocking: on a real brownfield floor
 * these counts track how many rows a live table renders, so a blocking rule would fail unchanged
 * code whenever a list came back shorter.
 *
 * Screen id and rule only. An element key carries a neutralized accessible name or element path,
 * both page-derived, and this travels into a pull request comment and into what a model reads.
 */
export interface FloorHeadroom {
  screenId: string;
  rule: string;
  recorded: number; // barriers the floor accepted at this identity
  observed: number; // deterministic barriers this run actually saw there
}
export interface CoverageGap {
  ref: string; // surface id, url, or file path this gap concerns
  state: 'unresolved' | 'not-covered' | 'skipped' | 'capability-denied';
  reason: string; // why it was not exercised; never empty because unresolved is evidence, not idle
}
export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[]; // in-scope surfaces or checks that could not be exercised, each with a reason
  nothingToCheck: boolean; // no UI-touching files; not a verdict
}
// The gate treats unresolved files and coverage gaps as not-covered evidence.

// ---- receipt (re-checkable proof of a verified run) ----
// Receipts exist only for verified deterministic outcomes. Preview and model-judgment never mint one.
export interface Receipt {
  schemaVersion: 1;
  sourceTree: string;
  baseRevision: string | null;
  policyHash: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  surfaces: string[];
  coverage: { checked: string[]; notCovered: string[] };
  // What the run actually examined, per scanned screen: rules that examined at least one element
  // (applied) versus rules that matched nothing (abstained). This exists so a verified receipt
  // states what was checked, not only what was found. It is recorded, never re-verified:
  // verifyReceipt does not compare it, because applicability legitimately varies with app state
  // (a dialog present one run, absent the next), and it never gates. Screens with no applicability
  // data (unseen screens, stripped upstream) are omitted.
  applicability: { screenId: string; applied: number; abstained: number }[];
  verdict: 'verified';
  findingsSummary: { new: number; carried: number; fixed: number; unverified: number };
  activeWaivers: number;
  signature?: string; // reserved for later signed attestation; unused today
  mintedAt: string;
}

// ---- the whole serializable output ----
export interface Result {
  schemaVersion: 'usabl.result.v1'; // versioned contract; every projection echoes it
  verdict: Verdict | null; // null when idle or fail-open disclosure; never a hidden extra verdict
  summary: string;
  screens: ScreenScan[];
  coverage: Coverage;
  findings: Finding[];
  receipt: Receipt | null;
  dirtyGuardedPaths: string[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  // Accessibility outcome with policy divergence ignored. The gate mints this so CI
  // can split enforcement without GitHub or the workflow inventing a verdict.
  // Never approval_required and never exit 2. Crash runs use exitCode 4 and leave these as null / 4.
  accessibilityVerdict: AccessibilityVerdict | null;
  accessibilityExitCode: AccessibilityExitCode;
  // Count of floor entries whose barrier this run did not observe on a cleanly scanned screen.
  // Not a count of fixes: absence is what a paid-down barrier looks like and equally what a table
  // rendering no rows looks like, and nothing here can tell the two apart. These are the entries a
  // floor prune would remove. run() does not modify the floor; pruning does. This is projection
  // only; the gate never consumes it and it never influences a verdict.
  paidDownCount: number;
  // Floored identities where the floor records more barriers than this run observed, so the floor
  // is ahead of the application. Why is not knowable from here: barriers may have been fixed, or
  // the page may render fewer rows today. Surfaces report the two counts and leave the cause to
  // the operator. Required, never optional: an absent field would read as "no headroom", and a
  // disclosure that can go missing is not a disclosure.
  // Projection only. The gate never consumes it and it never influences a verdict.
  floorHeadroom: FloorHeadroom[];
}
// exitCode: 0 verified or nothing-to-check; 1 regression; 2 approval_required;
// 3 not_covered; 4 unhandled error (fail open with disclosure);
// 5 reserved for an opt-in judgment soft-gate (off by default). The default install never emits 5.

// ---- conformance summary: a NON-GATING projection of Result, never a single score ----
// Always shows every bucket side by side; never hides the not-evaluated denominator. The gate
// verdict stays the authority; this is a read-only view for CI comments and the ACCESSIBILITY.md row.
export interface ConformanceSummary {
  verdict: Verdict | null; // echoes Result.verdict (the gate is the authority)
  // Whether this run stops the work, read from the exit code the gate wrote. Not recomputed from
  // the findings: while it was, a run held at not_covered by a new unconfirmed finding reported
  // "blocked: no" directly under a NOT COVERED heading.
  blocked: boolean;
  deterministic: {
    // Every new deterministic finding, which is what the gate counts and what the surfaces list.
    // The failing and unconfirmed split is reported beside it, never instead of it: while `new`
    // held failures only, the pull request comment printed "new 1" above a list of three.
    new: number;
    newFailing: number;
    newUnconfirmed: number;
    carried: number;
    waived: number;
    fixed: number;
  };
  judged: { modelJudgment: number; preview: number }; // advisory provenance; never gates
  notEvaluated: { unresolvedFiles: number; gaps: number };
}

// ---- evidence floor + waivers ----
export interface FloorEntry {
  screenId: string;
  layer: string; // contest: 'axe' | 'pf' | 'walk'
  rule: string;
  elementKey: string | null;
  identityBasis: IdentityBasis;
  count: number; // observed barriers at this identity; version 1 floors only recorded it for count basis
}
export interface EvidenceFloor {
  // Version 1 recorded a literal 1 for name and structural entries, so those counts prove nothing.
  // Version 2 records the observed count for every basis, so the gate can compare all of them.
  version: 1 | 2;
  // Present and 'partial' only when `usabl baseline --partial` wrote a floor from a subset of the
  // application, the screens that were cleanly scanned. A complete whole-application floor omits
  // this field entirely, so its bytes stay identical to floors written before this field existed.
  // No consumer changes behavior on scope. It is a label a reader can see in the committed file.
  scope?: 'partial';
  entries: FloorEntry[];
}
export interface Waiver {
  rule: string;
  surface: string; // matches Finding.screenId
  scope: string; // matches Finding.elementKey, or '*' for the whole rule on the surface
  reason: string;
  owner: string;
  approvedBy: string;
  created: string; // ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ)
  expires: string; // ISO-8601 UTC; ignored once past
}
export interface WaiverLedger {
  version: 1;
  waivers: Waiver[];
}

// ---- interaction contracts (frozen now; voicing lane consumes later) ----
export interface Step {
  do: string;
  [key: string]: unknown;
}
export interface StepRunner {
  run(page: Page, steps: Step[]): Promise<TranscriptStop[]>;
}
export interface SpeechObligation {
  class: string; // promotion keys on this
  afterStep: number; // index into steps; checked only in that step's window
  requiredTokens: string[]; // semantic name/role/state/consequence tokens
  focusedRole?: string;
  mustAnnounce: boolean; // true = consequence must reach a live region (structural gate)
}
export interface InteractionContract {
  contractId: string;
  surfaceId: string;
  task: string;
  steps: Step[];
  obligations: SpeechObligation[];
  maxTabPath?: number;
}

// ---- design intake + docs output (producers wired; reachable via `usabl docs` and the usabl/docs export) ----
export type RequirementKind = 'content' | 'flow' | 'doc';
export interface ContentAssertion {
  type: 'content';
  selector: string;
  expectedText?: string;
  mustNotBe?: 'decorative' | 'empty';
}
export interface FlowAssertion {
  type: 'flow';
  steps: Array<{ do: string; [key: string]: unknown }>;
  expectedAnnouncement?: string;
}
export interface DocAssertion {
  type: 'doc';
  artifact: 'alt-text-manifest' | 'announcement-snippets' | 'keyboard-paths';
}
export interface Requirement {
  id: string;
  kind: RequirementKind;
  surface: string;
  description: string;
  assertion: ContentAssertion | FlowAssertion | DocAssertion;
  owner?: string;
  approved: boolean;
}
export interface RequirementBundle {
  version: 1;
  requirements: Requirement[];
}
export interface DocArtifact {
  kind: 'alt-text-manifest' | 'announcement-snippets' | 'keyboard-paths';
  surface: string;
  entries: Array<{
    element: string;
    content: string;
    status: 'draft' | 'approved';
    evidenceRef?: string;
  }>;
  generatedAt: string;
  boundToReceipt?: string;
}

// ---- injected dependencies (all I/O enters here; run() has none of its own) ----
export interface AxNode {
  name: string | null;
  role: string | null;
  states: Record<string, unknown>;
}
export interface ElementRef {
  selector: string;
}
// One answer to a fetch or XHR request the page made, as the network tracker recorded it.
export interface ApiResponse {
  url: string;
  status: number;
  // The Content-Type header the answer carried, as sent, or null when it carried none. An HTML
  // answer is a page, such as a sign-in page or a history fallback, not the data that was asked for.
  contentType: string | null;
  // Whether the request was sent before Page.markWalkStart, so before usabl pressed a key or ran a
  // check. Its answer can arrive later. True for every request until the mark is set. A request the
  // tracker never saw sent reads as false once the mark is set, because nothing dates it.
  sentBeforeWalk: boolean;
}
export interface Page {
  gotoReady(): Promise<void>;
  // Where the browser actually is now, which is not always where it was sent. An application can
  // answer a request for a screen with a redirect, and a scan that never asks has no way to know
  // it measured a different page. Read it after the screen has loaded and before anything on the
  // page is exercised, because providers click and press keys and a click can navigate.
  currentUrl(): Promise<string>;
  // Every response to the page's own data requests (fetch and XHR) since navigation, in arrival
  // order, with its status. This is what lets a refused request be read against what came after
  // it, and what a declared readiness response is looked up in. Documents and assets are left
  // out, because an authentication wall answers 200 to those too. Empty means no data response was
  // seen, which is not proof that none was sent: one still in flight at the read is not here.
  apiResponses(): Promise<ApiResponse[]>;
  // Marks the moment before the keyboard walk begins. A data request sent after it was caused by
  // usabl or arrived during the checks, so it never counts toward the screen's readiness response.
  // A request sent before it counts whenever its answer arrives. Only the first call sets the mark.
  markWalkStart(): Promise<void>;
  // URLs of the page's own data requests (fetch and XHR) that came back 401 between navigation and
  // the moment this is read. A single page application that stays at the requested address and
  // swaps in a login form leaves no trace in the URL and may not have rendered the form yet, so
  // this is the one signal that does not depend on the address or the DOM. It is NOT free of a
  // timing race: an application slower than the readiness settle has sent nothing when a first
  // read happens, which is why the check runner reads it again at the end of the scan. A 401 that
  // arrives after that last read is never seen. 401 only: 403 means authenticated and not
  // permitted. Empty means no refused request was seen, which is not proof the session worked.
  unauthorizedApiRequests(): Promise<string[]>;
  // How many elements match a selector anywhere in the page: every frame, and inside open shadow
  // roots. document.querySelectorAll sees neither, so a login form in an iframe or a web component
  // is invisible to queryAll. This makes no claim about where the matches are, only how many.
  countEverywhere(selector: string): Promise<number>;
  focusBody(): Promise<void>;
  tab(): Promise<void>;
  press(key: string): Promise<void>;
  click(selector: string): Promise<void>;
  activeElementIs(selector: string): Promise<boolean>;
  activeElementWithin(selector: string): Promise<boolean>;
  armAnnouncementCapture(): Promise<void>;
  drainAnnouncements(): Promise<string[]>;
  activeNode(): Promise<AxNode | null>;
  activePath(): Promise<string>;
  axAt(selector: string): Promise<AxNode | null>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  queryAll(selector: string): Promise<ElementRef[]>;
  close(): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  setZoom(percent: number): Promise<void>;
  setReducedMotion(enabled: boolean): Promise<void>;
  getComputedStyle(selector: string, property: string): Promise<string>;
  screenshot(selector?: string): Promise<Buffer>;
}
export interface BrowserDriver {
  open(url: string): Promise<Page>;
  close(): Promise<void>;
}
export interface GitReader {
  writeTree(): Promise<string>;
  show(ref: string, path: string): Promise<string | null>;
  statusZ(): Promise<Array<{ code: string; path: string }>>;
  // Triple-dot diff reports merge-base -> HEAD changes, which keeps CI coverage honest on clean checkouts.
  diffNameOnly(ref: string): Promise<string[]>;
  lsTree(ref: string, paths: string[]): Promise<Record<string, string>>;
  lsFiles(ref: string, prefix: string): Promise<string[]>;
  headRef(): Promise<string>;
}
export interface FsGlob {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
}
export interface CheckRunner {
  // profile picks the per-surface provider configuration for this scan target. Absent means 'app'.
  scan(screen: { id: string; url: string; profile?: ProfileName }): Promise<ScreenScan>;
}
export interface Deps {
  clock: () => string;
  browser: BrowserDriver;
  git: GitReader;
  fs: FsGlob;
  checkRunner: CheckRunner;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  // The design-intake bundle loaded once at build time (trusted-ref overlaid). The docs surface
  // reads this exact bundle so it never re-derives intake or drifts from what the run enforced.
  requirements: RequirementBundle;
}

// ---- config (operator file; engine does not hardcode origins) ----
export interface NoiseBudgetConfig {
  // Default maximum finding groups shown on bounded surfaces. Absent means 5.
  default?: number;
  // Per-screen overrides for calibration on large PatternFly surfaces. Each key is a screen id,
  // matched against one by exact comparison, so every key is checked against the shared id
  // grammar when the config is read.
  perSurface?: Record<string, number>;
}

// The object form of a surface's readiness signal. At least one part is declared.
export interface ReachedWhenSignal {
  // A CSS selector that must match at least one element in the rendered page. The string form of
  // reachedWhen is shorthand for this part alone.
  selector?: string;
  // A URL path, such as "/api/users". It holds when a fetch or XHR request the page made to the
  // application's own host (the appBaseUrl hostname or a subdomain of it, any scheme or port)
  // answered with a 2xx status, and the request path is this path or continues it after a slash.
  // The query string is not compared. A document or asset response never counts.
  response?: string;
}

export interface SurfaceConfig {
  id: string;
  url: string;
  files: string[];
  // Optional readiness signal: positive evidence that this screen really rendered. Either a CSS
  // selector string, or an object with a selector, a response path, or both. Every declared part
  // has to hold once the screen has loaded and the walk has run. If one does not, the screen is
  // marked unseen and its findings are dropped. Absent means the body-only floor and the session
  // rules are the only unseen detectors for this surface. See ReachedWhenSignal for each part.
  //
  // A signal that holds also overrides the password-field rule in providers/redirected.ts, and it
  // is what lets a refused request the application recovered from stand, so what it names
  // matters. This is operator-supplied policy, not independent proof: a selector aimed at a
  // persistent application shell, a header, a navigation, or a footer is present on a login wall
  // too, and it will let a wrong page through. Name content only this screen has, such as that
  // screen's own table, heading, or empty state, or a data request only this screen makes.
  reachedWhen?: string | ReachedWhenSignal;
  // Declares that this surface is the same screen as the discovered route with the same id, and
  // exists to control that screen's scan URL. Surface ids and route screen ids are one namespace,
  // so without this the planner cannot tell an intended URL override from two different screens
  // that happen to share a key, and sharing a key silently drops one of them from the scan. It is
  // only needed when the surface URL differs from the route's own URL: an identical URL is the
  // same screen on its face and needs no declaration. Absent means false.
  overridesDiscoveredRoute?: boolean;
}
export interface UsablConfig {
  appBaseUrl: string;
  uiFileGlobs: string[];
  discovery: { routerFile: string; wideBlastGlobs: string[] };
  surfaces: SurfaceConfig[];
  requirements?: string;
  // Guarded paths can be files or directories. The trust guard expands directories so
  // edits cannot hide in newly added files under a listed prefix.
  guardedPaths: string[];
  promotedObligations?: string[]; // empty by default; listed classes may become deterministic voicing misses; the engine never writes this list
  // Whole-milliseconds budget for one screen to navigate, go quiet, and stop rendering. It lives
  // in operator config because how long an application takes to render is a property of that
  // application, not of the engine. Absent means the engine default.
  readyTimeoutMs?: number;
  // Caps how many finding groups bounded surfaces show before collapsing by rule.
  noiseBudget?: NoiseBudgetConfig;
}

export type Capability = 'live' | 'network' | 'secrets' | 'filesystem-write';

// The provider configuration a scan target selects. One run scans both surfaces, so the profile
// rides per scan target, not per run. Absent means 'app'; each provider reads ctx.profile ?? 'app'.
export type ProfileName = 'app' | 'docs';

export interface ProviderContext {
  page: Page;
  screen: { id: string; url: string };
  config: UsablConfig;
  profile?: ProfileName;
}

export interface Provider {
  id: string;
  layer: string;
  capabilities: Capability[];
  // Set when the provider clicks triggers or presses keys during its run. Every provider that runs
  // after one of these sees a page that is no longer the page the browser loaded.
  mutatesPageState?: boolean;
  // Set when the provider's evidence only holds on the page as it loaded, such as a walk of the
  // real focus order. Running it on a changed page yields thin or empty results that read as clean.
  requiresPristinePage?: boolean;
  run(ctx: ProviderContext): Promise<Draft[] | ProviderOutput>;
}

// A provider that knows which rules applied returns them beside its drafts, from the same run.
// The union keeps providers with nothing to report on the plain Draft[] return, and it keeps
// applicability out of a second method: axe computes both in one analyze() call, and asking
// twice would mean a second full axe run per screen.
export interface ProviderOutput {
  drafts: Draft[];
  applicability?: RuleApplicability[];
  // A provider that isolates its own checks returns a disclosed gap for each check that failed,
  // so one failing check is scoped and named instead of dropping the whole provider's drafts.
  // runProviders merges these with the gaps it raises itself. Absent means the provider reported
  // no per-check failures, which is the honest reading of a provider that never sets it.
  gaps?: CoverageGap[];
}

export interface ProviderRunResult {
  drafts: Draft[];
  gaps: CoverageGap[];
  applicability: RuleApplicability[];
}

// ---- gate I/O ----
export interface GateInput {
  coverage: Coverage;
  guardDivergedPaths: string[];
  drafts: Draft[];
  floor: EvidenceFloor;
  waivers: Waiver[];
  now: string; // clock() value, for waiver expiry
  // Screen ids the run measured with no coverage gap. A floored identity may be marked `fixed`
  // only when its screen is in this set, because a cleanly scanned screen with no barrier and a
  // screen nobody scanned both produce zero drafts, so absence of a draft alone cannot tell them
  // apart. Required, never optional: the gate must always be told which screens it may claim a
  // paid-down `fixed` about, so a caller cannot leave the question unanswered and get a false green.
  cleanlyScannedScreens: ReadonlySet<string>;
}
export interface GateOutput {
  verdict: Verdict | null;
  findings: Finding[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5; // 5 reserved; default install never emits it
  summary: string;
  accessibilityVerdict: AccessibilityVerdict | null;
  accessibilityExitCode: AccessibilityExitCode;
  // A floor that predates barrier counting, whose placeholder counts cannot be compared at all.
  // The gate counts the floor, so only the gate can find this, and it has already weighed it into
  // the verdict and named it in the summary. A caller that assembles a Coverage for the Result
  // appends these so the gaps a reader sees match the gaps the verdict was reached from.
  floorGaps: CoverageGap[];
  // Floored identities the floor is ahead of. Disclosure only: this never moves the verdict.
  floorHeadroom: FloorHeadroom[];
}
