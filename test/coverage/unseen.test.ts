import { describe, it, expect } from 'vitest';
import { markUnseenScreens } from '../../src/coverage/unseen.js';
import type {
  Draft,
  RuleApplicability,
  RuleOutcome,
  ScreenScan,
  TranscriptStop,
} from '../../src/contracts/index.js';

function draft(screenId: string, overrides: Partial<Draft> = {}): Draft {
  return {
    rule: 'landmark-one-main',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: 'html',
    elementName: null,
    role: null,
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: {},
    confidence: 'fail',
    ...overrides,
  };
}

const stop = (elementPath: string): TranscriptStop => ({ index: 0, elementPath, announcement: [] });

function scan(overrides: Partial<ScreenScan> & { screenId: string; url: string }): ScreenScan {
  return {
    stops: [],
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
    ...overrides,
  };
}

function applicability(screenId: string, rule: string, outcome: RuleOutcome): RuleApplicability {
  return { screenId, layer: 'axe', rule, outcome, elementCount: outcome === 'inapplicable' ? 0 : 1 };
}

describe('markUnseenScreens', () => {
  it('reads the nth-child ancestry a live page reports for the document body', () => {
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', stops: [stop('html > body:nth-child(2)')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['overview']);
  });

  it('does not read a body-prefixed tag as the body', () => {
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', stops: [stop('html > body:nth-child(2) > bodyguard')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
  });

  it('treats an empty transcript as no evidence, not as a blank page', () => {
    // Nothing was recorded about the keyboard walk. That is not the same claim as a walk that
    // found nowhere to go, and calling it unseen would drop findings on no grounds at all.
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', drafts: [draft('overview')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
    expect(pass.screens[0]?.drafts).toHaveLength(1);
  });

  it('keeps two different-URL screens with identical drafts, both with drafts intact', () => {
    // Regression guard for the removed duplicate-render heuristic. Two different URLs that carry
    // the same barrier produce identical draft identities. That is real coverage, not a blank page,
    // so nothing may be stripped. reachedSelectorPresent is null on both (no reachedWhen declared).
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', stops: [stop('button')], drafts: [draft('overview')] }),
      scan({ screenId: 'jobs', url: 'http://app/jobs', stops: [stop('button')], drafts: [draft('jobs')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
    expect(pass.screens[0]?.drafts).toHaveLength(1);
    expect(pass.screens[1]?.drafts).toHaveLength(1);
  });

  it('does not call one URL scanned twice a duplicate render', () => {
    // The app and docs profiles can both target one URL and honestly report the same
    // identities. This must pass through untouched with reachability null.
    const pass = markUnseenScreens([
      scan({ screenId: 'page-app', url: 'http://app/page', stops: [stop('button')], drafts: [draft('page-app')] }),
      scan({ screenId: 'page-docs', url: 'http://app/page', stops: [stop('button')], drafts: [draft('page-docs')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
  });

  it('marks a screen unseen when a declared reachability selector was absent', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('#save')],
        drafts: [draft('overview')],
        applicability: [applicability('overview', 'video-caption', 'inapplicable')],
        reachedSelectorPresent: false,
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['overview']);
    expect(pass.screens[0]?.drafts).toEqual([]);
    expect(pass.screens[0]?.applicability).toEqual([]);
    const gap = pass.screens[0]?.gaps.find((g) => g.state === 'not-covered');
    expect(gap).toBeDefined();
    expect(gap?.ref).toBe('http://app/overview');
    expect(gap?.reason).toContain('reachedWhen');
  });

  it('names the missing selector in the gap reason when the surface carries one', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('#save')],
        reachedSelectorPresent: false,
        reachedWhenSelector: 'main#app-root',
      }),
    ]);
    const gap = pass.screens[0]?.gaps.find((g) => g.state === 'not-covered');
    expect(gap?.reason).toContain('main#app-root');
  });

  it('passes a screen through untouched when its reachability selector matched', () => {
    // This is the false positive the removed detector caused: a screen that shares a fingerprint
    // with another must keep its drafts once we have positive proof it rendered.
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('#save')],
        drafts: [draft('overview')],
        reachedSelectorPresent: true,
      }),
      scan({
        screenId: 'jobs',
        url: 'http://app/jobs',
        stops: [stop('#save')],
        drafts: [draft('jobs')],
        reachedSelectorPresent: true,
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
    expect(pass.screens[0]?.drafts).toHaveLength(1);
    expect(pass.screens[1]?.drafts).toHaveLength(1);
  });

  it('lets isBodyOnly still fire when reachability is null', () => {
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', stops: [stop('html > body:nth-child(2)')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['overview']);
    const gap = pass.screens[0]?.gaps.find((g) => g.state === 'not-covered');
    expect(gap?.reason).toContain('keyboard stop');
  });

  it('records one gap when both isBodyOnly and an absent selector fire on the same screen', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('html > body:nth-child(2)')],
        drafts: [draft('overview')],
        reachedSelectorPresent: false,
        reachedWhenSelector: '#app-root',
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['overview']);
    const notCovered = pass.screens[0]?.gaps.filter((g) => g.state === 'not-covered') ?? [];
    expect(notCovered).toHaveLength(1);
    expect(notCovered[0]?.reason).toContain('keyboard stop');
    expect(notCovered[0]?.reason).toContain('#app-root');
  });

  it('still marks a body-only screen unseen even when its reachability selector matched', () => {
    // The two signals are independent. reachedSelectorPresent true only means "do not raise the
    // reachedWhen gap", never "cancel the body-only gap". A selector aimed at a persistent app shell
    // element (header, nav, footer) matches on every route, including a login wall or a screen that
    // threw on mount while the shell survived. Those screens are still body-only, so they stay unseen
    // and their drafts are dropped. Suppressing the body-only gap here would mint a false green.
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('html > body:nth-child(2)')],
        drafts: [draft('overview')],
        reachedSelectorPresent: true,
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['overview']);
    expect(pass.screens[0]?.drafts).toEqual([]);
    const gap = pass.screens[0]?.gaps.find((g) => g.state === 'not-covered');
    expect(gap?.reason).toContain('keyboard stop');
  });

  it('strips applicability as well as drafts from a screen it cannot claim it saw', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('html > body:nth-child(2)')],
        drafts: [draft('overview')],
        applicability: [
          applicability('overview', 'video-caption', 'inapplicable'),
          applicability('overview', 'html-has-lang', 'passed'),
        ],
      }),
    ]);

    expect(pass.unseenScreenIds).toEqual(['overview']);
    expect(pass.screens[0]?.drafts).toEqual([]);
    expect(pass.screens[0]?.applicability).toEqual([]);
  });

  it('keeps applicability on a screen it did see', () => {
    const entry = applicability('overview', 'video-caption', 'inapplicable');
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('#save')],
        drafts: [draft('overview')],
        applicability: [entry],
      }),
    ]);

    expect(pass.unseenScreenIds).toEqual([]);
    expect(pass.screens[0]?.applicability).toEqual([entry]);
  });

  it('marks a screen unseen when its declared readiness response never arrived', () => {
    // A passkey or magic-link sign-in page makes no API call and has real focusable controls, so
    // neither the body-only floor nor a refused request says anything. The screen's own data
    // request never succeeding is the positive evidence that is missing.
    const pass = markUnseenScreens([
      scan({
        screenId: 'orders',
        url: 'http://app/orders',
        stops: [stop('button#passkey')],
        drafts: [draft('orders')],
        reachedResponseSeen: false,
        reachedWhenResponse: '/api/orders',
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['orders']);
    expect(pass.screens[0]?.drafts).toEqual([]);
    expect(pass.screens[0]?.gaps).toHaveLength(1);
    expect(pass.screens[0]?.gaps[0]?.reason).toContain('/api/orders');
  });

  it('keeps a screen whose declared readiness response arrived', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'orders',
        url: 'http://app/orders',
        stops: [stop('button#refresh')],
        drafts: [draft('orders')],
        reachedResponseSeen: true,
        reachedWhenResponse: '/api/orders',
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
    expect(pass.screens[0]?.drafts).toHaveLength(1);
  });

  it('marks a screen unseen when its selector matched but its response never arrived', () => {
    // Both parts of a declared signal have to hold. A selector that a sign-in page happens to
    // match does not cancel a missing data response.
    const pass = markUnseenScreens([
      scan({
        screenId: 'orders',
        url: 'http://app/orders',
        stops: [stop('button#refresh')],
        drafts: [draft('orders')],
        reachedSelectorPresent: true,
        reachedWhenSelector: 'main',
        reachedResponseSeen: false,
        reachedWhenResponse: '/api/orders',
      }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['orders']);
  });

  it('keeps the gaps a scan already reported', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('html > body:nth-child(2)')],
        gaps: [{ ref: 'provider:walk', state: 'capability-denied', reason: 'provider walk denied capability: live' }],
      }),
    ]);
    expect(pass.screens[0]?.gaps.map((gap) => gap.state)).toEqual(['capability-denied', 'not-covered']);
  });
});
