# usabl: consolidated design

Status: working draft. Author: eparenti. August 2026.

This is the project ground truth for the usabl product. It replaces shared-design.md,
contest-build-plan.md, and team-work-plan.md with one document that includes the
check-agnostic core, evidence labels, design intake, Reports, and the on/off
adoption model.

This document describes usabl v0.2.1: an Apache-2.0 accessibility proof engine, published
as ESM, requiring Node >=22, with a single bin `usabl` mapped to `./dist/cli.js`. Where
this document and the source disagree, the source is authoritative.

---

## 1. Product thesis and name

**Name:** usabl. Tagline: "usable by default." Supporting line: "don't ship until
it's usabl."

**Problem.** AI tools now write a large share of UI screens, and they often build
things a screen reader cannot use. A scanner on its own points out problems; it does
not confirm a fix worked, and on its own it does not stop the AI from calling work "done"
when a screen reader still cannot use it. Meanwhile, James uses a screen reader daily
and waits releases for fixes. Priya builds the UI with great intentions but misses
things because it is hard to know everything.

**What usabl is.** A proof engine for accessibility in product development workflows.
It checks whether the screens mapped from the changed UI files have any machine-checkable
accessibility barrier that is new against a reviewed evidence floor and not covered by an
active waiver, before work can be called done. When it checked something, it gives one of
four answers (a run that checked nothing, or that crashed, gives no verdict; see below):

| Verdict | Meaning |
|---|---|
| `verified` | No new distinguishable identity, and no count growth at a recorded one, under the reviewed floor and outside active waivers, on the screens mapped from the changed UI files. |
| `regression` | A new problem appeared. |
| `not_covered` | Could not identify or exercise what the change touched. |
| `approval_required` | Policy changed; the tool will not judge itself. |

The AI can suggest fixes. It does not get to grade its own work.

Idle is not a fifth verdict. When there is no UI-touching change, usabl allows with
an explicit informational outcome: `Result.verdict` is `null`, exit 0, no findings,
and `summary` says "nothing to check." `not_covered` means there *was* something to
prove and the tool could not. A change that touches no covered surface (no UI files,
and no documentation page under a `usabl.docs.json` manifest) is idle, not `not_covered`.

`verdict: null` is overloaded, so it is never treated as a verdict. It means either idle
(`coverage.nothingToCheck` is true, exit 0) or a crash and fail-open (exit 4, disclosed,
`nothingToCheck` false). The two are distinguished by `coverage.nothingToCheck`, not by
the null itself.

**The gate always decides. Surfaces choose whether to enforce.** Overlay and the
advisory lane display the Result without blocking. The stop hook enforces. CI
enforces only when the `usabl-required` check is a required status (branch protection or
a ruleset). On this repository it is required by the main-branch ruleset.

**One check, several places it shows up.** The same engine runs behind all of these.
Every surface is a thin wrapper over one CLI entry point that returns `Result`.

| Surface | Value (why it exists) |
|---|---|
| **CLI** | Run the full engine on demand: baseline a brownfield app, debug locally, CI invokes this, and the agent mid-task self-check (`usabl check` via Bash). Scanner-shaped entry, proof-engine semantics. |
| **Stop hook** | Block the AI's first stop on a blocking verdict unless a one-use bypass was issued. The headline. |
| **Overlay** | Show findings while hand-coding in the browser. Advises only. |
| **CI / PR comment** | Team-visible gate on merge. Policy read from the trusted base ref. |
| **Mid-task self-check** | Let the agent check itself while context is warm, before Stop. **CLI is sufficient** (Bash); MCP is an optional transport for discoverability (section 11.5). Stop still decides. |
| **Reports** | Publish approved accessibility artifacts (alt-text manifests, snippets, keyboard paths) bound to verified evidence. Command: `usabl docs`. |
| **Playwright helper** | Same check inside tests teams already run. |

Contest builds CLI, stop hook, overlay, CI, Reports, and mid-task self-check via
CLI. An MCP wrapper is optional contest scope (section 11.5); ship after the hero
loop is solid if discoverability matters.

**One engine, two target surfaces.** The table above is about *where the engine runs*.
On the other axis, *what it checks*, usabl covers two surfaces with the same engine and
one verdict, or none: the application UI (sections 7-8) and, since v0.2.1, the product's own
documentation pages (sections 3, 7.6, 8). Documentation checking is not a second product
or a separate command; it is the same `usabl check` run over a second set of scan targets.

---

## 2. What is new

The core idea: a scanner gives advice a human may or may not read. usabl's gate decides,
and the stop hook blocks the AI's first stop on a blocking verdict unless a one-use bypass
was issued, so a machine-checkable barrier that is new against the reviewed floor on the
mapped screens is not called done in silence. The overlay and the advisory lane still show findings without
blocking. That is display, not a second decision-maker.

The specific things that are new, each against what exists today:

1. It re-checks the change as well as finding the problem. usabl compares the next run
   against the floor and reports what it no longer observes. It observes absence; it
   does not witness the fix.
2. It discloses every gap it detected. It reports "we could not check this" as a real
   answer instead of quietly passing.
3. A verified answer can be re-checked. A verified receipt is bound to the exact source
   tree, policy, runner version, and scanner versions, and re-verification compares those
   bindings against the current tree without a re-scan.
4. It shows what a screen reader would actually say, on the change. Simulating
   screen-reader output is a gap the field names itself, and surfacing that
   announcement as re-checkable evidence on a code change is new. The preview is
   current-run today; an automated before/after diff against a base run is a planned
   follow-up, not a v0.2.0 claim.
5. It has rules for our design system. usabl ships composition rules for PatternFly,
   the design system our products use.
6. The rules cannot be silently weakened. Locally, policy edits are tamper-evident and
   leave a reviewable commit trail (`approval_required`). In CI with trusted-ref reads
   and required checks, policy tampering is blocked before merge.

What is honestly not new: general scanning exists, and blocking only new problems
against a baseline exists. The CLI can be invoked like a scanner on an existing
codebase (`usabl check`), but that is adoption plumbing, not the product claim. A
scanner reports findings; usabl decides a verdict, diffs against a floor, and its Stop
hook blocks the first stop on a blocking verdict (unless a one-use bypass was issued or the
host reports that continuation is already active). The design goal is putting all of
that into one loop that gates an AI on evidence you can re-check and that is grounded in
what a screen reader actually hears.

---

## 3. Scope

### Contest (built to full)

- The check-agnostic core (gate, coverage, guard, receipts, evidence labels).
- Three scan layers behind one provider interface: axe-core, PatternFly rulepack,
  pattern-aware keyboard walk.
- Surfaces: CLI, stop hook, overlay, CI/PR comment, Playwright helper, mid-task
  self-check (CLI). CI, overlay, and hooks all call the same engine core; no MCP
  surface is built.
- Reports (accessible docs output): generate alt-text manifests, announcement snippets,
  and keyboard paths, bound to the receipt.
- Evidence labels on every Draft (`evidenceClass`). During the contest everything is
  `deterministic`.
- Design intake: RequirementBundle schema and YAML normalize. Wiring intake-derived
  providers is in contest; ingesting Figma/CSV is a seam.
- Page capabilities wired in the deps interface (viewport, zoom, reduced motion,
  computed style, screenshot) even though default contest checks do not use them.

Overlay and Reports are in contest scope. They are not on the cut line. Mid-task
self-check is in contest via CLI. The MCP wrapper is optional: add it only if agent
discoverability in Claude Code matters more than protecting hero-loop time (section
11.5).

### Documentation checking (shipped in v0.2.1)

usabl checks two target surfaces, not one: the application UI and the product's own
documentation pages. This shipped in v0.2.1, after the contest scope above was written,
and it reuses the same engine rather than adding a second product. One `usabl check`
run scans both surfaces and returns one verdict, or none; there is no separate docs command and
no `--docs` check flag.

- Activation: a `usabl.docs.json` manifest. Absent means no docs surface; present means
  the run scans the pages it lists. The manifest is a guarded policy file.
- Profile: each scanned documentation page carries `profile: 'docs'`. Providers read
  `ctx.profile ?? 'app'` and adjust (section 7.6): axe-core scopes to the WCAG 2.2 AA
  tag set, the docs-content rulepack adds `docs-heading-order`, the keyboard walk runs
  unchanged, and the PatternFly rulepack is a no-op.
- Coverage: a changed `.adoc` file maps to the pages whose source closure includes it,
  built from real `include::` transclusions (section 8). Unmapped `.adoc` files are
  honest `not_covered`, not silent passes.
- Source-aware findings: a finding on a rendered page is mapped back to its AsciiDoc
  source so a writer sees the fix in their own markup, not a DOM selector. The mapping
  is presentation-only and never gates.
- Onboarding: `usabl init --docs` drafts the manifest for a detected docs format
  (Pantheon/modular AsciiDoc, OpenShift AsciiBinder); `usabl install --docs-ci` writes
  a docs gate workflow; `usabl baseline` floors existing docs debt alongside UI debt.

Do not confuse this with Reports (section 14): checking scans docs for barriers, while
Reports generates publishable artifacts from a verified run.

### Bloat-proof rule

Add a surface or provider only when it solves a problem nothing else solves. Every
surface wraps `run()` → `Result`; it does not reimplement gate logic. If two surfaces
would show the same Result the same way, keep one. Post-contest seams are documented
so the architecture is extensible; they are not a commitment to build everything.

**Explicitly out:** IDE extensions and LSP diagnostics. The dev-server overlay covers
hand-coding in the browser; the CLI covers on-demand runs. A separate editor plugin
duplicates both without a new verdict path.

### Stretch (deterministic, contest if the core is solid)

- Visible focus indicator (WCAG 2.4.7).
- Reduced motion respected (preference injection; not a 2.2 A+AA row of its own).

Do not add these to the fixture oracle. Delete them if they destabilize the loop.

### Easy to add after the contest (deterministic checks we can call verified)

- Text resize and reflow at 200 percent.
- Target size for touch and pointer.
- Consistent navigation across screens.
- Captions present.

Each is a new provider returning `Draft[]` with `evidenceClass: 'deterministic'`.
The page capabilities are already wired; adding a check never touches the gate.

### Advisory lane (model-judgment, never verified)

A separate, clearly labeled lane where a model judges meaning and a person decides:

- Plain language and reading level.
- Whether alt text actually says something useful.
- Whether link text, headings, and error messages are clear.

These produce `Draft[]` with `evidenceClass: 'model-judgment'`. They are surfaced in
the overlay, the PR comment, and the CLI. They never block. They never produce
`verified`. A person decides.

### What this product will never do

- Certify legal or regulatory compliance. It supports the work, it does not sign it off.
- Detect seizure risk from flashing. That is frame-by-frame signal analysis, a
  different tool.
- Prove application logic like time limits, which it does not run over time.
- Replace a real screen-reader user or an accessibility expert. It shrinks what a
  human must check, it does not remove the human.
- Claim a screen is accessible for everyone. It verifies what its checks cover, on
  the screens it checked, and says which is which.

---

## 4. Architecture

### Five architectural decisions

These make "easy to add later" real. They are non-negotiable constraints on the build.

1. **Keep the deciding part simple and general.** The gate, coverage, guard, and
   receipt engine works with nothing more than a plain list of Drafts. It does not know
   or care what kind of problem a Draft describes. Adding a new kind of check never
   means touching the part that decides the answer.

2. **Every check just reports problems. Only the core decides.** A screen-reader check,
   a contrast check, and a future layout check all hand back the same shape: `Draft[]`.
   None of them gets to decide the verdict. That stays with the gate.

3. **Label each problem with what kind of evidence it is.** On every Draft, a label:
   `deterministic` (a hard, repeatable check), `preview` (an approximation that is
   useful in the loop but is not a screen reader), `model-judgment` (an AI model's
   assessment), or `human-confirmed` (something a person verified). `preview` is a
   fourth provenance class, not a fifth verdict. Word-matching announcement drafts are
   `preview` by default. A human can promote a listed class in config; the engine never
   promotes itself.

4. **Only deterministic checks can produce a verified.** The gate filters on
   `evidenceClass` before computing the verdict. Preview, model-judgment, and
   human-confirmed findings are surfaced but never count toward or against `verified`.
   One of them can never slip into a verified answer by accident.

5. **Give the page tool a few extra abilities now.** Even though we will not use them
   for the contest, the Page interface supports changing the zoom and window size,
   reading computed styles, taking a screenshot, and enabling reduced-motion preference.
   Setting these up now is what makes later checks cheap to add.

### Module map

This is the actual source layout as built for v0.2.1. Dedup is not a separate module;
it runs inside the gate (see section 9). There is no built MCP surface (section 11.5);
an MCP wrapper stays an optional transport.

```
src/
  contracts/        index.ts
  primitives/       canonical.ts identity.ts iso8601.ts match-glob.ts neutralize.ts slug.ts sortKey.ts
  deps/             build.ts real.ts fakes.ts fs.ts git.ts
  providers/
    axe/            index.ts notes.ts
    rulepack/       index.ts probes.ts selectors.ts pf-<one-file-per-static-rule>.ts
    docs-rulepack/  index.ts heading-order.ts
    keyboard-walk/  index.ts steps.ts
    check-runner.ts index.ts
  evidence/         receipt.ts floor.ts
  coverage/         import-graph.ts planner.ts route-manifest.ts docs-manifest.ts docs-planner.ts asciidoc-include-graph.ts
  gate/             index.ts
  trust/            guard.ts
  intake/           schema.ts normalize.ts load.ts config.ts trusted-config.ts map-to-providers.ts overlay-fs.ts
  docs/             alt-text-manifest.ts announcement-snippets.ts keyboard-paths.ts evidence-binding.ts source-map.ts
  output/           conformance.ts summary.ts
  doctor/           index.ts
  drift/            routes.ts
  floor/            prune.ts
  init/             index.ts docs/index.ts docs/asciidoc-modular.ts docs/asciibinder.ts
  baseline/         index.ts
  install/          overlay.ts claude.ts ci.ts branch-rule.ts index.ts
  voicing/          voicing.ts structural.ts virtual-sr-provider.ts normalize.ts   (built, not wired; section 7.5)
  measure/          fleet-insights.ts   (measurement-only; not in the run/gate path; section 25)
  surfaces/
    cli.ts pr-comment.ts policy-enforce.ts scrub.ts receipt-store.ts
    stop-hook.ts stop-hook-runner.ts stop-hook-bin.ts
    vite-plugin.ts overlay-client.ts playwright-helper.ts
    self-check.ts docs.ts docs-html.ts
  run.ts cli.ts cli-bin.ts index.ts
fixtures/
test/
usabl.config.json
usabl.routes.json
usabl.docs.json
.usabl-evidence.json
.usabl-waivers.json
.github/workflows/usabl.yml        (engine dogfood CI: gitleaks, pre-commit, semgrep, npm run check)
.github/workflows/usabl-gate.yml   (engine PR gate; see section 11.4)
```

