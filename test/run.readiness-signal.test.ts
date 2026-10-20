/**
 * A screen with a declared readiness signal that the scan did not see is not measured, all the way
 * to the verdict and the pay-down count.
 *
 * The three sign-in shapes the session rules cannot see. None of them makes a refused request,
 * none carries a password field, and each has real focusable controls, so the body-only floor is
 * silent too:
 *
 *   - a passkey sign-in page, which offers one "Sign in with a passkey" button;
 *   - a magic-link page, which asks for an email address and sends a link;
 *   - an authentication wall that answers 200 to every request, including its own status call.
 *
 * Without a signal each one is scored as the requested screen. With a signal each one is a
 * coverage gap: no findings, no paid-down floor entry, and no verified verdict. The real screen,
 * with the same signal, is measured and its floor entry is paid down, so the signal is not simply
 * gapping everything.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import type { ApiResponse, Deps, Draft, Page, Provider, SurfaceConfig, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';

const SCREEN_URL = 'http://app.test/users';

function configWith(reachedWhen: SurfaceConfig['reachedWhen']): UsablConfig {
  return {
    appBaseUrl: 'http://app.test',
    uiFileGlobs: ['fixtures/app/src/**'],
    discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
    surfaces: [
      {
        id: 'users',
        url: SCREEN_URL,
        files: ['fixtures/app/src/UsersPage.tsx'],
        ...(reachedWhen === undefined ? {} : { reachedWhen }),
      },
    ],
    guardedPaths: ['usabl.config.json'],
  };
}

// One floored barrier on users. A run that wrongly believes it measured users and did not see the
// barrier would report it paid down.
const FLOOR = JSON.stringify({
  version: 2,
  entries: [
    {
      screenId: 'users',
      layer: 'axe',
      rule: 'color-contrast',
      elementKey: 'users|color-contrast|name:save',
      identityBasis: 'name',
      count: 1,
    },
  ],
});

const POLICY_FILES = { 'usabl.config.json': '{}', '.usabl-evidence.json': FLOOR };

// A barrier the sign-in page carries, so a wrong-page scan has something to misreport.
const signInPageDraft: Draft = {
  rule: 'page-has-heading-one',
  layer: 'axe',
  severity: 'moderate',
  evidenceClass: 'deterministic',
  screenId: 'users',
  elementPath: 'html',
  elementName: null,
  role: null,
  whatUserExperiences: 'The page has no level one heading',
  why: 'Screen reader users cannot tell what the page is',
  fix: 'Add a level one heading that names the page',
  evidence: {},
  confidence: 'fail',
};

interface PageShape {
  // What the keyboard walk lands on: a real control, so the body-only floor stays silent.
  focusable: string;
  // Selectors present in the rendered page.
  present: string[];
  // Every fetch or XHR response the page received, in arrival order.
  responses: ApiResponse[];
  // Refusals the page saw, kept in step with the 401 entries in responses.
  refused?: string[];
}

const PASSKEY_SIGN_IN: PageShape = {
  focusable: 'html > body > main > button#passkey',
  present: ['main', 'h1', 'button#passkey'],
  responses: [],
};

const MAGIC_LINK: PageShape = {
  focusable: 'html > body > main > form > input#email',
  present: ['main', 'h1', 'form', 'input#email', 'button#send-link'],
  responses: [],
};

// Answers 200 to everything, including the status call its own script makes.
const AUTH_WALL_200: PageShape = {
  focusable: 'html > body > main > a#continue',
  present: ['main', 'h1', 'a#continue'],
  responses: [{ url: 'http://app.test/wall/status', status: 200, contentType: 'application/json', sentBeforeWalk: true }],
};

const REAL_USERS_SCREEN: PageShape = {
  focusable: 'html > body > main > button#save',
  present: ['main', 'h1', 'table#users', 'button#save'],
  responses: [{ url: 'http://app.test/api/users?page=1', status: 200, contentType: 'application/json', sentBeforeWalk: true }],
};

function pageFor(shape: PageShape): Page {
  return makeFakePage({
    currentUrl: async () => SCREEN_URL,
    countEverywhere: async () => 0,
    queryAll: async (selector: string) => (shape.present.includes(selector) ? [{ selector }] : []),
    unauthorizedApiRequests: async () => shape.refused ?? [],
    apiResponses: async () => shape.responses,
    activePath: async () => shape.focusable,
  });
}

function depsFor(shape: PageShape, config: UsablConfig, providers: Provider[]): Deps {
  const base = makeFakeDeps({
    files: POLICY_FILES,
    headContents: POLICY_FILES,
    writeTree: 'tree-readiness',
    changed: [{ code: 'M', path: 'fixtures/app/src/UsersPage.tsx' }],
  });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open: async () => pageFor(shape), close: async () => {} },
      providers,
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
      sessionConfigured: true,
    }),
  };
}

const quietProvider: Provider = { id: 'quiet', layer: 'axe', capabilities: ['live'], run: async () => [] };
const noisyProvider: Provider = {
  id: 'noisy',
  layer: 'axe',
  capabilities: ['live'],
  run: async (): Promise<Draft[]> => [signInPageDraft],
};

const SIGN_IN_SHAPES: Array<[string, PageShape]> = [
  ['a passkey sign-in page', PASSKEY_SIGN_IN],
  ['a magic-link page', MAGIC_LINK],
  ['an authentication wall that answers 200', AUTH_WALL_200],
];

const SIGNALS: Array<[string, SurfaceConfig['reachedWhen']]> = [
  ['a selector', 'table#users'],
  ['a response', { response: '/api/users' }],
  ['a selector and a response', { selector: 'table#users', response: '/api/users' }],
];

describe('a declared readiness signal the scan did not see', () => {
  for (const [shapeName, shape] of SIGN_IN_SHAPES) {
    for (const [signalName, signal] of SIGNALS) {
      it(`gaps ${shapeName} when the screen declares ${signalName}`, async () => {
        const config = configWith(signal);
        // No barrier of its own, the worst case: without the gap this would be verified, with a
        // receipt, and the floored barrier claimed paid down.
        const quiet = await run(depsFor(shape, config, [quietProvider]), config);
        // The only screen in the run was not seen, so nothing was measured and the run refuses on
        // the no-verdict channel: no verdict, exit 4, and no receipt.
        expect(quiet.verdict).toBeNull();
        expect(quiet.exitCode).toBe(4);
        expect(quiet.receipt).toBeNull();
        expect(quiet.paidDownCount).toBe(0);
        expect(quiet.findings.filter((f) => f.status === 'fixed')).toEqual([]);
        expect(quiet.coverage.gaps.some((gap) => gap.ref === SCREEN_URL && gap.state === 'not-covered')).toBe(true);

        // A barrier of its own is not filed under the requested screen.
        const noisy = await run(depsFor(shape, config, [noisyProvider]), config);
        expect(noisy.findings.some((f) => f.rule === 'page-has-heading-one')).toBe(false);
        expect(noisy.paidDownCount).toBe(0);
      });
    }
  }

  it('names the response that never arrived', async () => {
    const config = configWith({ response: '/api/users' });
    const r = await run(depsFor(AUTH_WALL_200, config, [quietProvider]), config);
    expect(r.coverage.gaps.some((gap) => gap.reason.includes('/api/users'))).toBe(true);
  });
});

describe('the real screen with the same signal', () => {
  for (const [signalName, signal] of SIGNALS) {
    it(`is measured and pays down its floor entry when it declares ${signalName}`, async () => {
      const config = configWith(signal);
      const r = await run(depsFor(REAL_USERS_SCREEN, config, [quietProvider]), config);
      expect(r.coverage.gaps).toEqual([]);
      expect(r.verdict).toBe('verified');
      expect(r.paidDownCount).toBe(1);
    });
  }
});

describe('a refused request the application recovered from', () => {
  // The token refresh shape: the first identity call is refused, the client refreshes, and the
  // same call is answered. The screen then renders its own content and data.
  const RECOVERED: PageShape = {
    ...REAL_USERS_SCREEN,
    refused: ['http://app.test/api/me'],
    responses: [
      { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
      { url: 'http://app.test/auth/refresh', status: 200, contentType: 'application/json', sentBeforeWalk: true },
      { url: 'http://app.test/api/me', status: 200, contentType: 'application/json', sentBeforeWalk: true },
      { url: 'http://app.test/api/users?page=1', status: 200, contentType: 'application/json', sentBeforeWalk: true },
    ],
  };

  it('does not gap the screen when its readiness signal was met', async () => {
    const config = configWith({ selector: 'table#users', response: '/api/users' });
    const r = await run(depsFor(RECOVERED, config, [quietProvider]), config);
    expect(r.coverage.gaps).toEqual([]);
    expect(r.verdict).toBe('verified');
  });

  it('still gaps the screen when it declares no readiness signal', async () => {
    // Without positive evidence the screen rendered, a 401 followed by a 200 can also be an
    // application that dropped its stale token and was answered as an anonymous visitor. That has
    // to stay a gap, so nothing here is weaker than it was.
    const config = configWith(undefined);
    const r = await run(depsFor(RECOVERED, config, [quietProvider]), config);
    expect(r.verdict).toBe('not_covered');
    expect(r.coverage.gaps.some((gap) => gap.reason.includes('401'))).toBe(true);
  });

  it('still gaps the screen when the last answer to the refused address was another refusal', async () => {
    const config = configWith({ selector: 'table#users' });
    const stillRefused: PageShape = {
      ...REAL_USERS_SCREEN,
      refused: ['http://app.test/api/me', 'http://app.test/api/me'],
      responses: [
        { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
        { url: 'http://app.test/auth/refresh', status: 200, contentType: 'application/json', sentBeforeWalk: true },
        { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
      ],
    };
    const r = await run(depsFor(stillRefused, config, [quietProvider]), config);
    expect(r.verdict).toBe('not_covered');
    expect(r.coverage.gaps.some((gap) => gap.reason.includes('401'))).toBe(true);
  });
});

describe('a refusal and its retry on the declared response path', () => {
  it('is not verified when the only success is the anonymous retry of the refused address', async () => {
    // A sign-in wall: /api/users?page=1 is refused, the client drops its token and retries the
    // same address, and the wall answers it as an anonymous visitor. The one 200 must not count
    // both as the signal holding and as the refused address recovering.
    const config = configWith({ response: '/api/users' });
    const wall: PageShape = {
      ...REAL_USERS_SCREEN,
      refused: ['http://app.test/api/users?page=1'],
      responses: [
        { url: 'http://app.test/api/users?page=1', status: 401, contentType: 'application/json', sentBeforeWalk: true },
        { url: 'http://app.test/api/users?page=1', status: 200, contentType: 'application/json', sentBeforeWalk: true },
      ],
    };
    const r = await run(depsFor(wall, config, [quietProvider]), config);
    expect(r.verdict).not.toBe('verified');
    expect(r.receipt).toBeNull();
    expect(r.paidDownCount).toBe(0);
    expect(r.coverage.gaps.some((gap) => gap.reason.includes('401'))).toBe(true);
  });

  it('is not verified when the string form of reachedWhen matched and the refused address was retried', async () => {
    // The string form is a selector on its own. On main nothing stood Rule A down, and a selector
    // still does not.
    const config = configWith('table#users');
    const recovered: PageShape = {
      ...REAL_USERS_SCREEN,
      refused: ['http://app.test/api/me'],
      responses: [
        { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
        { url: 'http://app.test/api/me', status: 200, contentType: 'application/json', sentBeforeWalk: true },
      ],
    };
    const r = await run(depsFor(recovered, config, [quietProvider]), config);
    expect(r.verdict).toBe('not_covered');
    expect(r.paidDownCount).toBe(0);
  });
});

describe('a declared response the screen got back as HTML', () => {
  it('gaps the screen when its data path answered 200 with an HTML page', async () => {
    // A sign-in page, an SSO proxy, or a dev server history fallback answering the data call
    // with index.html and a 200.
    const config = configWith({ response: '/api/users' });
    const htmlAnswer: PageShape = {
      ...REAL_USERS_SCREEN,
      responses: [
        { url: 'http://app.test/api/users?page=1', status: 200, contentType: 'text/html; charset=utf-8', sentBeforeWalk: true },
      ],
    };
    const r = await run(depsFor(htmlAnswer, config, [quietProvider]), config);
    expect(r.verdict).toBeNull();
    expect(r.paidDownCount).toBe(0);
    expect(r.coverage.gaps.some((gap) => gap.reason.includes('/api/users'))).toBe(true);
  });
});

describe('what is still not caught without a signal', () => {
  it('scores a passkey sign-in page as the screen when no signal is declared', async () => {
    // The documented limit, held so the ground truth cannot drift from the code. No refused
    // request, no password field, and a real control to focus: nothing tells this page apart
    // from the screen, so it is measured as the screen. The fix is to declare a signal.
    const config = configWith(undefined);
    const r = await run(depsFor(PASSKEY_SIGN_IN, config, [quietProvider]), config);
    expect(r.coverage.gaps).toEqual([]);
    expect(r.verdict).toBe('verified');
  });
});
