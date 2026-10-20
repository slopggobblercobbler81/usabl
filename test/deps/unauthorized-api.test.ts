/**
 * The primary signal for "this run did not reach the screen signed in": the page's own data
 * requests came back 401.
 *
 * Why this and not the address or the DOM. The application that produced the defect never leaves
 * the requested URL. It renders a blank shell for over five seconds, then swaps a login form in at
 * the same address, so a scan that settles mid transition sees neither a changed URL nor a password
 * field. Its API calls to identity endpoints are refused from the first moment of load, so this
 * signal is present before anything renders and cannot be raced by render timing. On a healthy
 * signed-in load of the same screen, nine API responses were all 200 and there were no 401s.
 *
 * The rule is narrow on purpose and both halves are held here: only 401, and only the page's own
 * fetch or XHR traffic.
 */
import { describe, expect, it } from 'vitest';
import { makeNetworkActivityTracker, type RequestEvents, type ResponseEvent } from '../../src/deps/real.js';

interface Emitter {
  page: RequestEvents;
  respond(spec: { status: number; url: string; resourceType: string }): void;
}

function emitter(): Emitter {
  const responseHandlers: Array<(response: ResponseEvent) => void> = [];
  const page = {
    on(event: string, handler: unknown): void {
      if (event === 'response') {
        responseHandlers.push(handler as (response: ResponseEvent) => void);
      }
    },
  } as unknown as RequestEvents;
  return {
    page,
    respond(spec) {
      const response: ResponseEvent = {
        status: () => spec.status,
        url: () => spec.url,
        request: () => ({ resourceType: () => spec.resourceType }),
      };
      for (const handler of responseHandlers) {
        handler(response);
      }
    },
  };
}

describe('the tracker records the page data requests that were refused', () => {
  it('records a 401 fetch and a 401 xhr, in arrival order', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    respond({ status: 200, url: 'http://app.test/api/v2/ping', resourceType: 'fetch' });
    respond({ status: 401, url: 'http://app.test/api/v2/me', resourceType: 'fetch' });
    respond({ status: 401, url: 'http://app.test/api/v2/config', resourceType: 'xhr' });

    expect(tracker.unauthorizedApiUrls()).toEqual([
      'http://app.test/api/v2/me',
      'http://app.test/api/v2/config',
    ]);
  });

  it('records nothing on a healthy signed-in load', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    for (let index = 0; index < 9; index += 1) {
      respond({ status: 200, url: `http://app.test/api/v2/r${index}`, resourceType: 'fetch' });
    }

    expect(tracker.unauthorizedApiUrls()).toEqual([]);
  });

  it('ignores 403, which means authenticated and not permitted', () => {
    // A signed-in scan can legitimately meet a resource this identity may not have. Treating that
    // as a dead session would turn a correct run into a coverage gap. 401 is the one status HTTP
    // defines as "not authenticated".
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    respond({ status: 403, url: 'http://app.test/api/v2/admin', resourceType: 'fetch' });
    respond({ status: 404, url: 'http://app.test/api/v2/gone', resourceType: 'fetch' });
    respond({ status: 500, url: 'http://app.test/api/v2/boom', resourceType: 'xhr' });

    expect(tracker.unauthorizedApiUrls()).toEqual([]);
  });

  it('ignores a 401 on an asset, which is a missing file and not a refused session', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    for (const resourceType of ['document', 'stylesheet', 'image', 'font', 'script', 'media']) {
      respond({ status: 401, url: `http://app.test/${resourceType}`, resourceType });
    }

    expect(tracker.unauthorizedApiUrls()).toEqual([]);
  });

  it('survives a response that throws when read, and keeps the rest', () => {
    // A response from a frame that has already gone can throw on a status read. A listener that
    // threw would take down the page event emitter and cost the whole scan.
    const responseHandlers: Array<(response: ResponseEvent) => void> = [];
    const page = {
      on(event: string, handler: unknown): void {
        if (event === 'response') {
          responseHandlers.push(handler as (response: ResponseEvent) => void);
        }
      },
    } as unknown as RequestEvents;
    const tracker = makeNetworkActivityTracker(page);

    const exploding: ResponseEvent = {
      status: () => {
        throw new Error('response is gone');
      },
      url: () => 'http://app.test/api/gone',
      request: () => ({ resourceType: () => 'fetch' }),
    };
    const refused: ResponseEvent = {
      status: () => 401,
      url: () => 'http://app.test/api/v2/me',
      request: () => ({ resourceType: () => 'fetch' }),
    };

    for (const handler of responseHandlers) {
      expect(() => handler(exploding)).not.toThrow();
      handler(refused);
    }

    expect(tracker.unauthorizedApiUrls()).toEqual(['http://app.test/api/v2/me']);
  });

  it('hands back a copy, so a caller cannot edit the record', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);
    respond({ status: 401, url: 'http://app.test/api/v2/me', resourceType: 'fetch' });

    tracker.unauthorizedApiUrls().push('http://app.test/api/v2/invented');

    expect(tracker.unauthorizedApiUrls()).toEqual(['http://app.test/api/v2/me']);
  });
});