### Check-agnostic data flow

```
Providers (axe, rulepack, docs-rulepack, walk, intake-derived, future)
    │
    │  each returns Draft[] with evidenceClass
    ▼
Gate (the single verdict authority)
    │  filters: only evidenceClass=deterministic counts
    │  applies: identity, dedup across layers, differential, waivers
    │  computes: verdict
    ▼
Result (the whole serializable output)
    │
    ├── CLI (run on demand; all other surfaces call this)
    ├── Stop hook (block/allow)
    ├── Overlay (show; same engine, does not block)
    ├── CI/PR comment (comment; block merge when required)
    ├── Playwright helper (return Result)
    ├── Mid-task self-check (CLI; optional MCP transport)
    └── Reports (publish artifacts)
```

---

## 5. Contracts

These are the shapes that cross module boundaries. Freeze them day 1. Every list is
sorted by a stable key before it is hashed or snapshotted.

```ts
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
// Evidence class is provenance, not authority. Preview and model-judgment never gate.
export type EvidenceClass =
  | 'deterministic'
  | 'preview'
  | 'model-judgment'
  | 'human-confirmed';
export type Verdict = 'verified' | 'regression' | 'not_covered' | 'approval_required';
export type AccessibilityVerdict = Exclude<Verdict, 'approval_required'>;
export type AccessibilityExitCode = 0 | 1 | 3 | 4;
export type FactSource = 'ax-tree' | 'attribute';
export type IdentityBasis = 'name' | 'structural' | 'count';

export interface Fact<T = string | null> {
  value: T;
  source: FactSource;
  fromTree: boolean;              // not the verdict word `verified`
}

export interface EvidenceFacts {
  name?: Fact;
  role?: Fact;
  state?: Record<string, Fact<unknown>>;
  extra?: Record<string, unknown>;
}

export interface Draft {
  rule: string;
  layer: string;                  // open; contest uses `axe` | `pf` | `walk`
  severity: Severity;
  evidenceClass: EvidenceClass;   // the seam
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

export interface Finding extends Draft {
  elementKey: string | null;      // null when identityBasis is `count`
  identityBasis: IdentityBasis;
  status: 'new' | 'carried' | 'fixed' | 'waived';
}

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

export interface ScreenScan {
  screenId: string;
  url: string;
  stops: TranscriptStop[];
  drafts: Draft[];
  gaps: CoverageGap[];
}

export interface AffectedScreen {
  screenId: string;
  url: string;
  provenance: 'route-graph' | 'wide-blast' | 'manual';
  importChain?: string[];
}

export interface CoverageGap {
  ref: string;
  state: 'unresolved' | 'not-covered' | 'skipped' | 'capability-denied';
  reason: string;
}

export interface Coverage {
  changedFiles: string[];
  affected: AffectedScreen[];
  unresolvedFiles: string[];
  gaps: CoverageGap[];
  nothingToCheck: boolean;        // no UI-touching files; not a verdict
}

export interface Receipt {
  schemaVersion: 1;
  sourceTree: string;
  baseRevision: string | null;
  policyHash: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  surfaces: string[];
  coverage: { checked: string[]; notCovered: string[] };
  verdict: 'verified';
  findingsSummary: { new: number; carried: number; fixed: number; unverified: number };
  activeWaivers: number;
  signature?: string;             // reserved for later signed attestation; unused today
  mintedAt: string;
}

export interface Result {
  schemaVersion: 'usabl.result.v1';
  verdict: Verdict | null;        // null when idle or fail-open disclosure
  summary: string;                // for idle: "nothing to check"
  screens: ScreenScan[];
  coverage: Coverage;
  findings: Finding[];
  receipt: Receipt | null;
  dirtyGuardedPaths: string[];
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  accessibilityVerdict: AccessibilityVerdict | null;
  accessibilityExitCode: AccessibilityExitCode;
  paidDownCount: number;          // floor entries whose barrier this run did not observe on
                                  // a cleanly scanned screen; not a count of fixes;
                                  // projection only, never gates
}

// exitCode: 0 verified or nothing-to-check; 1 regression; 2 approval_required;
// 3 not_covered; 4 unhandled error (fail open with disclosure);
// 5 reserved for an opt-in judgment soft-gate (off by default). The default install never emits 5.
// accessibilityExitCode is the same scale without 2. CI uses it for the accessibility
// required check so an approved policy change can merge without turning the Result green.

// Design intake
export type RequirementKind = 'content' | 'flow' | 'doc';

export interface Requirement {
  id: string;
  kind: RequirementKind;
  surface: string;
  description: string;
  assertion: ContentAssertion | FlowAssertion | DocAssertion;
  owner?: string;
  approved: boolean;
}

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

export interface RequirementBundle {
  version: 1;
  requirements: Requirement[];
}

// Reports (accessible docs output)
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
```

---

## 6. Injected dependencies

The engine is a pure function over data plus this Deps object. Real implementations
live in `deps/real.ts`, in-memory fakes in `deps/fakes.ts`. Every test runs on fakes.

```ts
export interface Deps {
  clock: () => string;
  browser: BrowserDriver;
  git: GitReader;
  fs: FsGlob;
  checkRunner: CheckRunner;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  requirements: RequirementBundle; // intake bundle loaded once at build time (trusted-ref overlaid)
}

export interface BrowserDriver {
  open(url: string): Promise<Page>;
  close(): Promise<void>;
}

export interface Page {
  gotoReady(): Promise<void>;
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
  // Capabilities wired for future checks (not used by contest providers)
  setViewport(width: number, height: number): Promise<void>;
  setZoom(percent: number): Promise<void>;
  setReducedMotion(enabled: boolean): Promise<void>;
  getComputedStyle(selector: string, property: string): Promise<string>;
  screenshot(selector?: string): Promise<Buffer>;
}

export interface AxNode {
  name: string | null;
  role: string | null;
  states: Record<string, unknown>;
}
export interface ElementRef { selector: string; }

export interface GitReader {
  writeTree(): Promise<string>;
  show(ref: string, path: string): Promise<string | null>;
  statusZ(): Promise<Array<{ code: string; path: string }>>;
  diffNameOnly(ref: string): Promise<string[]>; // merge-base..HEAD changed files
  lsTree(ref: string, paths: string[]): Promise<Record<string, string>>;
  lsFiles(ref: string, prefix: string): Promise<string[]>;
  headRef(): Promise<string>;
}

export interface FsGlob {
  readFile(path: string): Promise<string | null>;
  glob(patterns: string[]): Promise<string[]>;
}

export interface CheckRunner {
  scan(screen: { id: string; url: string }): Promise<ScreenScan>;
}
```

---

## 7. Scan layers (contest)

Three layers, one `Provider` interface. The gate does not know or care how many
providers exist.

```ts
export type Capability = 'live' | 'network' | 'secrets' | 'filesystem-write';

export interface ProviderContext {
  page: Page;
  screen: { id: string; url: string };
  config: UsablConfig;
}

export interface Provider {
  id: string;
  layer: string;
  capabilities: Capability[];
  run(ctx: ProviderContext): Promise<Draft[]>;
}
```

The rulepack does not use a separate `RuleModule` type. Each PatternFly rule is a plain
function `(ctx: ProviderContext) => Promise<Draft[]>` that the provider composes; see
section 7.2.

### 7.1 axe-core provider

Wraps axe-core so it returns `Draft[]`. It owns color contrast, alt text, and general
WCAG-mapped checks. A curated notes table overrides axe's default `why`/`fix` text for
common rules with plain-language PatternFly-specific guidance. Every Draft has
`evidenceClass: 'deterministic'`.

### 7.2 PatternFly rulepack

The provider id is `pf-rulepack` (layer `pf`). It emits eight named rules: six static
checks (one file per rule) and two interaction probes (`pf-focus-into-dialog` and
`pf-modal-focus-return`, both in `probes.ts`), all returning `Draft[]`:

1. `pf-toast-live-region`: toasts, alert groups, inline validation, and async table
   loading must sit in a role=status/alert/aria-live region that exists before the
   update.
2. `pf-modal-focus-return`: open a modal, press Escape, focus returns to the exact
   trigger.
3. `pf-focus-into-dialog`: focus moves into a dialog or menu on open.
4. `pf-kebab-expanded-state`: kebab and menu toggles carry correct aria-expanded and
   aria-haspopup, and focus enters the menu.
5. `pf-icon-button-name`: icon-only buttons, kebab toggles, and pagination arrows have
   an accessible name.
6. `pf-table-header-assoc`: table header association is present, and empty/loading
   states are announced.
7. `pf-row-action-name-unique`: row action buttons do not all share one accessible name.
8. `pf-toolbar-labeled-when-repeated`: a repeated toolbar is labeled so instances are
   distinguishable.

Each rule fires on the broken fixture, stays silent on the clean fixture, names the
exact control, gives a concrete fix, and carries a one-line "why a screen-reader user
is affected."

Fixture behavior alone is not enough. The fixture is written to satisfy the selectors,
so it cannot catch a selector that matches nothing on a real page. `selectors.ts` is
therefore also checked against markup rendered by PatternFly itself, held in
`fixtures/pf6/rendered-markup.html` and regenerated by `scripts/render-pf6-markup.mjs`.

`pf-modal-focus-return` and `pf-focus-into-dialog` carry a stated limit. PatternFly 6
puts no marker on a control that opens a modal: the modal comes from component state
and the trigger is an ordinary button. These rules therefore reach a modal only when
its trigger declares `aria-haspopup="dialog"`, or names the modal with `aria-controls`
and reports its state with `aria-expanded`. A modal opened by a bare button is not
checked. The probe will not click arbitrary buttons on a live screen to go looking for
one, because that would submit forms and delete records.

Cut line (dropped first if time runs short): 8, then 7 and 6. Protect 1-5.

### 7.3 Keyboard walk

Tab through the page and record/assert focus: the focused element's accessible name
and role at each step and after each interaction, read from the accessibility tree over
CDP. Bounded with a Tab cap around 200, cycle detection, a wall-clock ceiling, and
per-node partial tree reads.

Runs a small set of data-step kinds passed as data: `tab`, `press-escape`, `activate`,
and `assert-announced(region, contains)`.

Marks any focus it cannot confirm as `unverified` rather than passing. Does not hang
on a focus trap.

### 7.4 Declarative interaction probes

Multi-step interactions expressed as data (JSON steps a generic runner executes). A
step that cannot establish its fact emits `unverified`. Adding a new interaction check
needs no engine change, just data.

### 7.5 Voicing lane (built, not wired in v0.2.0)

The voicing lane lives under `src/voicing/` and is exported from the library
(`runStructuralTier`, `runVoicingTier`, `makeVirtualSrProvider`, `normalizeToken`,
`obligationSatisfied`). It is built and tested, but v0.2.0 does not import it into the
run, gate, or provider path, so it does not affect the v0.2.0 gate. The structural
tier checks whether a required announcement happened; the voicing tier compares the
words of the announcement and is `preview` evidence by default. The lane and its
calibration land in v0.3.0.

### 7.6 Documentation profile (docs-content)

The same providers run over product documentation pages when a scan target carries
`profile: 'docs'` (`ProfileName = 'app' | 'docs'`; absent means `app`, and each
provider reads `ctx.profile ?? 'app'`). The profile is threaded per scan target, so a
single run scans app screens and doc pages together and the gate returns one verdict, or none,
across both. There is no separate docs engine and no separate command.

Per-provider behavior on a docs page:

- **axe-core** runs scoped to the WCAG 2.2 AA tag set (`wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa`) instead of its full rule set, matching the Red Hat docs bar.
- **docs rulepack** (`id: docs-rulepack`, layer `docs-content`) contributes one static
  check, `docs-heading-order`: a rendered heading that jumps more than one level down
  is a `deterministic` fail, read from the accessibility tree. axe-core's own
  heading-order rule is tagged best-practice, not WCAG, so it never fires under the docs
  tag set; this rulepack fills that gap with doc-worded copy. It returns `Draft[]` and
  never mints a verdict.
- **PatternFly rulepack** is a no-op (`return []`): product docs are not a PatternFly UI.
- **keyboard walk** runs unchanged.

---

## 8. Coverage and discovery

### How it works

Given a set of changed files, discover which surfaces they affect:

1. Build a route manifest from the router source (or use a configured override).
2. Build a static import graph from each route's entry file (BFS over imports).
3. Match each changed file against the import-graph closures.
4. Wide-blast fallback: files matching `wideBlastGlobs` (global CSS, app shell, build
   config) affect every extracted route.
5. Manual surface globs in config are an additive fallback, never a replacement.
6. Anything resolving to nothing stays in `unresolvedFiles` and forces `not_covered`.

### Nothing to check vs not covered

Coverage answers two different questions.

**Nothing to check** (`coverage.nothingToCheck === true`): no changed files match
`uiFileGlobs`, and no changed file maps to a documentation page under a
`usabl.docs.json` manifest. There was nothing to prove. `Result.verdict` is `null`,
exit 0, and an explicit "nothing to check" message. A backend-only PR, a prose change
with no manifested doc page, and a clean tree with no diff are this path. This is not
`not_covered`. A change to an `.adoc` source that maps to a documentation page is a
docs-profile check, not idle (see below).

**`not_covered`:** UI files changed, and the tool could not identify or exercise what
they touched (unmapped file, unresolved import, screen failed to load, check
incomplete). That blocks. Idle and unmapped must never share a verdict.

If some UI files map and others do not, the run is `not_covered`. Partial proof is
not `verified`.

### Prove what you touch

Only changed files trigger checks. A file you did not touch is not a usabl problem
this PR. Coverage grows as the team works, not as a boil-the-ocean inventory.

### Documented limits

- Bundler aliases (`@/`, `~/`) are not resolved. They become `unresolvedFiles`.
- Computed import specifiers (`import(variable)`) are not resolved.
- Comment stripping is regex-based and imperfect.
- Routes not parseable from the router source must be configured or stay unmapped.

Those four are honest `not_covered` outcomes, not silent passes. The next section is not, and has
to be read differently.

#### Limits of reading routes out of router source

Routes are recovered from router source with regular expressions, not with a parser. That buys a
route manifest with no build step and no dependency on the application's toolchain, and the price
is that some declarations are read wrongly and some are not read at all.

A route the parser never sees is not a `not_covered` outcome. The planner records a gap only for
routes it knows about, so a route that was never recovered leaves no gap behind: a change to that
screen's entry file, or to a wide-blast file, can read as fully checked while the screen is never
scanned.

**The mechanism.** These patterns match raw text. They do not know which characters are code,
which are inside a string, and which are inside a comment. So a delimiter that appears anywhere
in the text is treated as a delimiter: a `>` ends a JSX tag, a `)` closes the `create*Router(...)`
call argument, and a quote opens or closes a path literal. One stray delimiter inside a string or
a comment can therefore end a tag or a call argument early and drop the declarations after it.
The reverse also holds: text that is not code, such as a commented-out route, is matched as
though it were.

