/**
 * The per-screen readiness signal: positive evidence that the screen really rendered.
 *
 * A signal is a CSS selector, a data response, or both. Each declared part has to hold. A sign-in
 * page that makes no API call and carries no password field, an authentication wall that answers
 * 200 to everything, and a magic-link page all fail it, because none of them renders the screen's
 * own content or asks for the screen's own data.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePage } from '../../src/deps/fakes.js';
import {
  measureReadiness,
  readinessMet,
  readinessSignalOf,
  responseSignalSeen,
} from '../../src/providers/reachability.js';

const APP = 'http://app.test:8080';

describe('readinessSignalOf', () => {
  it('reads no declaration as no signal', () => {
    expect(readinessSignalOf(undefined)).toBeNull();
  });

  it('reads a bare string as a selector, which is the shape every existing config uses', () => {
    expect(readinessSignalOf('table#orders')).toEqual({ selector: 'table#orders', response: null });
  });

  it('reads the object form', () => {
    expect(readinessSignalOf({ response: '/api/orders' })).toEqual({ selector: null, response: '/api/orders' });
    expect(readinessSignalOf({ selector: 'h1#orders', response: '/api/orders' })).toEqual({
      selector: 'h1#orders',
      response: '/api/orders',
    });
  });
});

describe('responseSignalSeen', () => {
  it('is seen when the application answered the path with a success', () => {
    expect(responseSignalSeen([{ url: `${APP}/api/orders`, status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', APP)).toBe(true);
  });

  it('counts a deeper path and a query, at a segment boundary only', () => {
    expect(responseSignalSeen([{ url: `${APP}/api/orders/42?x=1`, status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', APP)).toBe(true);
    expect(responseSignalSeen([{ url: `${APP}/api/orders-archive`, status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', APP)).toBe(
      false,
    );
  });

  it('counts an API subdomain of the application host, on any scheme and port', () => {
    expect(
      responseSignalSeen([{ url: 'https://api.app.test/api/orders', status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', APP),
    ).toBe(true);
  });

  it('does not count another host, so a third-party service cannot stand in for the screen', () => {
    expect(
      responseSignalSeen([{ url: 'http://notapp.test/api/orders', status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', APP),
    ).toBe(false);
  });

  it('does not count a refusal, a redirect, or a server error', () => {
    for (const status of [401, 403, 302, 404, 500]) {
      expect(responseSignalSeen([{ url: `${APP}/api/orders`, status, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', APP)).toBe(false);
    }
  });

  it('counts nothing when appBaseUrl cannot be read, so the screen becomes a gap', () => {
    expect(responseSignalSeen([{ url: `${APP}/api/orders`, status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/orders', 'not a url')).toBe(
      false,
    );
  });

  it('compares the configured path in the encoded form the browser sends', () => {
    expect(
      responseSignalSeen([{ url: `${APP}/api/%C3%A9t%C3%A9/list`, status: 200, contentType: 'application/json', sentBeforeWalk: true }], '/api/été', APP),
    ).toBe(true);
  });
});

describe('responseSignalSeen and what kind of answer counts', () => {
  const json = { contentType: 'application/json', sentBeforeWalk: true };

  it('does not count an HTML answer, whatever its case or parameters', () => {
    // A sign-in page, an SSO proxy, or a dev server history fallback that answers the data call
    // with index.html and a 200 has not sent the screen its data.
    for (const contentType of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML;charset=UTF-8', ' text/html ']) {
      expect(
        responseSignalSeen([{ url: `${APP}/api/orders`, status: 200, contentType, sentBeforeWalk: true }], '/api/orders', APP),
      ).toBe(false);
    }
  });

  it('counts a data answer, and one that carries no content type at all', () => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'text/plain', null]) {
      expect(
        responseSignalSeen([{ url: `${APP}/api/orders`, status: 200, contentType, sentBeforeWalk: true }], '/api/orders', APP),
      ).toBe(true);
    }
  });

  it('does not count a request sent after the walk began, so a check cannot satisfy the signal', () => {
    expect(
      responseSignalSeen([{ url: `${APP}/api/orders`, status: 200, ...json, sentBeforeWalk: false }], '/api/orders', APP),
    ).toBe(false);
  });
});

describe('readinessMet', () => {
  it('makes no claim when nothing was declared', () => {
    expect(readinessMet({ selectorPresent: null, responseSeen: null })).toBeNull();
  });

  it('holds only when every declared part holds', () => {
    expect(readinessMet({ selectorPresent: true, responseSeen: null })).toBe(true);
    expect(readinessMet({ selectorPresent: null, responseSeen: true })).toBe(true);
    expect(readinessMet({ selectorPresent: true, responseSeen: true })).toBe(true);
    expect(readinessMet({ selectorPresent: true, responseSeen: false })).toBe(false);
    expect(readinessMet({ selectorPresent: false, responseSeen: true })).toBe(false);
  });
});

describe('measureReadiness', () => {
  it('measures each declared part against the live page', async () => {
    const page = makeFakePage({
      queryAll: async () => [{ selector: 'table#orders' }],
      apiResponses: async () => [{ url: `${APP}/api/orders`, status: 200, contentType: 'application/json', sentBeforeWalk: true }],
    });
    await expect(
      measureReadiness(page, { selector: 'table#orders', response: '/api/orders' }, APP),
    ).resolves.toEqual({ selectorPresent: true, responseSeen: true });
  });

  it('makes no claim for a part that was not declared', async () => {
    const page = makeFakePage({ queryAll: async () => [{ selector: 'x' }] });
    await expect(measureReadiness(page, null, APP)).resolves.toEqual({ selectorPresent: null, responseSeen: null });
    await expect(measureReadiness(page, { selector: 'x', response: null }, APP)).resolves.toEqual({
      selectorPresent: true,
      responseSeen: null,
    });
  });

  it('reads a response record that cannot be fetched as not seen, never as seen', async () => {
    const page = makeFakePage({
      apiResponses: async () => {
        throw new Error('no record');
      },
    });
    await expect(measureReadiness(page, { selector: null, response: '/api/orders' }, APP)).resolves.toEqual({
      selectorPresent: null,
      responseSeen: false,
    });
  });
});
