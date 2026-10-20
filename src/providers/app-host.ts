/**
 * Whether a request went to the application itself.
 *
 * One definition, shared by the refused-request rule and the readiness response signal, so the two
 * can never disagree about which traffic is the application's. The match is on hostname, not
 * origin: a request counts when its hostname equals the `appBaseUrl` hostname, or ends with a dot
 * followed by it. Scheme and port are ignored. `api.example.com` counts for `example.com`;
 * `notexample.com` does not, because the dot is required. See refusalsFromAppHost in
 * redirected.ts for why an origin comparison was too narrow.
 *
 * What to do when a hostname cannot be read is NOT decided here, because the two callers need
 * opposite answers. The refused-request rule counts an unreadable address, which fails toward a
 * gap. The readiness signal does not count one, which also fails toward a gap.
 */

/** The hostname of `appBaseUrl`, or null when it does not parse or has none. */
export function appHostname(appBaseUrl: string): string | null {
  try {
    const host = new URL(appBaseUrl).hostname;
    return host.length === 0 ? null : host;
  } catch {
    return null;
  }
}

/** The hostname of a request address, or null when it does not parse. */
export function requestHostname(url: string): string | null {
  try {
    // URL lowercases a hostname and encodes a unicode one as punycode, so both sides of the
    // comparison are already in one form and no case folding of our own is needed.
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isAppHost(host: string, appHost: string): boolean {
  return host === appHost || host.endsWith(`.${appHost}`);
}