The cases below are examples of that mechanism, not a complete list. Anything that puts a
delimiter where the pattern does not expect one can produce another.

- **A commented-out route is read as a route.** Commented text is matched like any other text. The
  route is added to the manifest, so usabl plans a scan of a screen the application does not
  serve. When a commented-out declaration and a live one carry the same path, which one survives
  depends on the path: the router fallback and the data-router reader keep the first match, so the
  commented one wins and a message that names a line names the commented line; `usabl init`'s JSX
  pass keys routes by path as it merges, so the last match replaces the earlier ones and the live
  route wins there.
- **A route whose `element` attribute is written before its `path` is not read at all.** The JSX
  pattern ends the tag at the first `/>`, which is the nested element's own self-close, so every
  attribute after the element is invisible and no path is found. Attribute order carries no
  meaning in JSX, so this is ordinary source. A file that writes every route this way yields no
  routes and no complaint.
- **A path written as an expression is not read.** Only a quoted literal is matched, so
  `path={ROUTES.home}` or `path={base + '/x'}` is skipped and that route is absent from the
  manifest.
- **A `>` anywhere in a JSX attribute string drops the whole route.** It ends the attribute run
  before the pattern reaches the tag's own close, and the tag stops matching. Both
  `<Route title=">" path="/hidden" element={<Live />} />` and
  `<Route path="/visible" title=">" element={<Live />} />` yield no routes. Putting the path first
  does not help.
- **A `)` anywhere inside the router call drops every route after it.** The call argument is found
  by counting raw parentheses, so an unmatched `)` in a comment or in an ordinary string, such as
  `{ path: '/first', label: 'a ) b' }`, closes the argument early and the entries that follow are
  never seen.
- **The first `create*Router(` in the file wins, wherever it is.** One written inside a string or
  a template interpolation is taken as the router call, and the real one below it is never read.

What an operator can do. Write the routes into `usabl.routes.json`. An authored sidecar takes
precedence over router-source discovery, so the manifest is exactly what that file says and none
of this applies. That is the reliable answer, and it is the only one that holds against every case
above. `usabl init` drafts the sidecar from these same patterns, so read the draft against the
router before merging it and add any route it missed. Changing the router source can also work,
by writing a quoted `path` literal outside any comment and keeping stray `>` and `)` characters
out of the strings in and around the declaration, but that depends on the whole file rather than
on the one route, so check the result instead of assuming it.

#### Limits of detecting that a screen was not reached signed in

A scan of a login-gated application can be handed the application's sign-in experience instead of
the screen it asked for, and score it as that screen. Measured on a real application with an
expired session: usabl filed the sign-in page's barriers under the requested screen ids, disclosed
nothing, and reported all twenty-nine barriers on the committed evidence floor as resolved. The
run was red only because that page carried barriers of its own; a clean one would have returned
verified, with a receipt, and a claim that the accepted debt was gone.

That application never leaves the requested address. It renders a blank shell for over five
seconds, then swaps a login form in at the same URL, so neither the address nor the presence of a
password field is reliable on its own. Its own API calls to identity endpoints answer 401.

Two layers now stand against this, and neither closes the hole completely.

**Before the browser opens.** When `USABL_STORAGE_STATE` names a file in which every cookie carries
an expiry, every one of those is already past, no origin holds local storage or IndexedDB, and
there are no stored credentials, there is nothing left in it that could authenticate. The run stops
with no verdict (exit 4). The bar is deliberately "nothing here could possibly work" rather than
"probably dead": one session cookie, one undated cookie, one IndexedDB entry, one local storage
entry, or one virtual authenticator credential means the file cannot be judged and is not refused.
Playwright restores all four of those stores, so any of them could be carrying the session. A
missed dead session is caught below; a false refusal has no backstop.

**At scan time.** Three rules, each producing a `not-covered` coverage gap on that screen. A gapped
screen contributes no findings, records no keyboard walk, and is excluded from the cleanly-scanned
set the gate is given, so no floored barrier on it can be reported as resolved.

- **Rule A, refused data requests.** A storage state is configured and at least one of the page's
  own `fetch` or XHR requests to the application's own hostname had answered 401 at either of two
  reads: the first when readiness settles, the second after the walk, the checks, the source
  attachment, and the reachability measurement have run. A refusal that arrives after the second
  read is not seen. This is the primary signal, because it needs nothing from the address or the
  DOM. Two reads, not one: readiness needs four equal DOM counts 500 ms apart plus 500 ms of
  network quiet, so a stable shell settles in about 1.5 s, and an application that sends its
  identity request later than that has sent nothing yet. Measured with the real adapter, a page
  fetching its identity endpoint at three seconds recorded nothing at the first read. The second read deliberately includes traffic the
  providers caused, because a request a provider click triggered is still the application answering
  this session. 401 only; 403 means authenticated and not permitted, which a correct signed-in scan
  can legitimately meet. Nothing overrides this rule.

  The host match. A refused request counts when its hostname equals the `appBaseUrl` hostname, or
  ends with a dot followed by it, regardless of scheme and port. So `api.example.com` counts for
  `example.com` and `notexample.com` does not. Comparing origins instead was too narrow in three
  ways that all happen in practice, and each was measured flowing through a real run to a verified
  receipt with a paid-down entry: a different port, a different scheme, and an API subdomain. When
  `appBaseUrl` does not parse there is no hostname to compare against, and then every
  page-initiated 401 counts. That is deliberate: a base URL usabl cannot read is a configuration it
  cannot reason about, and `not_covered` is the honest outcome where counting nothing would hand
  back a verdict.
- **Rule B, a password field anywhere.** A storage state is configured and a password input exists
  anywhere in the page, in any frame or inside an open shadow root. The address is not consulted.
  Overridden by `reachedWhen`: when the surface declares that selector and it is present at the
  time of the check, this rule does not fire. A change-password screen, or a settings page with a
  re-authentication prompt, is exactly the case the override exists for.
- **Rule C, redirected to a sign-in page.** The browser ended on a different address than the one
  requested and that page carries a password input. This applies whether or not a storage state was
  configured, because a redirect to a sign-in page is the wrong page either way.

The two session rules require a configured storage state because only that is an assertion that the
run is signed in. Without it a 401 and a login form are ordinary things for a signed-out visitor to
meet, and firing on them would turn every deliberate signed-out scan into a gap.

**`reachedWhen` is operator-supplied policy, not independent proof.** It is a CSS selector an
operator wrote, and usabl cannot check that it names what the operator meant. A selector that
matches a persistent application shell, a header, a navigation, or a footer is present on a login
wall too, so declaring one of those does not assert that this screen rendered; it asserts that the
application's chrome rendered, which it does on the sign-in page as well. Such a selector will let
Rule B pass the wrong page, and it will do it silently, because a matched selector reads as
success everywhere it is consumed. To be worth anything the selector has to name content only this
screen has: that screen's own table, its own heading, its own empty state. The config loader says
so when it refuses an empty value, because config load is the last place an operator reads anything
about this field.

That is also why the override does not extend to Rule A. A same-host 401 with a configured session
is the application itself saying the session was refused, which is stronger evidence than any
selector an operator wrote.

**What is still not caught.** A server-rendered sign-in page that makes no API calls and carries no
password input: a passkey prompt, a magic-link page, an email-first identity provider, or a consent
screen. An authentication wall that answers 200 to every request and renders a branded landing
page. A sign-in wall whose API lives on an unrelated hostname. A sign-in page served at the very
address that was requested, with no storage state configured. A 401 that arrives after the second
read, which is the last observation of the page before it is closed, so a response still in flight
at that moment is never recorded. And any screen whose `reachedWhen` selector matches a sign-in
page, per the paragraph above. The body-only detector catches the subset of these that render
nothing focusable; the rest stay open. The hole is narrower, not closed.

A miss leaves exactly the behaviour that was there before, so none of this manufactures a new false
green of its own. Each rule can also fire on a screen that was genuinely reached: a same-host
endpoint that answers 401 where it means 403, every page-initiated 401 when `appBaseUrl` cannot be
parsed, a signed-in screen with a password field and no `reachedWhen`, a stale configured URL. The cost of that is a coverage gap, so the run reports
`not_covered` rather than a verdict it should not have minted.

What an operator can do. Declare `reachedWhen` on the surface, naming content only that screen has.
It is the answer both for a screen these heuristics miss and for a screen Rule B fires on wrongly,
and it is only as good as the selector: see the paragraph above on what a shell selector costs.

#### A credential in a configured surface URL is echoed everywhere

Text that comes off the page is sanitized before it is published. A coverage gap reason strips the
userinfo, the query, and the fragment from every address it names, and shortens a refused request
to the front of its path, because any of those can carry a token.

Exactly what a refused request discloses, so a reader can judge the risk rather than trust the word
"shortened": the scheme; the complete hostname, as punycode when it was written in unicode; the
numeric port when the address carries one that is not the scheme default; and either of the first
two path segments, and only while a segment starts with an ASCII letter, is at most 24 characters,
and contains nothing but lowercase ASCII letters, digits, dot, underscore, and hyphen. Everything
from the first segment that fails those tests is dropped and the tail is marked with an ellipsis. A
unicode path segment fails the character test and is cut. The consequence to take on board: a
secret that is short, lowercase, and sitting in either of the first two path segments WILL be
printed. `/reset/<token>` is cut because a token is normally mixed case or long, not because the
position is protected.

Configured surface URLs are not page text and are not sanitized. `gap.ref`, `ScreenScan.url`, and
`coverage.affected[].url` carry the operator's own `usabl.config.json` value verbatim into the
Result, and from there into the CLI output, the overlay, and the pull request comment. That is
deliberate and predates the sanitizing above: the overlay attributes a gap to a screen by comparing
these values exactly, so rewriting one would silently orphan the gap it belongs to.

The consequence is a residual an operator has to know about. A credential written into a surface
URL, whether HTTP basic userinfo (`https://user:pass@host/screen`), a preview token in the query,
or anything in the fragment, will be echoed by every surface that renders a Result, including a
comment posted to a public pull request. Do not put one in `usabl.config.json`. Reach a protected
environment with a storage state, which never enters committed config, instead.

### Documentation coverage

When a `usabl.docs.json` manifest is present, coverage extends to documentation the same
way it extends to UI. The manifest lists each page with its published `url`, its owning
`assemblyFile`, and the full `sources` closure of AsciiDoc files that render into it:

1. A changed `.adoc` file maps to every page whose `sources` include it.
2. A file matching the manifest `sharedGlobs` is a wide blast across all pages.
3. An `.adoc` file that maps to nothing becomes an `unresolvedFiles` gap and forces
   `not_covered`, exactly like an unmapped UI file.

The source closure is built by following real `include::` transclusions
(`asciidoc-include-graph.ts`). It over-approximates (it does not evaluate `ifdef`/`ifeval`)
rather than guessing narrow, and it ignores includes shown as code blocks or comments.
Manifest paths are validated: a page `url` must start with `/`, reject `@` and
percent-encoded traversal, and `assemblyFile`/`sources` are `..`-rejecting repo-relative
paths.

### Source-aware findings

A finding on a rendered documentation page is mapped back to its AsciiDoc source after
the gate, presentation-only, by `mapFindingToSource` (`src/docs/source-map.ts`) in three
tiers:

- **renderer:** a `data-source-file` attribute (plus optional line) emitted by a
  cooperating Asciidoctor pass gives an exact file and line.
- **content:** match the rendered image, link, or heading text back to source for the
  file and construct (`image::`, `link:`, a `=` heading marker), without a line.
- **fallback:** attribute to the page's assembly file and disclose the whole source
  closure as candidates.

The mapping never throws and never gates. A writer sees the fix phrased in their own
markup, not a DOM selector; if the tool cannot place a finding, it says so.

---

## 9. Gate (verdict authority)

The single module that constructs a Verdict. No other module can. Overlay, mid-task
check, CI, and the Playwright helper present the Result; they never mint a verdict of
their own.

### Verdict computation

1. **Guard check first.** If any guarded path differs from the trust anchor, the
   verdict is `approval_required`. Affected UI still scans unless intake is
   malformed (the harness stays closed for unreadable requirements). Findings
   stay on the Result. No receipt. The gate also mints `accessibilityVerdict`
   and `accessibilityExitCode` (never 2) so CI can split policy approval from
   accessibility enforcement.
2. **Coverage.** If `nothingToCheck`, return `verdict: null`, exit 0, no browser, and
   a summary like "nothing to check (no UI-touching files)."
3. **Run checks.** For every affected surface, run providers, collect Drafts. Do not
   sample. If any affected surface cannot be fully exercised, `not_covered` - never
   mint a `verified` receipt on a partial scan.
4. **Filter by evidenceClass.** Only Drafts with `evidenceClass === 'deterministic'`
   participate in the verdict. Preview, model-judgment, and human-confirmed findings are
   surfaced in the Result but do not block or enable `verified`.
5. **Identity, dedup, differential, waivers.**
6. **Verdict priority order:**
   - Any new deterministic failure (`confidence: 'fail'`): `regression`.
   - Anything unverifiable (unreachable surface, incomplete check, unmapped file, or a
     new deterministic finding at `confidence: 'unverified'`): `not_covered`. Unverified
     is not a silent pass and is not a regression.
   - Everything else: `verified`.

   Status decides on both finding clauses, not just the failing one. A finding the
   evidence floor already accepted is `carried` and does not gate, whether it fails or
   could not be confirmed. Blocking on carried uncertainty would hold every large
   application at `not_covered` forever, because any real UI has some results a checker
   declines to judge and no work clears them. What stands between several barriers and one
   accepted entry is the recorded count, not the confidence, and it is a partial guard: see
   the residual section under Evidence floor. The floor
   stores how many barriers it accepted at an identity, and more than that comes back as
   `new` and blocks.

### Identity

Every Finding gets `{ screenId, layer, rule, elementKey, identityBasis }`.

Priority:

1. **name** - a stable accessible name from evidence (survives markup churn).
2. **structural** - role plus the element path with nth-child indexes stripped.
   Weaker than a name; stronger than a volatile CSS path.
3. **count** - identity-weak. No per-element key. Compare `{screenId, rule}` by
   count. The floor key omits layer so axe and PatternFly reports of the same
   defect can collapse.

Identity-weak rules are an allow-list of "this element has no accessible name" checks
(`button-name` from axe, `pf-icon-button-name`). You cannot honestly key an unnamed
element by name. A count increase is a regression. A named rule catches a swap that a
count cannot, but only when the two barriers key differently; one fixed and one newly broken
at the SAME collapsed identity leaves the count unchanged and is not caught. See the residual
section under Evidence floor.

Every basis can collapse several barriers onto one key, not just `count`. Two dialogs at
the same neutralized path share a structural key; two controls with the same accessible
name share a name key. So the floor records the observed barrier count for every entry and
the gate compares it for every basis: more than the floor accepted is `new`, equal or fewer
is `carried`. Fewer is never a regression. It is also not proof of progress: the same reading
comes from a page rendering fewer rows, which is why the surfaces report both counts and let
the operator say which happened.

