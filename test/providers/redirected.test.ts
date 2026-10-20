/**
 * A screen this run did not reach signed in was not measured, and must say so.
 *
 * The defect this locks, measured on a real login-gated application with a committed evidence
 * floor. The scan session expired. usabl scanned whatever came back under the requested screen
 * ids, recorded no coverage gap at all, and reported all twenty-nine floored barriers as paid
 * down. The run came back red only because that page carried barriers of its own; a clean one
 * would have returned verified, with a receipt, and a claim that the debt was gone.
 *
 * What that application actually does, which is why the address is not enough. The browser never
 * leaves the requested URL. The single page application renders a blank shell for over five
 * seconds and then swaps a login form in at the same address, so a scan that settles mid
 * transition sees a partial page with no password field yet. The decisive signal is on the
 * network and it is there from the first moment: the page's own API calls to identity endpoints
 * answer 401. The same screen with a working session makes nine API calls, all 200, no 401.
 *
 * Three rules are held here, each with the case that must fire and the case that must not.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, Page, Provider } from '../../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../../src/deps/fakes.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import {
  observeLanding,
  readRefusedRequests,
  redirectedAwayGap,
  refusalsFromAppHost,
  sanitizeRefusedUrlForDisplay,
  sanitizeUrlForDisplay,
  type LandingObservation,
} from '../../src/providers/redirected.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'users', url: 'http://app.test/users' };
const APP_BASE_URL = 'http://app.test';

function observation(over: Partial<LandingObservation> = {}): LandingObservation {
  return {
    requestedUrl: SCREEN.url,
    appBaseUrl: APP_BASE_URL,
    landedUrl: SCREEN.url,
    passwordFieldPresent: false,
    unauthorizedApiUrls: [],
    sessionConfigured: true,
    reachedSelectorPresent: null,
    ...over,
  };
}

interface PageSpec {
  landedUrl?: string;
  passwordFields?: number;
  unauthorized?: string[];
  // Refusals that have not arrived yet at the first read and appear on the next one, which is what
  // a slow application's identity request does.
  lateUnauthorized?: string[];
  // What queryAll answers, which is how reachedWhen is measured.
  reachedWhenMatches?: boolean;
  // How many scanner-opened overlays are in the page. Non-zero makes the settle wait spend its
  // whole budget, so it stays zero unless a test is about that wait.
  scannerArtifacts?: number;
}

function pageWith(spec: PageSpec = {}): Page {
  let reads = 0;
  return makeFakePage({
    currentUrl: async () => spec.landedUrl ?? SCREEN.url,
    // Selector-aware, because the check runner asks this for two unrelated things: the password
    // probe and the scanner-artifact settle. A fake that answered both the same way would make
    // every password test also spend the settle budget.
    countEverywhere: async (selector: string) =>
      selector.includes('password') ? spec.passwordFields ?? 0 : spec.scannerArtifacts ?? 0,
    queryAll: async () => (spec.reachedWhenMatches === true ? [{ selector: '#app-shell' }] : []),
    unauthorizedApiRequests: async () => {
      reads += 1;
      const early = spec.unauthorized ?? [];
      return reads === 1 ? early : [...early, ...(spec.lateUnauthorized ?? [])];
    },
    // A real focusable stop, so the separate body-only unseen detector has nothing to say about
    // any screen these tests scan.
    activePath: async () => 'html > body > main > button#save',
  });
}

function makeDraft(rule: string): Draft {
  return {
    rule,
    layer: 'fake',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: SCREEN.id,
    elementPath: 'input',
    elementName: 'Password',
    role: 'textbox',
    whatUserExperiences: 'A field has no accessible name',
    why: 'Assistive technology users hear an unlabeled control',
    fix: 'Add an accessible name to the field',
    evidence: {},
    confidence: 'fail',
  };
}

const loudProvider: Provider = {
  id: 'loud',
  layer: 'fake',
  capabilities: ['live'],
  run: async (): Promise<Draft[]> => [makeDraft('label')],
};

function runnerFor(
  page: Page,
  options: {
    sessionConfigured: boolean;
    screen?: { id: string; url: string };
    providers?: Provider[];
    reachedWhen?: string;
  },
) {
  const screen = options.screen ?? SCREEN;
  return makeCheckRunner({
    browser: { open: async () => page, close: async () => {} },
    providers: options.providers ?? [loudProvider],
    config: testConfig({
      appBaseUrl: APP_BASE_URL,
      surfaces: [
        {
          id: screen.id,
          url: screen.url,
          files: [],
          ...(options.reachedWhen === undefined ? {} : { reachedWhen: options.reachedWhen }),
        },
      ],
    }),
    allowedCapabilities: ['live'],
    stepRunner: makeStepRunner(),
    transcriptTabCap: 3,
    sessionConfigured: options.sessionConfigured,
  });
}

describe('rule A: the page\'s own data requests were refused as unauthenticated', () => {
  it('fires on a 401 even though the address never changed and no password field rendered yet', () => {
    // The real application, exactly. Same URL, blank shell, no password input yet, and three
    // identity calls already refused. Rules B and C are both blind here.
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        landedUrl: SCREEN.url,
        passwordFieldPresent: false,
        unauthorizedApiUrls: [
          'http://app.test/api/v2/me',
          'http://app.test/api/v2/config',
          'http://app.test/api/v2/organizations',
        ],
      }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('401');
    expect(gap?.reason).toContain("3 of the application's own data requests");
    expect(gap?.reason).toContain('http://app.test/api/v2/...');
    expect(gap?.reason).toContain('did not measure users');
  });

  it('does not fire when no session was configured, because a signed-out visitor meets 401s', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, unauthorizedApiUrls: ['http://app.test/api/me'] }),
      ),
    ).toBeNull();
  });

  it('does not fire when nothing was refused', () => {
    expect(redirectedAwayGap(SCREEN.id, observation({ unauthorizedApiUrls: [] }))).toBeNull();
  });

  it('counts only refusals from the application\'s own hostname', () => {
    // One incidental 401 from an optional widget, an analytics beacon, or a third-party service
    // whose own credentials are stale must not discard a whole screen on every run.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: [
            'https://telemetry.vendor.example/collect',
            'https://cdn.other.example/api/config',
          ],
        }),
      ),
    ).toBeNull();
    // A refusal from the application's own hostname beside the third-party ones still fires, and
    // the count is the matched count, not the raw one.
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        unauthorizedApiUrls: [
          'https://telemetry.vendor.example/collect',
          'http://app.test/api/v2/me',
        ],
      }),
    );
    expect(gap?.reason).toContain('1 of the application');
    expect(gap?.reason).not.toContain('telemetry.vendor.example');
  });

  it('is not overridden by a matched reachedWhen selector', () => {
    // A reachedWhen aimed at a persistent shell, a header, a nav, or a footer, matches on a login
    // wall too. The application refusing the session is the stronger evidence, so this stands.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/v2/me'],
          reachedSelectorPresent: true,
        }),
      ),
    ).not.toBeNull();
  });

  // A data response the page recorded. JSON, and sent before the walk, unless a case says otherwise.
  const answer = (url: string, status: number, over: { contentType?: string | null; sentBeforeWalk?: boolean } = {}) => ({
    url,
    status,
    contentType: 'application/json',
    sentBeforeWalk: true,
    ...over,
  });

  it('is dismissed when a response part held on an address never refused and the refused address was later answered', () => {
    // A token refresh: the identity call is refused, the client refreshes, and the same call is
    // answered. The screen's own data path was answered too, on an address that was never refused.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [
            answer('http://app.test/api/me', 401),
            answer('http://app.test/auth/refresh', 200),
            answer('http://app.test/api/me', 200),
            answer('http://app.test/api/users?page=1', 200),
          ],
          reachedSelectorPresent: null,
          reachedResponseSeen: true,
          reachedWhenResponse: '/api/users',
        }),
      ),
    ).toBeNull();
  });

  it('is not dismissed when the one success is the retry of the refused address itself', () => {
    // A sign-in wall: the screen's data call is refused, the client drops its token and retries
    // the same address, and the wall answers it as an anonymous visitor. That single 200 must not
    // count both as the signal holding and as the refused address recovering.
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        unauthorizedApiUrls: ['http://app.test/api/users?page=1'],
        apiResponses: [answer('http://app.test/api/users?page=1', 401), answer('http://app.test/api/users?page=1', 200)],
        reachedResponseSeen: true,
        reachedWhenResponse: '/api/users',
      }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.reason).toContain('401');
  });

  it('is not dismissed by a selector-only signal, even when the refused address was later answered', () => {
    // The string form of reachedWhen is a selector. A selector is operator policy and a shell
    // selector matches a login wall, so it never stands Rule A down, exactly as before recovery
    // was read at all.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [
            answer('http://app.test/api/me', 401),
            answer('http://app.test/auth/refresh', 200),
            answer('http://app.test/api/me', 200),
          ],
          reachedSelectorPresent: true,
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed when the response part is held only by a request sent after the walk began', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [
            answer('http://app.test/api/me', 401),
            answer('http://app.test/api/me', 200),
            answer('http://app.test/api/users', 200, { sentBeforeWalk: false }),
          ],
          reachedResponseSeen: true,
          reachedWhenResponse: '/api/users',
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed when the later answer to the refused address is an HTML page', () => {
    // A sign-in page or a proxy answering the retried call with its own HTML is not the
    // application answering the session.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [
            answer('http://app.test/api/me', 401),
            answer('http://app.test/api/me', 200, { contentType: 'text/html; charset=utf-8' }),
            answer('http://app.test/api/users', 200),
          ],
          reachedResponseSeen: true,
          reachedWhenResponse: '/api/users',
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed when a declared selector did not hold, even with the response part held', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [answer('http://app.test/api/me', 401), answer('http://app.test/api/me', 200), answer('http://app.test/api/users', 200)],
          reachedSelectorPresent: false,
          reachedResponseSeen: true,
          reachedWhenResponse: '/api/users',
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed by a later success when no readiness signal was declared', () => {
    // A 401 then a 200 can also be an application that dropped a stale token and was answered as
    // an anonymous visitor. Without positive evidence the screen rendered, that stays a gap.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [
            { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
            { url: 'http://app.test/api/me', status: 200, contentType: 'application/json', sentBeforeWalk: true },
          ],
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed by a later success when the readiness signal did not hold', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me'],
          apiResponses: [
            { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
            { url: 'http://app.test/api/me', status: 200, contentType: 'application/json', sentBeforeWalk: true },
          ],
          reachedSelectorPresent: true,
          reachedResponseSeen: false,
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed when the last answer to the refused address was a refusal', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          unauthorizedApiUrls: ['http://app.test/api/me', 'http://app.test/api/me'],
          apiResponses: [
            { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
            { url: 'http://app.test/api/me', status: 200, contentType: 'application/json', sentBeforeWalk: true },
            { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
          ],
          reachedSelectorPresent: true,
        }),
      ),
    ).not.toBeNull();
  });

  it('is not dismissed by a success on a different address', () => {
    // The refresh call succeeding says nothing about whether the refused call was ever answered.
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        unauthorizedApiUrls: ['http://app.test/api/me', 'http://app.test/api/config'],
        apiResponses: [
          { url: 'http://app.test/api/me', status: 401, contentType: 'application/json', sentBeforeWalk: true },
          { url: 'http://app.test/api/config', status: 401, contentType: 'application/json', sentBeforeWalk: true },
          { url: 'http://app.test/auth/refresh', status: 200, contentType: 'application/json', sentBeforeWalk: true },
          { url: 'http://app.test/api/me', status: 200, contentType: 'application/json', sentBeforeWalk: true },
          { url: 'http://app.test/api/users', status: 200, contentType: 'application/json', sentBeforeWalk: true },
        ],
        reachedResponseSeen: true,
        reachedWhenResponse: '/api/users',
      }),
    );
    expect(gap).not.toBeNull();
    // Only the address nobody answered is counted and named.
    expect(gap?.reason).toContain('1 of the application');
  });

  it('shortens a refused address to its first two path segments', () => {
    // A path is where applications put opaque values: /reset/<token>, /invite/<token>. The
    // endpoint an operator needs to recognise is the front of the path.
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({ unauthorizedApiUrls: ['http://app.test/reset/OPAQUE_TOKEN'] }),
    );
    expect(gap?.reason).toContain('http://app.test/reset/...');
    expect(gap?.reason).not.toContain('OPAQUE_TOKEN');
  });

  it('matches the application hostname across ports, schemes, and subdomains', () => {
    // An origin comparison was too narrow in three ways that all happen in practice, and each one
    // was measured flowing through a real run to a verified receipt with a paid-down entry.
    const base = 'http://example.com';
    const counted = [
      'http://example.com/api/me',
      'http://example.com:8443/api/me',
      'https://example.com/api/me',
      'https://api.example.com/v2/me',
      'https://auth.internal.example.com/token',
      'http://EXAMPLE.COM/api/me',
    ];
    expect(refusalsFromAppHost(counted, base)).toEqual(counted);
  });

  it('still ignores an unrelated third-party host, and a host that only looks like a suffix', () => {
    // The dot is required, so notexample.com is not example.com.
    const ignored = [
      'https://telemetry.vendor.example/collect',
      'https://notexample.com/api/me',
      'https://example.com.evil.test/api/me',
    ];
    expect(refusalsFromAppHost(ignored, 'http://example.com')).toEqual([]);
  });

  it('counts every refusal when appBaseUrl cannot be parsed', () => {
    // The opposite of the earlier behaviour and deliberate. A base URL usabl cannot read is a
    // configuration it cannot reason about, and this product fails toward disclosure: not_covered
    // on a misconfigured base is honest, where counting nothing hands back a verdict.
    const urls = ['https://telemetry.vendor.example/collect', 'http://app.test/api/me'];
    expect(refusalsFromAppHost(urls, 'not a url')).toEqual(urls);
    expect(refusalsFromAppHost(urls, '')).toEqual(urls);
  });

  it('counts a refused address that will not parse, for the same reason', () => {
    // It is still a request the page made and the server refused.
    expect(refusalsFromAppHost(['not a url'], 'http://example.com')).toEqual(['not a url']);
  });

  it('through the rule: a different port, a different scheme, and an API subdomain all fire', () => {
    for (const refused of [
      'http://app.test:8443/api/v2/me',
      'https://app.test/api/v2/me',
      'https://api.app.test/v2/me',
    ]) {
      expect(
        redirectedAwayGap(SCREEN.id, observation({ unauthorizedApiUrls: [refused] })),
      ).not.toBeNull();
    }
  });

  it('through the rule: an unreadable appBaseUrl makes every refusal count', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          appBaseUrl: 'not a url',
          unauthorizedApiUrls: ['https://telemetry.vendor.example/collect'],
        }),
      ),
    ).not.toBeNull();
  });

  it('sanitizeRefusedUrlForDisplay keeps at most two route words and marks the cut', () => {
    // Two segments is the ceiling, and a segment is kept only while it reads as a route word.
    // In /reset/<token> the token IS the second segment, so the ceiling alone would print it.
    expect(sanitizeRefusedUrlForDisplay('http://app.test/reset/OPAQUE_TOKEN')).toBe('http://app.test/reset/...');
    expect(sanitizeRefusedUrlForDisplay('http://app.test/api/v2/users/42')).toBe('http://app.test/api/v2/...');
    expect(sanitizeRefusedUrlForDisplay('http://app.test/api/v2')).toBe('http://app.test/api/v2');
    expect(sanitizeRefusedUrlForDisplay('https://u:p@app.test/me?t=T#f')).toBe('https://app.test/me');
    expect(sanitizeRefusedUrlForDisplay('http://app.test/')).toBe('http://app.test/');
    // A UUID, a numeric id, and a base64 blob are all identifiers, not route words.
    expect(sanitizeRefusedUrlForDisplay('http://app.test/9f1c2b3e-4d5a-6b7c-8d9e-0f1a2b3c4d5e/me')).toBe(
      'http://app.test/...',
    );
    expect(sanitizeRefusedUrlForDisplay('http://app.test/users/9f1c2b3e4d5a6b7c8d9e0f1a')).toBe(
      'http://app.test/users/...',
    );
    expect(sanitizeRefusedUrlForDisplay('nope')).toBe('an address usabl could not parse');
  });
});

describe('rule B: a password field anywhere, with a session configured', () => {
  it('fires at the requested address, which rule C alone would miss', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({ landedUrl: SCREEN.url, passwordFieldPresent: true }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.reason).toContain('asks for a password');
    expect(gap?.reason).toContain('did not measure users');
  });

  it('does not fire without a configured session, so a deliberate signed-out scan still runs', () => {
    // No assertion was made that this run is signed in, so meeting a login form is not evidence
    // that anything failed. Rule C still covers the wrong-page case below.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, landedUrl: SCREEN.url, passwordFieldPresent: true }),
      ),
    ).toBeNull();
  });

  it('is overridden by a matched reachedWhen, which is what makes change-password scannable', () => {
    // A genuine signed-in screen that really does contain a password field. The operator has
    // asserted this screen rendered, and that outranks a heuristic that it did not. Without the
    // override the screen is discarded on every run with no way to say otherwise.
    expect(
      redirectedAwayGap(
        'change-password',
        observation({ passwordFieldPresent: true, reachedSelectorPresent: true }),
      ),
    ).toBeNull();
  });

  it('is overridden by a declared readiness response that arrived', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ passwordFieldPresent: true, reachedResponseSeen: true }),
      ),
    ).toBeNull();
  });

  it('still fires when the selector matched but the declared response did not arrive', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ passwordFieldPresent: true, reachedSelectorPresent: true, reachedResponseSeen: false }),
      ),
    ).not.toBeNull();
  });

  it('still fires when a declared reachedWhen selector matched nothing', () => {
    // Declared and absent is the opposite of an assertion that the screen rendered.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ passwordFieldPresent: true, reachedSelectorPresent: false }),
      ),
    ).not.toBeNull();
  });
});

describe('rule C: redirected to a page that asks for a password', () => {
  it('fires with no session configured, because it is still the wrong page', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        sessionConfigured: false,
        landedUrl: 'http://app.test/login?next=%2Fusers',
        passwordFieldPresent: true,
      }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.reason).toContain('redirected away');
    expect(gap?.reason).toContain('http://app.test/login');
  });

  it('does not fire on a different address with no password field', () => {
    // An ordinary redirect that still lands on a real screen: a canonical path, a locale prefix,
    // a marketing parameter. Nothing here says the screen was missed.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, landedUrl: 'http://app.test/en/users' }),
      ),
    ).toBeNull();
  });

  it('does not fire on the same address even when a password field is on it', () => {
    // The sign-in screen an operator listed as a surface on purpose, scanned with no session.
    expect(
      redirectedAwayGap('sign-in', {
        requestedUrl: 'http://app.test/login',
        appBaseUrl: APP_BASE_URL,
        landedUrl: 'http://app.test/login',
        passwordFieldPresent: true,
        unauthorizedApiUrls: [],
        sessionConfigured: false,
        reachedSelectorPresent: null,
      }),
    ).toBeNull();
  });

  it('treats a trailing slash, a default port, and host case as the same screen', () => {
    for (const landed of ['http://app.test/users/', 'http://app.test:80/users', 'http://APP.TEST/users']) {
      expect(
        redirectedAwayGap(
          SCREEN.id,
          observation({ sessionConfigured: false, landedUrl: landed, passwordFieldPresent: true }),
        ),
      ).toBeNull();
    }
  });

  it('ignores an added query string, because a login redirect and a real login screen both add one', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          sessionConfigured: false,
          landedUrl: 'http://app.test/users?tab=active',
          passwordFieldPresent: true,
        }),
      ),
    ).toBeNull();
  });

  it('compares the fragment, so a hash router redirected to its login route is caught', () => {
    expect(
      redirectedAwayGap('users', {
        requestedUrl: 'http://app.test/#/users',
        appBaseUrl: APP_BASE_URL,
        landedUrl: 'http://app.test/#/login',
        passwordFieldPresent: true,
        unauthorizedApiUrls: [],
        sessionConfigured: false,
        reachedSelectorPresent: null,
      }),
    ).not.toBeNull();
  });

  it('makes no claim when the page could not report where it is', () => {
    // Absence of evidence. Raising a gap here would drop a real screen's findings over a browser
    // read that failed, so the honest answer is no claim.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, landedUrl: null, passwordFieldPresent: true }),
      ),
    ).toBeNull();
  });
});

describe('no address in a gap reason ever carries a credential', () => {
  // Three parts of a URL can hold one and all three are removed: the userinfo carries HTTP basic
  // credentials, the query carries return addresses and authorization codes, the fragment carries
  // a live access token in the OAuth implicit flow. Both the requested and the landing address are
  // sanitized, because an operator can put a preview token in a configured surface URL too.
  const SECRETS = ['s3cr3t-basic', 'SUPERSECRETCODE', 'SUPERSECRETTOKEN', 'REQUESTEDSECRET'];

  function expectNoSecrets(text: string | undefined): void {
    expect(text).toBeDefined();
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('@app.test');
    expect(text).not.toContain('code=');
    expect(text).not.toContain('access_token');
  }

  const dirtyRequested = 'http://admin:s3cr3t-basic@app.test/users?preview=REQUESTEDSECRET#t=REQUESTEDSECRET';
  const dirtyLanding =
    'https://user:s3cr3t-basic@sso.example.com/authorize?code=SUPERSECRETCODE#access_token=SUPERSECRETTOKEN';

  it('strips userinfo, query, and fragment from both addresses under rule C', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      appBaseUrl: APP_BASE_URL,
      landedUrl: dirtyLanding,
      passwordFieldPresent: true,
      unauthorizedApiUrls: [],
      sessionConfigured: false,
      reachedSelectorPresent: null,
    });
    expect(gap?.reason).toContain('http://app.test/users');
    expect(gap?.reason).toContain('https://sso.example.com/authorize');
    expectNoSecrets(gap?.reason);
  });

  it('strips userinfo, query, and fragment from the requested address and the refused one under rule A', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      appBaseUrl: 'https://app.test',
      landedUrl: dirtyRequested,
      passwordFieldPresent: false,
      unauthorizedApiUrls: ['https://svc:s3cr3t-basic@app.test/api/me?token=SUPERSECRETTOKEN#x=SUPERSECRETCODE'],
      sessionConfigured: true,
      reachedSelectorPresent: null,
    });
    expect(gap?.reason).toContain('https://app.test/api/me');
    expectNoSecrets(gap?.reason);
  });

  it('strips userinfo, query, and fragment from the requested address under rule B', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      appBaseUrl: APP_BASE_URL,
      landedUrl: dirtyRequested,
      passwordFieldPresent: true,
      unauthorizedApiUrls: [],
      sessionConfigured: true,
      reachedSelectorPresent: null,
    });
    expect(gap?.reason).toContain('http://app.test/users');
    expectNoSecrets(gap?.reason);
  });

  it('leaves gap.ref as the configured surface URL, which the overlay matches on exactly', () => {
    // Not sanitized on purpose. Every gap in a result refs the operator's own configured value,
    // and the overlay attributes a gap to a screen by comparing this to the scan target, so a
    // rewritten ref would silently orphan the gap. The reason above is where the safe form goes.
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      appBaseUrl: APP_BASE_URL,
      landedUrl: dirtyLanding,
      passwordFieldPresent: true,
      unauthorizedApiUrls: [],
      sessionConfigured: false,
      reachedSelectorPresent: null,
    });
    expect(gap?.ref).toBe(dirtyRequested);
  });

  it('sanitizeUrlForDisplay keeps scheme, host, port, and path and drops everything else', () => {
    expect(sanitizeUrlForDisplay('https://u:p@host.test:8443/a/b?q=1#f')).toBe('https://host.test:8443/a/b');
    expect(sanitizeUrlForDisplay('http://host.test')).toBe('http://host.test/');
    expect(sanitizeUrlForDisplay('not a url')).toBe('an address usabl could not parse');
  });
});

describe('observeLanding: reading the facts off a live page', () => {
  const observeOptions = { requestedUrl: SCREEN.url, appBaseUrl: APP_BASE_URL, sessionConfigured: true };

  it('reads the address, the password count, the refused requests, and the reachedWhen selector', async () => {
    await expect(
      observeLanding(
        pageWith({
          landedUrl: 'http://app.test/login',
          passwordFields: 1,
          unauthorized: ['http://app.test/api/me'],
        }),
        { ...observeOptions, reachedWhen: undefined },
      ),
    ).resolves.toEqual({
      requestedUrl: SCREEN.url,
      appBaseUrl: APP_BASE_URL,
      landedUrl: 'http://app.test/login',
      passwordFieldPresent: true,
      unauthorizedApiUrls: ['http://app.test/api/me'],
      sessionConfigured: true,
      reachedSelectorPresent: null,
      reachedResponseSeen: null,
      reachedWhenResponse: null,
      apiResponses: [],
    });
  });

  it('reads every failing probe as no claim, never as a not-reached screen', async () => {
    const broken = makeFakePage({
      currentUrl: async () => {
        throw new Error('page is gone');
      },
      countEverywhere: async () => {
        throw new Error('invalid selector');
      },
      unauthorizedApiRequests: async () => {
        throw new Error('no record');
      },
      apiResponses: async () => {
        throw new Error('no record');
      },
    });
    await expect(observeLanding(broken, { ...observeOptions, reachedWhen: undefined })).resolves.toEqual({
      requestedUrl: SCREEN.url,
      appBaseUrl: APP_BASE_URL,
      landedUrl: null,
      passwordFieldPresent: false,
      unauthorizedApiUrls: [],
      sessionConfigured: true,
      reachedSelectorPresent: null,
      reachedResponseSeen: null,
      reachedWhenResponse: null,
      apiResponses: [],
    });
  });

  it('reads a declared response whose record cannot be fetched as not seen, never as seen', async () => {
    const broken = makeFakePage({
      apiResponses: async () => {
        throw new Error('no record');
      },
    });
    await expect(
      observeLanding(broken, { ...observeOptions, reachedWhen: { response: '/api/users' } }),
    ).resolves.toMatchObject({ reachedResponseSeen: false, apiResponses: [] });
  });

  it('reads an empty address as no claim', async () => {
    const blank = await makeFakeDeps().browser.open('');
    await expect(
      observeLanding(blank, { ...observeOptions, reachedWhen: undefined }),
    ).resolves.toMatchObject({ landedUrl: null });
  });
});

describe('readRefusedRequests: the second look', () => {
  it('returns the record as it stands now', async () => {
    const page = pageWith({ unauthorized: ['http://app.test/api/v2/me'] });
    await expect(readRefusedRequests(page)).resolves.toEqual(['http://app.test/api/v2/me']);
  });

  it('reads a failing record as no claim', async () => {
    const page = makeFakePage({
      unauthorizedApiRequests: async () => {
        throw new Error('no record');
      },
    });
    await expect(readRefusedRequests(page)).resolves.toEqual([]);
  });
});

describe('the check runner refuses to measure a screen it did not reach signed in', () => {
  it('discloses a 401 gap, contributes no drafts, and records no keyboard walk', async () => {
    const scan = await runnerFor(pageWith({ unauthorized: ['http://app.test/api/v2/me'] }), {
      sessionConfigured: true,
    }).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({ ref: SCREEN.url, state: 'not-covered' });
    expect(scan.gaps[0]?.reason).toContain('401');
    expect(scan.drafts).toEqual([]);
    // The four-stop keyboard transcript from a login page was the loudest wrong number in the
    // real run. It is never collected now, so nothing downstream can read it as this screen's
    // focus order.
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
    expect(scan.reachedSelectorPresent).toBeNull();
  });

  it('discloses a password-field gap at the requested address when a session was configured', async () => {
    const scan = await runnerFor(pageWith({ passwordFields: 1 }), { sessionConfigured: true }).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]?.reason).toContain('asks for a password');
    expect(scan.drafts).toEqual([]);
  });

  it('scans the same page normally when no session was configured', async () => {
    // The signed-out scan an operator asked for. The same page, the same 401s, the same password
    // field, and no assertion that any of it should have been different.
    const scan = await runnerFor(
      pageWith({ passwordFields: 1, unauthorized: ['http://app.test/api/v2/me'] }),
      { sessionConfigured: false },
    ).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
    expect(scan.stops.length).toBeGreaterThan(0);
  });

  it('scans a screen normally when a signed-in load is clean', async () => {
    const scan = await runnerFor(pageWith({ landedUrl: 'http://app.test/users/' }), {
      sessionConfigured: true,
    }).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
    expect(scan.stops.length).toBeGreaterThan(0);
  });

  it('discloses a 401 that only arrives during the walk, and discards what was collected', async () => {
    // The timing window. Readiness settles about 1.5 seconds after a stable shell appears, so an
    // application that sends its identity request later than that has sent nothing at the first
    // read. Proven with the real adapter at three seconds. The second read closes it.
    const scan = await runnerFor(pageWith({ lateUnauthorized: ['http://app.test/api/v2/me'] }), {
      sessionConfigured: true,
    }).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]?.reason).toContain('401');
    // Everything the walk and the providers collected before the refusal showed up is discarded,
    // exactly as it would be had the refusal been there on load.
    expect(scan.drafts).toEqual([]);
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
    expect(scan.reachedSelectorPresent).toBeNull();
  });

  it('scans a genuine signed-in screen with a password field when reachedWhen matches', async () => {
    // A change-password screen. Rule B would discard it on every run; the operator's positive
    // assertion that the screen rendered outranks the heuristic.
    const scan = await runnerFor(pageWith({ passwordFields: 1, reachedWhenMatches: true }), {
      sessionConfigured: true,
      reachedWhen: '#app-shell',
    }).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
    expect(scan.reachedSelectorPresent).toBe(true);
  });

  it('still refuses a 401 screen when reachedWhen matches, because the shell matches on a login wall too', async () => {
    const scan = await runnerFor(
      pageWith({ unauthorized: ['http://app.test/api/v2/me'], reachedWhenMatches: true }),
      { sessionConfigured: true, reachedWhen: '#app-shell' },
    ).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]?.reason).toContain('401');
  });

  it('ignores a third-party 401 and scans the screen', async () => {
    const scan = await runnerFor(pageWith({ unauthorized: ['https://telemetry.vendor.example/collect'] }), {
      sessionConfigured: true,
    }).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
  });

  it('defaults to no configured session when the caller does not say', async () => {
    // Absent means "nobody asserted this run is signed in", which is the honest reading for a
    // caller that never had a session. Rules A and B stay silent; rule C still applies.
    const runner = makeCheckRunner({
      browser: {
        open: async () => pageWith({ passwordFields: 1, unauthorized: ['http://app.test/api/me'] }),
        close: async () => {},
      },
      providers: [loudProvider],
      config: testConfig({ surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [] }] }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
  });
});