describe('the tracker records every page data response, so a refusal can be read against what came after it', () => {
  it('records fetch and xhr responses with their status, in arrival order', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    respond({ status: 401, url: 'http://app.test/api/me', resourceType: 'fetch' });
    respond({ status: 200, url: 'http://app.test/auth/refresh', resourceType: 'xhr' });
    respond({ status: 200, url: 'http://app.test/api/me', resourceType: 'fetch' });

    expect(tracker.apiResponses()).toEqual([
      { url: 'http://app.test/api/me', status: 401, contentType: null, sentBeforeWalk: true },
      { url: 'http://app.test/auth/refresh', status: 200, contentType: null, sentBeforeWalk: true },
      { url: 'http://app.test/api/me', status: 200, contentType: null, sentBeforeWalk: true },
    ]);
  });

  it('leaves out documents and assets, because only the page script asking for data counts', () => {
    // An authentication wall answers 200 to its own document and stylesheet. Counting those would
    // let any page satisfy a response signal.
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);

    for (const resourceType of ['document', 'stylesheet', 'image', 'font', 'script']) {
      respond({ status: 200, url: `http://app.test/api/orders/${resourceType}`, resourceType });
    }

    expect(tracker.apiResponses()).toEqual([]);
  });

  it('hands back a copy, so a caller cannot edit the record', () => {
    const { page, respond } = emitter();
    const tracker = makeNetworkActivityTracker(page);
    respond({ status: 200, url: 'http://app.test/api/orders', resourceType: 'fetch' });

    tracker.apiResponses().push({ url: 'http://app.test/api/invented', status: 200, contentType: null, sentBeforeWalk: true });

    expect(tracker.apiResponses()).toEqual([{ url: 'http://app.test/api/orders', status: 200, contentType: null, sentBeforeWalk: true }]);
  });
});

/**
 * A driver that emits request events as well as responses, with request objects the response
 * points back to, the way Playwright does. It is what the walk-start mark is measured against.
 */
interface FakeRequest {
  resourceType(): string;
  redirectedFrom(): FakeRequest | null;
}

function fullEmitter() {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const page = {
    on(event: string, handler: (arg?: unknown) => void): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as RequestEvents;
  const emit = (event: string, arg?: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      handler(arg);
    }
  };
  return {
    page,
    send(resourceType = 'fetch', redirectedFrom: FakeRequest | null = null): FakeRequest {
      const request: FakeRequest = { resourceType: () => resourceType, redirectedFrom: () => redirectedFrom };
      emit('request', request);
      return request;
    },
    answer(request: FakeRequest, spec: { status: number; url: string; headers?: Record<string, string> }) {
      const response = {
        status: () => spec.status,
        url: () => spec.url,
        headers: () => spec.headers ?? {},
        request: () => request,
      };
      emit('response', response);
      emit('requestfinished', request);
    },
  };
}

describe('the tracker records what kind of answer each data response was', () => {
  it('records the content type the response carried, or null when it carried none', () => {
    const { page, send, answer } = fullEmitter();
    const tracker = makeNetworkActivityTracker(page);

    answer(send(), { status: 200, url: 'http://app.test/api/orders', headers: { 'content-type': 'application/json' } });
    answer(send(), { status: 200, url: 'http://app.test/api/fallback', headers: { 'content-type': 'text/html; charset=utf-8' } });
    answer(send(), { status: 204, url: 'http://app.test/api/empty' });

    expect(tracker.apiResponses().map((response) => response.contentType)).toEqual([
      'application/json',
      'text/html; charset=utf-8',
      null,
    ]);
  });
});

describe('the tracker records whether each data request was sent before the walk began', () => {
  it('counts a request sent before the mark even when its answer arrives after it', () => {
    // The two reads exist for a slow answer: a request the page sent on load and the server
    // answered during the walk is still the page loading, not something usabl caused.
    const { page, send, answer } = fullEmitter();
    const tracker = makeNetworkActivityTracker(page);

    const slow = send();
    tracker.markWalkStart();
    answer(slow, { status: 200, url: 'http://app.test/api/orders' });

    expect(tracker.apiResponses()).toEqual([
      { url: 'http://app.test/api/orders', status: 200, contentType: null, sentBeforeWalk: true },
    ]);
  });

  it('does not count a request sent after the mark, such as one a check caused', () => {
    const { page, send, answer } = fullEmitter();
    const tracker = makeNetworkActivityTracker(page);

    answer(send(), { status: 200, url: 'http://app.test/api/load' });
    tracker.markWalkStart();
    answer(send(), { status: 200, url: 'http://app.test/api/clicked' });

    expect(tracker.apiResponses().map((response) => [response.url, response.sentBeforeWalk])).toEqual([
      ['http://app.test/api/load', true],
      ['http://app.test/api/clicked', false],
    ]);
  });

  it('dates a redirected request by the request that started the chain', () => {
    const { page, send, answer } = fullEmitter();
    const tracker = makeNetworkActivityTracker(page);

    const first = send();
    tracker.markWalkStart();
    const hop = send('fetch', first);
    answer(hop, { status: 200, url: 'http://app.test/api/orders' });

    expect(tracker.apiResponses()[0]?.sentBeforeWalk).toBe(true);
  });

  it('reads every request as sent before the walk until the mark is set', () => {
    const { page, send, answer } = fullEmitter();
    const tracker = makeNetworkActivityTracker(page);

    answer(send(), { status: 200, url: 'http://app.test/api/orders' });

    expect(tracker.apiResponses()[0]?.sentBeforeWalk).toBe(true);
  });

  it('does not count a response whose request it never saw sent once the mark is set', () => {
    // Nothing proves such a request came before the walk, so it does not count.
    const { page, answer } = fullEmitter();
    const tracker = makeNetworkActivityTracker(page);
    tracker.markWalkStart();

    answer({ resourceType: () => 'fetch', redirectedFrom: () => null }, { status: 200, url: 'http://app.test/api/x' });

    expect(tracker.apiResponses()[0]?.sentBeforeWalk).toBe(false);
  });
});