Contest layer ids are stable (`axe`, `pf`, `walk`) so dedup and identity do not churn.
The field stays `string` so a later provider can add a layer without a gate change.

### Dedup

Collapse Drafts that share `rule` + identity across layers. Keep one Finding. Prefer
deterministic evidence, then the PatternFly why/fix when both axe and the rulepack fire on
the same control. Evidence class outranks layer because only deterministic evidence gates,
so a preview Draft must never be the survivor that represents a deterministic barrier.
Ranking by class first also makes the choice independent of the order Drafts arrived in.

Only deterministic Drafts are counted against the floor, because only deterministic Drafts
are what `usabl baseline` counted when it wrote the floor.

### Evidence floor

`.usabl-evidence.json` is the accepted deterministic finding set for a surface. A code
owner writes it in an `approval_required` accept commit. Advisory findings are never
written to the floor. The accept loop converges: after the acceptance commit lands, the
next unchanged run sees the same floor and settles to `verified` (or `not_covered` only if
coverage cannot be re-established).

The count comparison runs in both directions, and both are gate decisions:

- **Above the recorded count** is new debt. More barriers at a known identity than the floor
  accepted is `new`, which gates: `regression` for a definite failure, `not_covered` for one
  usabl could not confirm. A brand new identity is `new` the same way.
- **Below the recorded count** is not a regression. The findings present stay `carried` and the
  verdict does not move. The run discloses the difference on the summary line, which gains a
  `N floor entries ahead of this run` clause, and on the terminal and the overlay, which both
  print the screen, the rule and both numbers under the recorded group. This is disclosure, not a coverage gap, because a gap
  makes a run `not_covered` by definition.

  The disclosure states the observation and never the cause. usabl counted two numbers and cannot
  tell a paid-down barrier from a page rendering fewer rows today, so it says both readings and
  leaves the operator to pick: if the barriers were fixed, `usabl floor prune` re-arms the floor to
  what is present; if the page simply shows less content today, nothing needs to change.

### The residual hole, and why it is open

The recorded count is a high-water mark. `usabl baseline` writes it, `usabl floor prune` lowers it,
and nothing else moves it. Between a pay-down and a prune the floor claims more barriers at an
identity than are present, and that difference is headroom.

**A new barrier arriving at an identity with headroom is counted as `carried` until
`usabl floor prune` re-arms the floor.** It fills the slot the fixed barrier left, the tally stays
at or under what was accepted, and no comparison of counts can separate it from the debt that was
accepted. The same is true, without even the headroom, of a single change that fixes one barrier
and adds another at the same collapsed identity: the tally never moves at all. usabl discloses the
headroom on every run where it exists so an operator can re-arm, and it cannot disclose the
same-run swap because nothing about it is visible to a count.

usabl does not block on headroom, and that is a deliberate trade measured against a real
brownfield floor. Several collapsed identities on that application count icon buttons in table
rows, one entry standing at 15. The count therefore tracks how many rows the live application
renders, and a jobs list or a user list changes size on its own. Blocking on "below the recorded
count" would fail an unchanged codebase whenever a list came back one row shorter, the operator
would prune, and the next run with one more row would report a new barrier. A verdict that flaps
with row counts is worse than a disclosed hole, because a gate that cries wolf stops being read.

This is the price of collapsing several barriers onto one identity on pages whose content changes
size. Two things shrink it, and neither is a better count rule. **Strong element keys**: an
identity that keys each barrier separately never collapses and needs no count, so a name-basis or
count-basis identity is weaker here than a structural one, and a structural one is weaker than a
key that survives per element. **Prompt pruning**: headroom only exists between a pay-down and a
re-arm, so the window is as short as the operator makes it, which is why a run that observes one
says so and names the command. Headroom is not only left behind by a pay-down: a page that renders
fewer rows than the floor recorded opens the same window, and usabl reports it the same way
because it cannot tell the two apart.

The file carries a `version`. Version 1 wrote a placeholder count of 1 for every name and
structural entry, so those counts are not observations and the gate must not compare them.
Version 2 writes the observed count for every entry. Reading a version 1 floor that holds
name or structural entries produces a coverage gap, so the run reports `not_covered`
instead of a green it cannot support. `usabl baseline` regenerates the floor at version 2.
Both floor disclosures are decided inside `gate()`, not in the run path, because `gate()` is
exported and CI, the overlay and the page helper reach it directly. A check that lived only in
`run()` made the verdict depend on which door the caller came through. The gate weighs its own
gaps and names them in its summary; `run()` appends them to the Result's coverage so the gaps a
reader sees are the gaps the verdict was reached from.

### Failure taxonomy

- No UI-touching files: nothing to check (`verdict: null`, exit 0). Not `not_covered`.
- UI files changed that do not map to a screen: `not_covered`.
- A screen fails to load or CDP disconnects: `not_covered` with reason.
- A change edits rules, config, evidence, or waivers: `approval_required`.
- A scanner version cannot be read: `not_covered`.
- Any unhandled error: fail open with disclosure, never silent.

---

## 10. Guard and trust model

Two-tier, honestly scoped.

### Local (tamper-evident)

The trust anchor is git HEAD. Every guarded path must exactly match its committed
content. A divergence forces `approval_required`. This is tamper-evident, not
tamper-proof: an agent with shell access can edit and commit anything. The guard
catches the change and refuses to issue a trusted verdict, but it cannot prevent the
edit.

### CI (trusted-ref policy read)

CI requires `--trusted-ref` (a forge-supplied base revision). Config, evidence,
waivers, and rules are read via `git show <ref>:<path>` from the trusted base, never
from the PR working tree. Combined with CODEOWNERS + branch protection (when the host allows it), a PR author
cannot influence what policy they are judged against.

### Config-guards-itself

Check the config file's own integrity against the anchor before trusting its contents
to build the guarded set. Four policy files are always forced into the guarded set
regardless of what config says: `usabl.config.json`, `.usabl-evidence.json`,
`.usabl-waivers.json`, and `usabl.routes.json` (`ALWAYS_GUARDED` in `src/trust/guard.ts`);
the requirements directory is added when config sets `requirements`. Ordering is
load-bearing: integrity check before reading contents.

### Session pinning

At session start, record sha256 pins of every guarded path keyed by session id and
repository, stored outside the repo in the OS temp dir. The repository key is derived
from the resolved working directory the hook runs in, so pins recorded in one repository
are never compared against another. The stop hook checks pins mid-session to catch a
committed tamper that git-status-clean cannot see.

The temp dir is shared by every local user, so pins are kept private to the user:

- They live in one directory per user. When `$XDG_RUNTIME_DIR` is set, is absolute, and
  passes the checks below, that is `usabl-pins` inside it. On Linux with systemd this is
  `/run/user/<uid>`, which the system creates at login for that user alone. Otherwise it
  is `usabl-pins-<uid>` under the temp dir. Some hosts set `$XDG_RUNTIME_DIR` to a
  directory that fails the checks, such as one owned by root with mode 0755; the temp
  dir is then used.
- The pin directory is created with mode 0700. Before any read or write it is checked
  with `lstat`: it must be a real directory, not a symlink, owned by this user, with no
  permission bits for group or others.
- A pin file, `<session id>-<repository key>.json`, is opened with `O_NOFOLLOW` after an
  `lstat` check, so a symlink at the path is refused, never followed. The open handle is
  then checked with `fstat`: a regular file, owned by this user, with no permission bits
  for group or others.
- A pin file is never changed in place. New pins are written to a temp file in the same
  directory, created exclusively (`O_CREAT` with `O_EXCL`, plus `O_NOFOLLOW`) with mode
  0600. That file is then renamed over the pin file, or for the first pins of a session
  linked to the pin file name, which fails if anything is already there. A process killed
  part way leaves the old pins whole, never an empty file.

Any failed check refuses with a plain reason and a fix, and writes nothing. A pin file of
ours that does not parse is refused the same way: it is never read as "no pins yet",
because recording fresh pins over it would take whatever is committed now, a tamper
included, as the baseline. The stop then goes on without the drift comparison. It does
not block, because a block would trap the session behind a file another user may
control; this is the same fail-open choice as the exit 4 decision in the threat model.
It is never silent. The decision line carries a note, for example `VERIFIED (exit 0,
session drift not checked): ...`, and stderr ends with the reason and the fix:
`NOT verified - usabl did not use session pins for this stop because ... To fix: delete
<path>. The next stop records new pins for this session.`

What this does not cover:

- Pins are best-effort against an agent with a shell. Deleting the pin file, as the same
  user, resets the session baseline with no message: the next stop records new pins
  from what is committed then. Any process running as the user can do that, so pins
  catch a committed tamper only from an agent that does not also remove the pins.
- Where the temp dir is used, another local user can deny the drift check by creating
  `usabl-pins-<uid>` first. The check is then skipped on every stop, loudly. Under
  `$XDG_RUNTIME_DIR` on systemd Linux this denial goes away, because no other user can
  create anything in that directory.
- On Windows the platform reports no user id, so the directory has no id in its name and
  the owner and mode checks are skipped. Windows reports modes such as 0o666 that say
  nothing about who can read a file. The per-user temp dir Windows gives each account is
  what keeps it private.
- The checks assume the temp dir only lets an entry's owner remove or rename it, which
  the sticky bit on `/tmp` provides.

### Receipt binding

Four bindings are compared on re-verification:
- `sourceTree`: hash of the working tree (git write-tree on a temporary index).
- `policyHash`: sha256 over sorted guarded-path blob shas at the anchor.
- `runnerVersion`: package version + sha256 over the engine's own shipped files
  (first-party `dist/*.js` in the installed package, or the `src` tree when run from
  source). A change to any shipped engine file moves this hash, so a receipt minted by
  one engine build cannot re-verify under a tampered or upgraded engine.
- `scannerVersions`: the axe-core, Playwright, and Chromium versions that decided the
  verdict. `verifyReceipt` compares these too, so a swapped or upgraded scanner
  invalidates the receipt.

A source-tree change or committed policy change invalidates the receipt, and so does an
engine or scanner change.

Scope and limits, stated plainly so the proof is not oversold:
- The engine hash covers first-party engine code, not the `node_modules` dependency
  bytes. Dependency identity is bound by version through `scannerVersions`, not by a
  content hash; folding a lockfile content-hash into the fingerprint is a planned
  follow-up.
- The hash keys on relative paths normalized to `/`, so it is identical across
  operating systems. Mint and verify must use the same deployment shape: a receipt
  minted from a source run and one minted from the built package carry different engine
  hashes for the same version.
- The binding fingerprints on-disk bytes, not the bytes Node ultimately executes
  (`NODE_OPTIONS`, loaders, and module redirection can still alter runtime behavior).
  It is defense-in-depth that complements the root-owned read-only engine mount and the
  trusted-ref pin; it is not a standalone cryptographic proof that a specific engine ran.

### CODEOWNERS + branch protection

Every guarded path and the CI workflow require code-owner review before merge under
branch protection. Whether admins can bypass depends on the ruleset's bypass list.
This is the single highest-value security item. On this repository the `usabl-required`
check is required by the main-branch ruleset.

---

## 11. Surfaces

Every surface calls the same CLI core (`usabl check` or equivalent library export).
Surfaces differ only in **when** they run, **who** sees the output, and **whether**
they enforce. See the bloat-proof rule in section 3.

### 11.1 CLI (foundation)

The canonical entry point. Runs coverage → providers → gate → `Result`. Prints or
exits with `exitCode`. Everything else is a wrapper.

**Why it exists.** Brownfield adoption: a team can run `usabl check` against an
existing PatternFly app the same way they would run axe or Lighthouse - get findings,
establish an evidence floor, then turn on the stop hook and CI. It is scanner-shaped
invocation, not scanner semantics: output is a full `Result` with verdict, differential,
coverage honesty, and optional receipt minting.

**Command surface.** `main` recognizes exactly twelve commands: `check`, `comment`,
`bypass`, `init`, `baseline`, `floor`, `drift`, `enforce`, `install`, `stop-hook`,
`doctor`, `docs`. `check` is the default when no command is given. There is no `--help`
and no `--version`, and unrecognized flags are silently ignored (the parser has no
catch-all for unknown `-` tokens); an unknown *command* exits 2.

**Typical uses:**

- Local: `usabl check` (the default) on changed files or named surfaces.
- First-run policy drafts: `usabl init` infers and writes `usabl.config.json` and
  `usabl.routes.json` only. It never calls the gate and never consumes the files it just
  wrote, and it refuses to overwrite existing files unless `--force` is given (`--force`
  is init-only draft overwrite, not a gate bypass).
- Integration wiring: `usabl install <target>` wires exactly one integration surface per
  run. The targets are `--overlay`, `--claude`, `--claude-skill`, `--cursor`, `--ci`,
  `--docs-ci`, and `--branch-rule`; zero or more
  than one refuses with exit 2. `init` scaffolds policy; `install` wires integrations; they
  are different commands (see section 12).
- Baseline drafts: `usabl baseline` runs a full UI scan and writes `.usabl-evidence.json`
  as a reviewable working-tree diff.
- Floor prune: `usabl floor prune` re-arms the gate on cleanly scanned screens. It removes
  entries whose identity is gone, and lowers the recorded count on entries whose identity is
  still present but now holds fewer barriers. It never raises a count and never adds an
  identity: accepting new debt is what `usabl baseline` does, under review. It leaves version 1
  name and structural counts alone, because those are placeholders the gate does not compare and
  writing a real number under them would present a placeholder as an observation. `prune` is the
  only subcommand; anything else exits 2.
- Routes drift: `usabl drift routes` compares `usabl.routes.json` against the app router.
  `routes` is the only subcommand; anything else exits 2.
- Health check: `usabl doctor` is a read-only projection over the wired surfaces and always
  exits 0 (see section 11.9).
- CI: the workflow invokes `usabl check --ci --trusted-ref <base>`. On `check`, `--ci` is
  the CI-mode boolean and forces `--trusted-ref` (without it, `check --ci` refuses with
  exit 2). The same `--ci` token is the CI *install target* under `usabl install`; the two
  meanings are disambiguated only by the command.
- Comment: `usabl comment` reads a Result from stdin and prints the PR comment Markdown.
- Enforce: `usabl enforce accessibility` and `usabl enforce policy --trusted-ref` read
  Result JSON from stdin. They project CI status. They never call the gate and never mint a
  verdict. GitHub stays out of `run()`.
- Library: the stop hook, overlay, and an optional MCP wrapper import `run()` directly.
  No MCP surface is built today (section 11.5).

Does not replace the stop hook for the AI-gating story. It enables the baseline pass
that makes the ratchet meaningful. `usabl init` still does not write
`.usabl-evidence.json` or waivers, while `usabl baseline` drafts the evidence floor
as a working-tree diff for review and merge.

### 11.2 Stop hook (headline)

Fires on the assistant's Stop lifecycle event. Behavior matrix:

- Unconfigured repo or unreadable input: loud fail-open. The runner prints "NOT verified - stop hook error: ..." and allows, never a silent allow. A run that started and failed prints "NO VERDICT: RUN FAILED (exit 4): usabl is not blocking this stop, but the run did not finish, so it proved nothing about this change." followed by "Next: run usabl check again, or check the change by hand, before you call this change accessible." and allows.
- Nothing to check (no UI files in the diff): allow with explicit "nothing to check"
  message. Not `not_covered`.
- Valid receipt on an unchanged tree: fast allow in under 20 ms, no browser.
- `verified` on a fresh scan: mint receipt and allow. Mint only after every affected
  surface was scanned. Never mint on a sample. The meaning line on every surface is
  "No new barrier blocks this change. It can proceed." and the stop hook allows with
  "VERIFIED (exit 0): the gate verified this change. Receipt sourceTree <hash>. You may
  stop.", with advisory findings shown adjacent when present. Not "no barriers": a
  verified run routinely carries barriers the floor recorded.
- `regression`: block.
- `approval_required`: block.
- `not_covered`: default block. Recalibrate after week-2 real-repo measurement
  (section 25) if this drives persistent bypass behavior.
- Policy mismatch against git anchor: block.
- One-continuation escape: at most one forced continuation, then a loud disclosed
  allow marked "NOT verified."
- Hook error: fail open with disclosure, never a wedge.
- A findable single-run bypass (the "usabl bypass" command writes a one-shot .usabl/bypass-once file) so a wrong block means "bypass once and
  file it," not "delete the hook."

### 11.3 Overlay (dev-server)

On save, the overlay client requests a scan from the same engine as the stop hook
(single-flight per repo so hook and overlay do not storm browsers). It renders
`Result`. It never constructs a Verdict and never blocks the page. It is advisory: the
client runs inside the tested page's own JavaScript realm, so the page can interfere with
what the overlay shows; the gate computes the verdict and the CLI and CI enforce it. Oracle-preserving:
mounts only when `navigator.webdriver` is false and `?usabl=off` is not present.

### 11.4 CI/PR comment (trusted-ref policy read)

Reads policy from the protected branch (or the trusted ref), never the working tree.
Refuses to run without a base ref. The comment leads with the headline
(`## usabl report: <VERDICT>`), then on approval required the policy split line, then the
receipt (`_No receipt: run was not verified._` when none), then `### Conformance summary`
(whose `deterministic:` entry splits new into failing and unconfirmed when any is new),
then the finding sections `### New barriers`, `### Known (carried)`, and
`### Advisory (non-gating)`, or `### Findings (collapsed by rule)` for the gating lane
when the noise budget collapses it, then `### Coverage gaps` and
`### Announcements (current run)`. All page-derived text passes through `neutralize()`. Sticky comment
matched only among bot-authored comments (keyed by `<!-- usabl-report -->`). On
`approval_required` the comment stays loud after the policy check is green.

**One shape, two renderings.** `usabl install --ci` *generates* a three-job workflow at
`.github/workflows/usabl-gate.yml` in the consuming repo: a `gate-comment` job fenced to
`pull_request` that clones and pins the engine at the `PIN_TO_A_TRUSTED_USABL_COMMIT`
sentinel (the operator must replace it with a full 40-char SHA), runs the scan, posts the
comment, uploads the Result as an artifact, and runs `usabl enforce accessibility` as a
final step that never exits 2; and a `usabl-policy` job (`needs: gate-comment`,
`if: always()`) that also fires on `pull_request_review`, checks out the trusted base
only, fetches the head as git objects, runs `usabl enforce accessibility` over the
downloaded Result to publish an `accessibility` job output, and runs `usabl enforce policy
--trusted-ref`, never executing PR head code; and a `usabl-required` job
(`needs: [gate-comment, usabl-policy]`, `if: always()`) that sets the required status from
those two verdicts and runs no head code at all. The engine's own repo checks in the same three
jobs, with the same fences, artifact handoff, and policy isolation. One thing differs: a consuming repo
has no engine, so the draft clones `usabl-dev/usabl` at a pinned commit using
`USABL_ENGINE_CHECKOUT_TOKEN`, while in the engine repo the checked-out tree already is
the engine, so each job builds that tree with `npm ci && npm run build` and there is no
engine pin and no token. Because `classifyGateWorkflow` compares a workflow line for line
against the draft, `usabl doctor` reads the engine's own gate as `drifted`. That is the
expected reading for the one repository that is its own engine. The required status check
named in branch protection is `usabl-required` (the workflow *file* is named `usabl-gate`),
and the protected branch is `main`. Requiring `usabl-policy` instead is the defect that job
exists to close: accessibility is enforced inside `gate-comment`, which is fenced to
`pull_request` and so cannot be required on a review event, and `usabl-policy` returns
success whenever no guarded path diverged, so on its own it can be green while the scan is
red. Both `enforce` commands read Result JSON from stdin and never call the gate.

`usabl-required` reads three values and nothing else: the event name, the `gate-comment`
job result, and `usabl-policy`'s `accessibility` output. The scan job result is an
event-shape check, never a verdict, because the fence means the scan cannot run on a review
event: on `pull_request` it must be `success`, on `pull_request_review` it must be
`skipped`. The accessibility verdict itself comes from the Result artifact for that exact
head, which `usabl-policy` already resolves on both events, so the verdict is data and not
something inferred from a GitHub job status. Anything else, an unknown event, a cancelled
job, a missing or unparseable artifact, or any verdict that is not exactly `pass`, blocks.
The rule is one string, `REQUIRED_GATE_SCRIPT` in `src/install/ci.ts`, embedded verbatim in
all three workflows so the rule that is tested is the rule that runs.

### 11.5 Mid-task self-check (CLI; MCP optional)

**What problem this solves.** The agent can verify its own work while context is warm,
before the Stop hook fires. The value is self-correction mid-task. The value is **not**
"MCP."

**How it works (contest default).** The agent runs `usabl check` through the host's
shell (Bash in Claude Code). Same `run()` → `Result` as every other surface. The Stop
hook remains the gate; this path only advises the agent. The demo storyline (step 4)
works with a CLI call on screen just as well as an MCP call - MCP is not load-bearing
for the narrative.

**MCP wrapper (optional transport).** Same engine, thin protocol adapter. Decide MCP
vs Bash-only on discoverability, not capability.

| | **CLI via Bash** | **MCP tool** |
|---|---|---|
| **Pros** | No server, protocol, or registration work. Same Result. Zero extra transport to test. No page text flowing into agent context as structured tool output (lower prompt-injection surface than MCP). | First-class tool with description in Claude Code; model more likely to call at the right moment. Structured content the model handles natively instead of stdout to parse. |
| **Cons** | Model may forget to self-check without prompting. Parses CLI text output. | Fourth transport over one engine (integration + test surface). Page-derived text (aria-labels, headings, errors) returns as tool output - prompt-injection surface the Stop hook does not open. Requires `neutralize()` and untrusted-data framing (section 17). |

**Contest sequencing.** Ship CLI mid-task check with the hero loop. Add the MCP wrapper
in the same window as stretch goals if reliable agent self-correction in the demo
matters more than hero-loop time. If MCP stays, it stays for discoverability, not
because the story requires it.

The gate stays at Stop. Neither path lets the agent grade its own work.

### 11.6 Playwright helper (seam)

A documented entry point that returns the core Result. Teams can call the same check
from the tests they already run. A starting point, not a focus for the contest.

### 11.7 Other coding assistants (seam, not contest)

The contest demo uses Claude Code's Stop lifecycle event. The architecture does not
depend on Claude specifically. Any assistant that can run a subprocess or call MCP
can integrate the same gate:

| Assistant | Integration shape | What we ship |
|---|---|---|
| **Claude Code** | Stop hook → `usabl check`; mid-task via Bash (contest) or MCP wrapper (optional) | Contest |
| **Cursor** | `usabl install --cursor` writes the stop hook (`hooks.json` plus an adapter script) that loops the agent through Cursor's `followup_message` protocol, the `/usabl-check` command for advisory mid-task scans, and a UI-scoped rule | Shipped |
| **GitHub Copilot** | Extension calls CLI on save or on "agent done" if/when that event exists | Seam documented |
| **Any MCP host** | Optional on-demand tool; gate stays at task-complete lifecycle event | MCP wrapper if contest scope includes it |

Implementation is always the same three pieces: (1) detect UI-touching diff or
surface list, (2) invoke `run()` → `Result`, (3) enforce or display per that host's
rules. No second gate, no forked rulepack. A new assistant is a new **surface
adapter**, not a new product.

### 11.8 Post-contest surfaces (documented, not built)

**Storybook addon.** Run `usabl check` per story URL; pairs with discovery item 4
(section 24) that auto-generates surface-map entries from stories. Value: component-level
checks without booting the full app router. Same `Result`, story URL as `screenId`.

Not in contest. Add only if teams using Storybook ask for it and discovery from routes
is insufficient.

### 11.9 Doctor (onboarding health check, built)

`usabl doctor` is a read-only projection that reports the state of each wired
integration surface. It always exits 0, because a missing surface is information, not a
failure; its filesystem port throws on any write so an accidental write fails loudly. It
reports ten surfaces: config, authenticated session, route manifest, evidence floor,
waivers, overlay, stop-hook, usabl-check skill, ci, and branch-rule, each with a state
such as wired, missing, drifted, or unknown. The session surface reads the
`USABL_STORAGE_STATE` environment variable, which names a Playwright storage state file:
unset is missing, a readable JSON file that still holds something which could authenticate
is wired, and a path that names no file, names a file that is not JSON, or names a state
holding nothing that could authenticate (no unexpired or undated cookie, no local storage,
no IndexedDB, and no stored credential) is drifted. Doctor reads the same expiry rule
`usabl check` refuses on, so the two surfaces cannot disagree about one file. Doctor
reports whether a session is set and never prints the path or the file contents. The CI state is classified by `classifyGateWorkflow`: `missing`, `wired` (two
engine-ref lines, both the same real 40-hex SHA), `unpinned` (both lines are the pin
sentinel), or `drifted` (any other shape). Doctor never mints a verdict or a receipt.

---

## 12. Adoption model

### On or off

usabl is installed (CLI + stop hook + CI + overlay + Reports, one standard) or
the team is not using usabl. Mid-task self-check uses the CLI; an MCP wrapper is
optional. There is no "partial" mode and no per-surface strictness.

Onboarding uses two distinct commands. `usabl init` scaffolds policy: it writes
`usabl.config.json` and `usabl.routes.json` only (never the evidence floor or waivers)
and refuses to overwrite without `--force`. `usabl install <target>` wires integrations,
exactly one per run: `--overlay` (vite plugin), `--claude` (a Stop hook running `npx usabl
stop-hook` in `.claude/settings.json`), `--ci` (the generated PR-gate workflow), or
`--branch-rule` (a read-only check that the protected branch and the `usabl-required`
required status check exist). `init` does not wire CI or overlays, and `install` does not
scaffold policy.

### Brownfield adoption (prove what you touch)

A team in year four of a 400-screen console adopts usabl on Monday without mapping 400
screens on Monday.

1. Install usabl (on): CLI, stop hook, CI, overlay, Reports. One standard.
2. Optional first step: `usabl check` on a surface to see findings and accept an
   evidence floor before the stop hook blocks anyone.
3. Most PRs that do not touch UI: non-blocking "nothing to check" outcome.
4. First UI PR on a page discovery cannot map: `not_covered` until a surface map
   entry or a parseable route exists. Pages the router already lists do not need a
   hand-written map entry.
5. First check of that page: likely a pile of existing findings. A code owner accepts
   the evidence floor (and maybe a few waivers). That is one `approval_required` commit.
6. Next PR on that page: full default stack. A problem at an identity the floor does not
   hold, or above the count it recorded there, blocks. Recorded ones stay visible debt, and
   the floor comes down only through `usabl floor prune`; a waiver becomes inert on its
   expiry date and never edits the floor.

Coverage grows as the team works. It does not require Design to declare epic scope.

### Ratchet

Same full check every time. Existing findings are the floor. New findings are
regressions. The floor changes only when `usabl floor prune` writes a new one after a
clean scan observed fewer barriers, or when `usabl baseline` re-drafts it under review. A
source fix alone does not shrink it, and it never silently grows.

### Waivers

One finding, owned, expiring. Not "this page is advisory." Required fields: rule,
surface, scope, owner, reason, approvedBy, created, expires. An expired waiver is inert:
the finding is then carried if the evidence floor holds its identity, and blocks only if
it is new against the floor.

### What adoption is NOT

- Per-surface severity dials.
- "Legacy surfaces are exempt from checks until a team claims them."
- Design declaring in-scope epics or journeys.
- A way to make usabl quieter on some screens.

---

## 13. Design intake

### What Design/UX sends

Design adds intent the engine cannot infer. It does not restate WCAG or PatternFly
rules (those are built in). It does not set enforcement level.

| Kind | Example | Runtime effect |
|---|---|---|
| `content` | Alt text for topology.svg must be "Cluster network topology showing three nodes" | Content matcher assertion on that element |
| `flow` | After failed save, error is announced before focus moves | Declarative interaction script added to the walk |
| `doc` | Publish alt-text manifest for the Clusters surface | Output module generates the artifact |

### Many shapes in, one RequirementBundle

```
Figma export ──┐
YAML in repo ──┼──> normalize() ──> RequirementBundle
CSV alt text ──┘
PF checklist ──┘
```

The normalizer accepts multiple input formats and produces one `RequirementBundle`.
During the contest, hand-authored YAML in the repo is the primary shape.

### Guarded

Requirement files are guarded paths. Changing them triggers `approval_required`. Design
cannot weaken checks; only engineering + code owners change rule modules. Design can
add content and flow assertions that the engine enforces alongside the default stack.

### Mapping to checks

- `content` requirements become content-matcher providers (compare element text or
  aria-label against the approved string).
- `flow` requirements become declarative interaction probes (same step runner as the
  keyboard walk probes).
- `doc` requirements are not runtime checks; they feed the output module.

All intake-derived Drafts carry `evidenceClass: 'deterministic'` (the assertion is
hard and repeatable). `mapRequirementsToProviders` emits deterministic drafts with rule
id `intake:<id>` for content and flow requirements; there is no code path in v0.2.0 that
marks an intake draft as model-judgment.

### Requirement ids are waiver identities

A requirement id becomes the rule `intake:<id>`, and a waiver matches on that rule plus the
surface. Two requirements that share an id therefore share a rule, and one waiver would cover
a requirement its author never saw. The loader refuses a repeated id across every requirement
file at once, since each file can be valid on its own, and names both files and both list
positions. A requirement id, and the surface it names, follow the same character grammar as a
surface id (section 22). A refused character is reported by position and code point, never
printed back. Either failure is `approval_required`, returned from the loader rather than
thrown, and every reason the loader returns is scrubbed before it leaves, including the YAML
parser's own message and the file path, because both can carry file bytes.

---

## 14. Reports (accessible docs output)

The deck calls this surface "Reports." It is distinct from documentation checking
(sections 3, 7.6, 8): checking scans product docs for barriers, while Reports generates
publishable accessibility artifacts from an already-verified run. The command is
`usabl docs`.

### What it generates

After a verified run, produce published documentation from verified evidence plus
approved content requirements:

- **Alt-text manifest:** element, approved text, status (draft/approved), evidence link.
- **Announcement snippets:** per surface, what a screen reader would announce at each
  interactive stop.
- **Keyboard paths:** the Tab order through each surface with the announcement at each
  stop.

### AI drafts, humans approve

AI can propose alt text or doc copy. usabl publishes only entries with
`status: 'approved'`. Draft entries are visible but clearly labeled.

### Bound to evidence

Each DocArtifact is bound to the code state via `boundToReceipt`. If the code changes
and the receipt is invalidated, stale docs are marked as needing regeneration.

### How to run it

`usabl docs` runs a full check and prints an `{ artifacts: [...] }` JSON envelope on
stdout, or, with `--html`, renders the same artifacts as one accessible, self-contained
HTML page. It is a generator, not a gate: it always exits 0 and never mints a verdict.
Announcement snippets and keyboard paths come from the run transcript; the alt-text
manifest comes from configured content requirements. Surfaces the run did not verify
carry no `evidenceRef`, so unverified state cannot masquerade as proof. The same
projection is available to library callers as `projectDocs` and `collectDocArtifacts`
from the `usabl/docs` export.

### Not v1

- Full VPAT automation.
- Auto-merge doc PRs without review.
- Real-time sync to a docs portal.

---

## 15. Future checks (easy to add)

What makes them cheap to add:

- The Page interface already supports viewport, zoom, reduced motion, computed style,
  and screenshot.
- The provider interface is open (any `layer` string, returns `Draft[]`).
- The gate filters on `evidenceClass`, not on a closed list of layers.
- Adding a provider never requires touching gate, guard, coverage, or receipts.

### Sketches

| Check | Layer name | What it does | Page capability used |
|---|---|---|---|
| Text resize | `resize` | Set viewport to 320px width or zoom to 200%, assert no content loss or overlap | `setViewport`, `setZoom`, `screenshot` |
| Target size | `target-size` | Measure interactive element bounding boxes, flag anything below 24x24 CSS px | `getComputedStyle`, `queryAll` |
| Visible focus | `focus-indicator` | Tab through; at each stop compare focused vs unfocused outline/box-shadow/border | `tab`, `getComputedStyle` |
| Consistent navigation | `nav-consistency` | Compare navigation landmarks across surfaces, flag structural differences | `axAt` across multiple pages |
| Captions | `media-captions` | Find video/audio elements, assert track[kind=captions] present | `queryAll` |
| Reduced motion | `motion` | Enable prefers-reduced-motion; flag elements with active animation/transition | `setReducedMotion`, `getComputedStyle` |

---

## 16. Advisory lane

Findings with `evidenceClass: 'model-judgment'` are surfaced but never block.

### How they appear

- **Overlay:** shown in a separate "Advisory" section, visually distinct.
- **PR comment:** grouped under `### Advisory (non-gating)` below the gating sections.
- **CLI:** printed after the verdict with a label.
- **Gate:** explicitly excluded from verdict computation.

### Sketches

| Check | What it does | Why model-judgment |
|---|---|---|
| Plain language | Assess reading level of user-facing text | Meaning is subjective |
| Alt-text quality | Judge whether alt text is descriptive enough | Quality vs presence |
| Link text clarity | Flag "click here" or vague link labels | Context-dependent |
| Heading quality | Assess whether headings describe content | Semantic judgment |
| Error message clarity | Judge whether errors help the user | Intent-dependent |

### A person decides

Advisory findings are presented as suggestions. The developer (or a reviewer) decides
whether to act on them. They are never written to the evidence floor. They do not
appear in receipts. They cannot produce waivers (there is nothing to waive; they are
not blocking).

---

## 17. Security controls

### Must ship

1. CODEOWNERS on every guarded path and the workflow. Branch protection or a ruleset
   that requires the `usabl-required` check (in place on this repository).
2. Config-guards-itself (integrity check before reading contents).
3. CI reads policy from trusted ref, refuses without base ref.
4. Receipt binding (four bindings, receipt store excluded from version control).
5. `neutralize()` on all page-derived text at every egress.
6. Localhost-only binds by default.
7. Pinned scanner versions; unreadable version degrades to `not_covered`.
8. Sticky-comment bot-author filter and NUL-delimited git plumbing.
9. Untrusted-data framing on MCP tool output when the MCP wrapper ships. The Stop
   hook does not return page-derived text to the agent; MCP does. `neutralize()` at
   every egress (section 17).
10. Requirement files (design intake) added to the guarded set.

### Documented seams

- Cryptographic receipt signing via CI OIDC identity.
- Structural identity tier.
- Local tamper-proofing (impossible by design; keep the disclosure).
- MCP mid-task wrapper: optional transport over CLI; adds discoverability and
  prompt-injection surface the Bash path avoids (section 11.5).

---

## 18. Performance

### Strategy

- One warm browser per long-lived process, new context per screen.
- Receipt fast-path before any browser work.
- Per-screen cache keyed on (screen id, content hash), version-stamped.
- Page-ready: bounded network-idle wait capped at 2-3 seconds.
- Fan-out: parallelize affected screens. Do not subsample. If the hook cannot finish
  every affected surface inside the budget, the verdict is `not_covered`, not a sampled
  `verified`. Never mint a receipt on a partial scan. CI scans the same full set and
  may take longer.
- Tiered short-circuit: receipt, then axe, then rulepack, then walk. The hook may stop
  early once a blocking `regression` is known. CI still collects a complete finding
  set for the comment when practical.
- Single-flight per repo so the hook and overlay do not storm contexts.
- Block fonts, images, and analytics during scans.

### Budgets

- Receipt hit: under 20 ms.
- Fast loop (one warm surface, cache-cold): under 1.5 seconds.
- Full loop (all affected, parallel, under 10 screens): under 30 seconds.
- Per-screen cold: 1-4 seconds (dominated by the walk).
- CI wall-clock: under 3 minutes with browser binary cached.

---

## 19. Fixture app and oracle

A small PatternFly console with real routes: Overview, Clusters, Workloads, Settings,
on a shared AppShell, plus a shared StatusBadge used by two pages (proves coverage
fan-out). One switch (`?variant=broken` or `?variant=clean`) toggles only the planted
defects.

- Clean: zero findings (no false positives).
- Broken: exactly the planted count (any drift is a harness bug).

Planted defects on the broken Clusters page:

1. A kebab row-action toggle with no accessible name (catches `pf-icon-button-name`).
2. That same toggle missing aria-expanded (catches `pf-kebab-expanded-state`).
3. A modal that does not return focus on Escape (catches `pf-modal-focus-return`).
4. A success toast with no live region (catches `pf-toast-live-region`).
5. Every row's action button named "Actions" (catches `pf-row-action-name-unique`).

Planted defects on the broken Workloads page (so rules 3, 6, and 8 have an oracle):

6. A dialog or menu that does not move focus inside on open (catches
   `pf-focus-into-dialog`).
7. A table whose headers are not associated, or an empty/loading state that is not
   announced (catches `pf-table-header-assoc`).
8. Two repeated toolbars with no distinguishing accessible name (catches
   `pf-toolbar-labeled-when-repeated`).

Keep Settings identical in both variants to prove no false positives. The `?variant=`
switch lives in the fixture app, not on `ScreenScan`.

---

## 20. Work breakdown and team

### How the work is split

- **Detection** builds the detection engine (accessibility depth).
- **Gate** builds the verdict core, AI loop, and intake/output interfaces (lead).
- **Infrastructure** owns performance, behavior tests, demo capture, CI infra.
- **Validation** owns real-reader validation, honesty audit, adversarial security
  suite.
- **Production** makes the demo and presentation (week 4).

### Pairings

- Detection builds accessibility, Validation reviews accessibility.
- Gate builds the loop and surfaces, Infrastructure reviews and hardens them.
- Gate owns intake schema, YAML normalize, and Reports; Detection wires
  intake-derived providers.

### Integration

The detection engine and the gate integrate around day 6-8. Before that they work
apart against the frozen contracts.

### Schedule (4 weeks total, week 4 is demo polish)

- Day 1: contracts, primitives, deps, fakes, oracle. Lock by end of day.
- Days 2-5: parallel build (providers, rulepack, walk vs. coverage, gate, guard).
- End of week 1: working vertical slice with all four verdicts reachable.
- Days 6-8: integration, surfaces, security controls, intake/output interfaces.
- Days 9-11: harden, measure, real-repo smoke pass, overlay, Reports.
- Days 12-14: full loop working end to end; all surfaces wired.
- Week 3: polish, fix real-repo findings, performance tuning, demo asset capture.
- Week 4: demo production, rehearsal, deck, and buffer. No new features.

The MVP and the demo are the same artifact. We are building what we demo the
entire time. Week 4 is for the team to produce the polished video, rehearse the
live segment, and practice the narrative.

### Cut line (dropped first)

Detection breadth only. Overlay and Reports stay. Mid-task self-check via CLI
stays; MCP wrapper is optional (section 11.5).

1. `pf-toolbar-labeled-when-repeated`.
2. `pf-row-action-name-unique` and `pf-table-header-assoc`.
3. MCP wrapper (if hero loop is not solid yet).

Never cut: the gate, receipt fast-path, config-guards-itself, CODEOWNERS, four-verdict
output, announcement preview, the recorded hero loop, overlay, Reports, CLI mid-task
self-check.

---

## 21. Honest limits

### What usabl cannot do

- Certify compliance. It supports the work, it does not sign it off.
- Detect seizure-risk flashing. Frame-by-frame signal analysis is a different tool.
- Prove time-based logic (session timeouts, timed interactions).
- Replace a screen-reader user or an accessibility expert.
- Claim "accessible for everyone." It verifies what its checks cover, on the screens
  it checked, and says which is which.

### What it honestly discloses

- The announcement preview is an approximation from the accessibility tree, not a
  screen reader. It is labeled as a preview everywhere.
- CDP does not serialize aria-sort; that one fact is read from the DOM attribute. The
  exception is documented at the read site and disclosed in the demo.
- Local enforcement is tamper-evident, not tamper-proof. CI reads policy from the trusted
  base ref, so a pull request cannot change the policy it is judged against; the head code
  it scans is still the pull request's own.
- Discovery misses bundler aliases, computed imports, and unparseable routes. Those
  are honest `not_covered`, never silent passes.
- Identity-weak rules (missing accessible name) use count-based identity because you
  cannot honestly key an unnamed element by name.
- Session pinning is best-effort (stored in a private per-user dir, clearable by the OS
  or by the same user with no message, and skipped with a disclosure when that dir is not
  private).

---

## 22. Config file

```json
{
  "appBaseUrl": "http://127.0.0.1:5173",
  "uiFileGlobs": ["fixtures/app/src/**"],
  "discovery": {
    "routerFile": "fixtures/app/src/App.tsx",
    "wideBlastGlobs": [
      "fixtures/app/src/main.tsx",
      "fixtures/app/src/App.tsx",
      "fixtures/app/src/**/*.css",
      "fixtures/app/index.html",
      "fixtures/app/vite.config.ts"
    ]
  },
  "surfaces": [
    {
      "id": "clusters",
      "url": "http://127.0.0.1:5173/clusters",
      "files": ["fixtures/app/src/ClustersPage.tsx"]
    }
  ],
  "requirements": "requirements/",
  "guardedPaths": [
    "usabl.config.json",
    "usabl.routes.json",
    "src/providers/rulepack",
    "src/gate",
    "src/trust",
    ".usabl-evidence.json",
    ".usabl-waivers.json",
    ".github/workflows/usabl-gate.yml",
    "requirements/"
  ],
  "readyTimeoutMs": 60000
}
```

Each `surfaces[].id` is the key coverage is tracked under. It must be unique across the list
and it must satisfy the one id grammar the product has, which is stated here exactly. The
grammar excludes the empty string, whitespace, invisible characters (control characters, format
characters, lone surrogates, private use, every `Default_Ignorable_Code_Point`, and the assigned
characters that render as blank: U+2800, U+13441, U+13442, and U+16FE4), and it requires
Unicode NFC form. Ids are compared exactly, which is the comparison the planner, the floor, and
the receipt already make, so the grammar is what keeps two ids from looking alike rather than
the comparison folding them together. Everything else a font draws is allowed, so a
discovery-derived id such as `users-:id` stays valid. A refused id is reported by index, with
the position and code point of the offending character, because printing an invisible character
back would show nothing.

The grammar does not claim more than it delivers. It refuses whitespace, control and format
characters, surrogates, private use, default-ignorable characters, and the known assigned blank
glyphs; it accepts everything else, including unassigned code points, standalone combining
marks, and cross-script confusables. It does not claim that an accepted id never reorders text:
visible right-to-left letters reorder the run they sit in without any control character, and
they are accepted, because Hebrew and Arabic ids are real ids. It does not claim that every
accepted character has a glyph in every font. Confusables across scripts are accepted, so a
Latin `a` and a Cyrillic `a` are both valid and stay distinct ids: the two never fold into one
entry, each is scanned when a change affects it, and waiver matching is exact, so neither screen
is hidden behind the other. What the grammar does not do here is stop a reader from mistaking one
for the other.
Unassigned code points are accepted, because rejecting them would make an id's validity depend
on which Unicode version the running Node build carries.

The same grammar governs every operator-authored and derived id on the `usabl` command path:
`surfaces[].id`, `usabl.routes.json` `screenId`, the screen id the router fallback derives from a
route path in application source, `usabl.docs.json` `pageId`, requirement ids and the surface a
requirement names (section 13), the keys of `noiseBudget.perSurface`, which are screen ids matched
against one by exact comparison, and every id that `usabl init` and `usabl init --docs` derive. An
authored id that fails is refused at parse. A derived id that fails is never minted. At run time
the router fallback sets such a route aside and the planner records it as a `skipped` coverage
gap whenever a wide-blast change would have queued it, so the gate reads it as not covered
rather than as absent. `usabl init` and `usabl init --docs` refuse the whole draft: a written
sidecar takes precedence over router fallback, the planners queue every route or page in the
sidecar or manifest on a wide-blast or shared-file change, and neither records a gap for an
entry that is not there, so a draft written without the refused route or page would let such a
change read as fully checked while that screen is never scanned. The refusal names every
unusable route or page by file (and line, for a route), with the position and code point when a
character was refused and the grammar reason otherwise (an empty id, or one not in NFC form,
which must be normalized), and the fix, never the id or the path it came from, and writes
nothing.

What that covers, and what it does not. The grammar holds for every id these commands actually
derive, and the line in a route refusal is the line of the match the parser made. It says nothing
about a route the parser never recovered from the router source: no id is derived for it, so
nothing refuses it, and it is simply absent from the draft. Router source is matched by pattern,
not parsed, and the cases it reads wrongly or not at all are listed under the documented limits in
section 8.

The boundary, stated exactly. Ids already present in the evidence floor (`.usabl-evidence.json`)
and in waiver files (`.usabl-waivers.json`), and the inputs a caller passes directly to the
exported library functions (`gate()` and `mintReceipt()` from the package entry), are not
re-validated against the grammar. On the command path every id in those files was minted from, or
matched against, an id that had already passed the grammar at parse, so the command path is
covered end to end. A library caller that builds its own floor, waiver, or receipt input bypasses
that parse, and nothing downstream checks the grammar again. Closing that boundary is listed
under "After the freeze" at the end of this section.

A blank or repeated id is refused when the config is read. Left in, it would collapse two
screens into one entry: the second screen is dropped from the scan while its changed files
still count as mapped, and the run would report both screens as covered when only one was
ever opened.

### Three sources share one screen id space

Screen ids come from three places: `surfaces[].id` in `usabl.config.json`, `screenId` in
`usabl.routes.json`, and `pageId` in `usabl.docs.json`. App coverage and docs coverage are
concatenated into one run, and downstream the id alone keys floor identity, finding identity,
waiver matching, applicability, and source lookup. Each source already checked itself for
duplicates. Nothing checked across them, so one id could stand for two screens.

That is worse than losing a scan. Two screens under one id collapse to one map entry, so one is
never opened while its changed files still count as mapped. It also lets a floor entry belonging
to one screen absorb a genuinely new barrier on the other, which reads as carried debt and mints
a verified receipt over a real failure.

usabl refuses any id that could stand for more than one screen, checked when coverage is planned,
before the idle return, because a docs page can be scanned in a run where no app file changed.

**A surface and a discovered route may share an id, but the config has to say so.** Set
`"overridesDiscoveredRoute": true` on the surface. That is how a surface controls the scan URL for
a screen discovery already owns, which is what makes query variants and deep links possible.

usabl does not compare the two URLs and does not infer the relationship from them, because a URL
does not determine which screen renders:

- Applications select screens by query, fragment, trailing slash, and userinfo.
- Servers do not treat percent spellings as interchangeable. `/users/%61lice` and `/users/alice`
  are delivered as written.
- A redirect can send two requests for the same URL to two different screens, depending on session,
  server state, feature assignment, or time.

So even an identical URL proves only that the same address was requested. The declaration is the
only evidence usabl will accept, and `usabl init` writes it on every surface it derives from a
route.

Setting `overridesDiscoveredRoute` on a surface whose id matches no route in an authored
`usabl.routes.json` is refused, since the declaration would override nothing while reading as
though it were wired up. That check runs only against an authored sidecar. Router-text discovery
recovers paths but not ownership, so an id missing from it proves nothing, and the same shape is
what the trust guard leaves behind when it suppresses a diverged manifest. Refusing there would
throw away the findings of a run that can still report honestly.

**A docs page id may never equal a surface id or a route screen id.** There is no override
relationship between documentation and an application screen, so any overlap is refused outright.

Upgrading an existing config: a surface whose id matches a discovered route screen id will now be
refused until it declares the override or takes a different id. There is no safe way to infer the
answer, which is why usabl asks instead of guessing. Configs written by `usabl init` before this
change need `"overridesDiscoveredRoute": true` added to their surfaces.

`guardedPaths` is additive. The four policy files (`usabl.config.json`,
`usabl.routes.json`, `.usabl-evidence.json`, `.usabl-waivers.json`) are force-guarded by
`ALWAYS_GUARDED` whether or not they are listed here, and the requirements directory is
added when `requirements` is set. Listing rule modules, the gate, the trust code, and the
gate workflow puts them under the same `approval_required` review.

`readyTimeoutMs` is optional and defaults to 60000. It is the whole budget for one screen
to navigate, for its network to go quiet, and for its DOM to stop changing. How long that
takes is a property of the application, so a heavy authenticated app on a loaded lab may
need more: an Ansible Automation Platform screen measured 25.7 seconds. A screen that runs
out of budget is disclosed as `not-covered` with a reason naming which of the two phases
ran out, never scanned as if it had finished rendering. The value must be a positive whole
number of milliseconds; anything else is refused when the config is read, before a run
opens a browser.

There is no `notCovered` mode key. When usabl is on, `not_covered` blocks. Idle
(nothing to check) is an explicit informational allow. That is code, not a config dial.

### After the freeze

Work on this section that is known and deferred until after the freeze.

- Re-validate every screen or surface id field a caller can pass directly to the exported
  library functions, so the id grammar holds for `gate()` and `mintReceipt()` callers and not
  only for the `usabl` command path. For `gate()` those fields of `GateInput` are
  `coverage.affected[].screenId`, `drafts[].screenId`, `floor.entries[].screenId`,
  `waivers[].surface`, and every member of `cleanlyScannedScreens`. For `mintReceipt()` they are
  `checked`, `applicability[].screenId`, and the id fields of the `UsablConfig` it is handed:
  `surfaces[].id` and the keys of `noiseBudget.perSurface`. `mintReceipt()` is exported from the
  package entry and takes any structurally valid `UsablConfig`; it never calls `parseUsablConfig`,
  so a library caller can hand it ids the grammar would refuse. On the `usabl` command path the
  config is parsed before it reaches the receipt, so those two fields arrive validated there, but
  that is a property of the path, not of the function, and it is the function this item is about.
  None of these is checked today on the library path.
  The grammar governs screen and surface ids only. It does not govern rule ids, element keys,
  waiver scopes, receipt `notCovered` entries (file references), or receipt `surfaces` (output
  channels), and this item makes no claim about them.

---

## 23. Rule validation and prioritization

### Data sources

- PatternFly GitHub issues labeled accessibility or a11y.
- Product bugs in Jira or Bugzilla (Red Hat internal, anonymized).
- The PatternFly accessibility team's known problems list.
- WCAG failure patterns from public audits of PatternFly-based products.

A sample of 20 to 50 real bugs is enough to start. Use only public or
explicitly allowed data. No customer names in the repo.

### Method

1. Collect the sample of real accessibility bugs.
2. For each bug, determine which usabl rule (or rules) would have caught it.
3. Run the current rule set against reproductions of the bugs where possible.
4. Count: of N real bugs, the rules catch M. Report that number honestly.

### Why this matters

"We ran these rules against 30 real PatternFly bugs and caught 22 of them" is
evidence for the judges. It validates the rule set against real pain, not
contrived fixtures. It also prioritizes: if a class of bug appears ten times in
the sample and no rule catches it, that rule goes to the top of the backlog.

### Rule selection rationale

The eight PF rules were chosen because they represent composition mistakes that:
- Are outside what the axe-core provider reports. The rulepack is a separate provider,
  and the focus rules need the component exercised. The one recorded comparison: a
  standalone axe run reported zero violations on the broken fixture dialog while
  `pf-focus-into-dialog` and `pf-modal-focus-return` failed.
- Real screen-reader users encounter regularly in PatternFly apps.
- Are demonstrable in a short demo (visible to judges, audible in the transcript).

The five focus/interaction rules (1-5) carry the demo. The three structural rules
(6-8) add breadth. The cut line drops structural rules first.

---

## 24. Discovery improvement roadmap

### Current limits (contest)

- Only relative import paths are followed.
- Bundler aliases (`@/`, `~/`, tsconfig paths) are not resolved.
- Computed import specifiers (`import(variable)`) are not resolved.
- Routes built from a data table or registered dynamically are not extracted.
- Comment stripping is regex-based and imperfect.

These produce honest `not_covered`, never silent passes.

### Improvement path (post-contest, in priority order)

1. **tsconfig/vite alias resolution.** Read `tsconfig.json` paths and
   `vite.config` resolve.alias, then resolve non-relative specifiers against
   them. This covers the majority of alias patterns in real PF apps.
2. **Runtime route dump.** Start the app, extract the full route list from the
   running router (React Router exposes this), and use it instead of (or to
   supplement) the static parser. Handles dynamic and data-driven routes.
3. **Discovery diagnostics.** When a file lands in `unresolvedFiles`, emit a
   structured reason: "could not resolve `@/components/Foo` because no alias
   configuration was found." Give the developer a clear fix path.
4. **Storybook surface generation.** Auto-generate surface-map entries from
   Storybook stories, removing the mapping tax for teams that already use
   Storybook. A post-contest **Storybook addon** (section 11.8) would run the same
   CLI check per story URL.

### Candidate pull-in for contest

If week-2 real-repo `not_covered` is high, pull runtime route dump (item 2 above)
into contest scope. It is the single highest-leverage coverage improvement and has
more impact on trust than adding another deterministic rule.

### The trust cliff

If too many files are `not_covered`, teams lose trust in the tool. Mitigations:

- Discovery diagnostics (above) tell the developer exactly what to fix.
- Wide-blast ensures shell/CSS/config changes always check all known routes.
- Manual surface globs in config let teams bridge gaps immediately.
- The verified-verdict-rate metric (section 25) makes coverage visible, so the
  team can see it improving over time.
- The product never hides the gap. `not_covered` is loud on purpose.

---

## 25. Metrics and success criteria

### Verified-verdict-rate

The fraction of **UI-touching** changes the tool can actually verify (versus marking
`not_covered`). Idle / nothing-to-check runs are not in the denominator. Measured on
a real PatternFly surface, not the fixture app.

- **Target for demo:** state whatever the number is, honestly. A rate above 70%
  on a real surface is strong. Below 50% needs explanation.
- **Measured by:** the team, on the real-repo smoke pass.
- **Shown in demo:** one slide, one number, cited honestly.

### Stop-hook policy gate for `not_covered`

Do not lock this by philosophy alone. Tie behavior to the week-2 real-repo number:

- If `not_covered` is rare (for example, <=10% of UI-touching runs), keep hard block.
- If `not_covered` is common, switch to the existing one-continuation loud allow path
  for `not_covered` while discovery hardening lands.

Either way, keep `not_covered` loud, visible, and tracked in PR comment and overlay.

### Other metrics to track

| Metric | What it shows | Target |
|---|---|---|
| Time to first finding (new repo) | Adoption friction | Under 5 minutes |
| Violations prevented per PR | Value delivered | Track, report whatever it is |
| Re-check time (block to verified) | The "re-check after the fix" claim | Under 2 minutes for one screen |
| False positive rate (clean screen findings) | Trust | Zero on clean PatternFly markup |
| Rule coverage vs real bugs | Rule quality | Track against the sample (section 23) |

### How we report coverage to teams

The Result object includes `coverage.unresolvedFiles`. The overlay and PR comment
surface these as "files usabl could not map to a screen." The fleet view (later)
can aggregate coverage percentage across surfaces. The tool never hides a gap.

The fleet view's data source is runnable today as a measurement-only harness.
`npm run measure:fleet-insights` (from a repository clone) and the `usabl/measure`
export (`runMeasurementOnly`) walk the configured surfaces and report how many
screens surfaced draft findings and how many drafts in total. This harness never
mints a verdict, writes a receipt, or gates, and it is deliberately not a `usabl`
subcommand, so measurement can never be mistaken for a proof. The later fleet view
aggregates this measurement across repos; verdict authority stays with the gate.

---

## 26. Demo strategy

### Timeline

The contest runs 4 weeks. Week 4 is demo polish and rehearsal. The MVP and the
demo are the same artifact. We build what we demo.

- Weeks 1-2: core engine, surfaces, and the vertical slice working end to end.
- Week 3: real-repo smoke pass, performance tuning, asset capture, overlay polish.
- Week 4: the team produces the polished video from raw captures and rehearses
  the live segment. Deck finalized. No new features.

### AI coding assistant

Claude Code (Claude's stop hook lifecycle event). Confirmed.

### Storyline

1. Open cold on sound. Several seconds of the broken spoken announcement before
   any UI appears. A screen-reader user lives with this across release cycles.
2. Cut to the AI assistant mid-task on a real PatternFly screen. It thinks it is
   done.
3. The stop hook blocks. The four verdicts render plainly, with `not_covered`
   shown on purpose. The seeded bug is a focus or interaction defect that a
   screen-reader user feels, not contrived missing alt text.
4. The assistant fixes it, running `usabl check` mid-task (CLI via Bash; MCP wrapper
   if shipped). The hook re-runs and passes. A receipt is shown once.
5. Replay the clean announcement. Start and end on sound. The before/after
   contrast, broken at the cold open and clean at the bookend, is the empathy payload.
6. One live reveal at the end: type a fresh broken change and watch the hook
   block it live.
7. Supporting and fast: one PR-comment screenshot, one short overlay clip, one
   sentence each on the waiver, the differential, and the fleet roadmap.

### Asset strategy

Hybrid. A recorded, polished hero loop is the spine. Pure-live is too fragile for
an agent, browser, and hook chain on contest hardware. One short live reveal at
the end, because pure-recorded reads as staged.

### Audio and honesty

**Hero demo recording (NVDA).** The cold-open and bookend that contest judges hear is
recorded using NVDA on Windows. Capture this once via a one-time Windows VM on the
host (nested KVM from a toolbox container is typically blocked) or a hosted session
such as Assistiv Labs. NVDA is chosen because it is the most widely used screen
reader and judges recognize it. Lock the demo surface and the planted interaction bug
**before** that recording; the audio cannot be the wrong bug.

**Validation harness and dogfood reader (Orca on Fedora).** Orca is the team's native
reader on Fedora. It is the validation-harness target and the team's dogfood reader.
Because guidepup automates VoiceOver and NVDA only (not Orca), the harness cannot
drive Orca programmatically. Instead, the team captures Orca's spoken output via a
speech-dispatcher log module or a manual transcription pass, then compares it offline
to the Virtual Screen Reader transcript.

The in-run announcement preview is derived from the accessibility tree captured during
the transcript, not from a real screen reader; its honesty class is "preview, not real
AT." usabl also ships its own headless virtual screen reader provider
(`makeVirtualSrProvider`, the voicing lane), which is built but dormant in v0.2.0 and is
not wired into the run or the gate (section 7.5); it is usabl's own code, not the npm
`@guidepup/virtual-screen-reader` package, which is not a dependency in v0.2.0. The demo
voice (NVDA) differs from the validated reader (Orca); this is the accepted seam. The
engine is screen-reader-agnostic; the validation harness measures the virtual-SR
transcript's fidelity to a real reader, not to NVDA specifically.

If text-to-speech is used as a fallback, label it "synthesized from the announcement
transcript" and never imply it is live screen-reader output.

Disclose any attribute-read exception (aria-sort) on a slide. In an accessibility
honesty demo, an undisclosed "we read the DOM here" is a fatal gotcha if a judge
finds it. Disclosing it proactively reinforces the honesty claim.

Credibility preflight before recording:

- Verify AX-tree preview text is a fair approximation of what NVDA announces for the
  hero bug and the fixed state (demo recording); compare separately with Orca output
  for the validation pass.
- Sweep for any other CDP serialization gaps so `aria-sort` is truly the only
  disclosed attribute-read exception.
- Listen to how a real screen reader pronounces "usabl" and note the intended spoken
  form in the presenter notes.

---

## 27. Settled decisions

| Decision | Answer |
|---|---|
| Product name | usabl |
| AI coding assistant for stop hook | Claude Code (Stop lifecycle event) |
| Target design system | PatternFly v6 |
| Repo | github.com/usabl-dev/usabl (private, Apache-2.0) |
| Stack | TypeScript on Node 22, Vitest, Playwright, axe-core |
| Adoption model | On or off. No modes. Advisory findings surface and never block (advisory lane, not a mode). |
| Idle vs not_covered | Nothing to check is explicit informational allow, not `not_covered`. |
| Partial scans | Forbidden for `verified`. Full affected set or `not_covered`. |
| notCovered behavior | Not a config knob. Default hard block; recalibrate from week-2 real-repo `not_covered` rate. |
| Overlay / Reports | In contest. Not on the cut line. |
| CLI | In contest. Foundation; all surfaces call it. |
| Mid-task self-check | In contest via CLI (Bash). Same Result as MCP. |
| MCP wrapper | Optional. Discoverability vs hero-loop time (section 11.5). |
| IDE / LSP extension | Out. Overlay + CLI cover hand-coding. |
| Other assistants (Cursor, Copilot) | Seam: same CLI + hook/MCP adapter. Claude Code for demo. |
| Storybook addon | Post-contest seam (section 11.8). |
| Contest timeline | 4 weeks. Week 4 = demo polish. |
| How many PF rules | Eight, with a cut line (structural rules first). |
| Hero demo recording | NVDA (Windows VM or Assistiv Labs), captured once after hero bug is locked. |
| Validation / dogfood reader | Orca on Fedora; spoken output is captured and compared offline to the Virtual Screen Reader transcript. |
| Evidence labels | On every Draft from day 1. Contest = all deterministic. |
| Design intake in scope | Schema + YAML normalize in contest. Figma/CSV ingest is a seam. |
| Reports in scope | Generate the three artifacts, bound to receipt. |
| Documentation checking | Shipped in v0.2.1. Same engine, `profile: 'docs'`, activated by a `usabl.docs.json` manifest. One verdict, or none, across app and docs. |

### Still to decide

| Decision | Who decides | When |
|---|---|---|
| The demo PatternFly app and the hero bug | The team | Before NVDA hero recording |
| Real PatternFly repo for smoke pass | The team | Week 2 |
| Verified-verdict-rate target to state on stage | The team | After measurement |
| CI host for branch protection (done: the main-branch ruleset requires `usabl-required`) | The team | Week 2 |
| Real bug sample for rule validation | The team | Week 1 |
| MCP wrapper vs Bash-only mid-task check | The team | After hero loop works; before demo polish |

---

## 28. WCAG 2.2 coverage map

This section maps every WCAG 2.2 Level A and Level AA success criterion (55 total;
4.1.1 Parsing was removed in 2.2) to what usabl does about it. This is the honest
answer to "how much accessibility does this tool ensure?"

Categories:

- **Contest (deterministic):** usabl checks this now, mechanically, and can produce
  `verified` or `regression`.
- **Stretch (deterministic):** Built during the contest if time allows, to prove the
  architecture.
- **Post-contest (deterministic):** Easy to add as a provider. The Page capabilities
  and provider interface support it. We just have not built the provider yet.
- **Advisory (model-judgment):** usabl can surface a suggestion via the advisory lane
  but cannot verify it mechanically. A person decides.
- **Not applicable:** The criterion does not apply to a rendered web UI component check
  (e.g. time-based media for a PatternFly admin console).
- **Never:** usabl will never satisfy this. The criterion requires something outside
  the tool's scope (human judgment, application logic, or signal analysis).

### Principle 1: Perceivable

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 1.1.1 | Non-text Content | A | Contest (axe) + Advisory (quality) | axe checks presence of alt/aria-label (deterministic). Advisory lane judges whether the text is actually useful (model-judgment). Design intake can assert exact approved alt text (deterministic). |
| 1.2.1 | Audio-only/Video-only (Prerecorded) | A | Not applicable | PatternFly admin consoles rarely have prerecorded media. If present, this is a content decision outside the component library. |
| 1.2.2 | Captions (Prerecorded) | A | Post-contest | Check for `<track kind="captions">` on video elements. Simple DOM query. |
| 1.2.3 | Audio Description or Media Alternative | A | Not applicable | Same as 1.2.1. |
| 1.2.4 | Captions (Live) | AA | Never | Live captioning is a runtime service decision, not a component property. |
| 1.2.5 | Audio Description (Prerecorded) | AA | Not applicable | Same as 1.2.1. |
| 1.3.1 | Info and Relationships | A | Contest (axe + PF rulepack) | axe checks semantic structure. PF rulepack checks table header association, toolbar labeling, live regions. |
| 1.3.2 | Meaningful Sequence | A | Contest (axe) | axe checks reading order against DOM order. |
| 1.3.3 | Sensory Characteristics | A | Advisory | Requires understanding whether instructions rely on shape/color/location. Model-judgment. |
| 1.3.4 | Orientation | AA | Post-contest | Set viewport to portrait/landscape, assert no content loss. Uses `setViewport`. |
| 1.3.5 | Identify Input Purpose | AA | Contest (axe) | axe checks autocomplete attributes on common input types. |
| 1.4.1 | Use of Color | A | Contest (axe, partial) | axe flags some color-only information. The contest eight PF rules do not include a status-color-only check; do not cite a rule that is not in §7.2. |
| 1.4.2 | Audio Control | A | Not applicable | PatternFly admin consoles do not auto-play audio. |
| 1.4.3 | Contrast (Minimum) | AA | Contest (axe) | axe owns color contrast checking. usabl does not reimplement it. |
| 1.4.4 | Resize Text | AA | Post-contest | Set zoom to 200%, assert no content loss or overlap. Uses `setZoom`. Not a stretch goal. |
| 1.4.5 | Images of Text | AA | Contest (axe) | axe flags images used as text. |
| 1.4.10 | Reflow | AA | Post-contest | Set viewport to 320px CSS width, assert no horizontal scroll. Uses `setViewport`. |
| 1.4.11 | Non-text Contrast | AA | Contest (axe) | axe checks UI component and graphical object contrast. |
| 1.4.12 | Text Spacing | AA | Post-contest | Inject increased spacing via CSS, assert no content loss. Uses `getComputedStyle` + `setViewport`. |
| 1.4.13 | Content on Hover or Focus | AA | Post-contest | Trigger hover/focus content, assert dismissable + hoverable + persistent. Declarative probe. |

### Principle 2: Operable

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 2.1.1 | Keyboard | A | Contest (keyboard walk + PF rulepack) | The keyboard walk tabs through interactive elements. Any interactive element not on the Tab path is reported. PF rules cover dialog focus, kebabs, and row actions. |
| 2.1.2 | No Keyboard Trap | A | Contest (keyboard walk) | Cycle detection in the walk. If Tab never escapes a region, the walk reports it. |
| 2.1.4 | Character Key Shortcuts | A | Never | Requires knowing whether single-character shortcuts exist in application logic. |
| 2.2.1 | Timing Adjustable | A | Never | Time limits are application logic. usabl does not run over time. |
| 2.2.2 | Pause, Stop, Hide | A | Post-contest | Detect auto-updating/moving content and assert a pause mechanism exists. Partially possible with animation detection. |
| 2.3.1 | Three Flashes or Below | A | Never | Seizure detection requires frame-by-frame photosensitivity analysis. A different tool. |
| 2.4.1 | Bypass Blocks | A | Contest (axe) | axe checks for skip links and landmark regions. |
| 2.4.2 | Page Titled | A | Contest (axe) | axe checks document title presence. |
| 2.4.3 | Focus Order | A | Contest (keyboard walk) | The walk records focus order. PF rulepack checks focus-into-dialog and focus-return. "Illogical" order is visible in the transcript; the contest check does not judge meaning. |
| 2.4.4 | Link Purpose (In Context) | A | Advisory | Whether link text is descriptive requires understanding intent. Model-judgment. |
| 2.4.5 | Multiple Ways | AA | Never | Whether there are multiple ways to find a page is an IA decision, not testable per screen. |
| 2.4.6 | Headings and Labels | AA | Contest (axe) + Advisory | axe checks heading structure exists. Whether headings are descriptive is model-judgment. |
| 2.4.7 | Focus Visible | AA | Stretch | Tab through, compare focused vs unfocused computed styles. The stretch-goal check that *is* a 2.2 A+AA criterion. |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | Post-contest | At each focus stop, check whether the element is obscured by sticky/fixed positioned elements. Uses `getComputedStyle` + position checks. |
| 2.5.1 | Pointer Gestures | A | Never | Whether multi-point or path-based gestures have single-pointer alternatives is application logic. |
| 2.5.2 | Pointer Cancellation | A | Never | Up-event firing behavior is application logic. |
| 2.5.3 | Label in Name | A | Contest (axe) | axe checks that visible label text is included in the accessible name. |
| 2.5.4 | Motion Actuation | A | Never | Whether motion-triggered actions have alternatives is application logic. |
| 2.5.7 | Dragging Movements | AA | Never | Whether drag operations have non-dragging alternatives is application logic. |
| 2.5.8 | Target Size (Minimum) | AA | Post-contest | Measure bounding boxes of interactive elements, flag below 24x24 CSS px. Uses `getComputedStyle`/bounding box. |

### Principle 3: Understandable

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 3.1.1 | Language of Page | A | Contest (axe) | axe checks for `lang` attribute on `<html>`. |
| 3.1.2 | Language of Parts | AA | Contest (axe) | axe checks `lang` on elements with different language content. |
| 3.2.1 | On Focus | A | Contest (keyboard walk) | The walk flags observable context changes on focus (document URL change, or focus moving to a different control than the one just focused). It does not judge "unexpected" in the WCAG sense. |
| 3.2.2 | On Input | A | Post-contest | Declarative probe: change an input value, assert no unexpected context change. |
| 3.2.3 | Consistent Navigation | AA | Post-contest | Compare nav landmarks across surfaces, flag structural differences. Multi-page check. |
| 3.2.4 | Consistent Identification | AA | Post-contest | Same function = same label across surfaces. Multi-page comparison. |
| 3.2.6 | Consistent Help | A | Post-contest | Check that help mechanisms appear in the same relative order. Multi-page. |
| 3.3.1 | Error Identification | A | Advisory | Whether errors are identified clearly requires semantic understanding of error states. Partially checkable via aria-invalid + aria-describedby. |
| 3.3.2 | Labels or Instructions | A | Contest (axe) | axe checks that form inputs have labels. |
| 3.3.3 | Error Suggestion | AA | Advisory | Whether error messages suggest a fix requires understanding content. Model-judgment. |
| 3.3.4 | Error Prevention (Legal/Financial) | AA | Never | Whether a submission is legal/financial is application context. |
| 3.3.7 | Redundant Entry | A | Never | Whether previously entered info is auto-populated is application logic. |
| 3.3.8 | Accessible Authentication (Minimum) | AA | Never | Authentication flow design is application architecture. |

### Principle 4: Robust

| SC | Name | Level | usabl | How |
|---|---|---|---|---|
| 4.1.2 | Name, Role, Value | A | Contest (axe + PF rulepack + walk) | The core of what usabl checks. axe validates ARIA usage. PF rulepack checks PF-specific name/role/value patterns. The walk reads actual name, role, and state from the accessibility tree. |
| 4.1.3 | Status Messages | A | Contest (PF rulepack) | `pf-toast-live-region` checks that status updates reach assistive technology via live regions. |

### Summary

WCAG 2.2 Level A+AA is **55** criteria (4.1.1 was removed). Counts below match the
tables, not a rounded marketing total.

| Category | Count | Percentage of Level A+AA |
|---|---|---|
| **Contest (deterministic)** | 21 | 38% |
| **Stretch (deterministic, if time)** | 1 (2.4.7) | 2% |
| **Post-contest (deterministic, buildable)** | 13 | 24% |
| **Advisory (model-judgment, never verified)** | 4 | 7% |
| **Not applicable** (media in admin consoles) | 4 | 7% |
| **Never** (application logic, human judgment) | 12 | 22% |

Reduced motion is a stretch **provider** (preference injection). It is not a 2.2 A+AA
row, so it is not in the 55.

**What we can say:**

- At contest time: usabl mechanically verifies 21 of 55 Level A+AA criteria (38%).
  With visible-focus stretch, 22 (40%).
- With the post-contest providers built: 35 of 55 (64%).
- With advisory included (surfaced, person decides): 39 of 55 (71%).
- The remaining 16 (29%) are not applicable to admin consoles (4) or require
  application logic or human judgment the tool will never replace (12).

**What we do NOT say:**

- "usabl makes your app WCAG compliant." It does not. Compliance requires all
  criteria including the ones only a human can judge.
- "usabl covers X% of accessibility." WCAG is not the whole of accessibility.
  The tool verifies what its checks cover, on the screens it checked.

### Stretch goals (prove the architecture)

Two checks built during the contest to prove the provider interface extends without
touching the gate. Only 2.4.7 counts in the 55. Reduced motion is extra.

1. **Visible focus indicator** (`focus-indicator` provider, WCAG 2.4.7)

   Tab through the page. At each stop, compare computed styles (outline, box-shadow,
   border) between focused and unfocused state. Flag any interactive element where
   focus produces no visible style change. Uses the keyboard walk + `getComputedStyle`.

   Why this one: it is genuinely non-trivial (not just a DOM query), it combines two
   Page capabilities (walk + style inspection), and it catches a WCAG AA criterion
   that axe handles poorly (axe only checks `outline: none` statically).

2. **Reduced motion** (`motion` provider, related to WCAG 2.3.3/2.2.2)

   Enable `prefers-reduced-motion: reduce` via `setReducedMotion(true)`. Inspect
   computed `animation-name` and `transition-duration` on all elements. Flag any
   element with active animation under the reduced-motion preference.

   Why this one: it exercises preference injection (proving the tool can test
   user-preference scenarios), it catches a real user harm (vestibular disorders),
   and it is deterministic (no screenshots, no timing).

Rules for stretch goals:
- Only attempt if the core vertical slice is solid by end of week 2.
- Do NOT add them to the demo fixture oracle. Run on the real-repo smoke pass.
- If they cause any instability, delete them. They are never on the "never cut" list.
- One slide, one sentence in the demo: "We added these in week 3 without touching
  the gate."
