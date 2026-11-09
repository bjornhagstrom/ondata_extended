/**
 * SSRF guards: literal URL checks, the domain allowlist, admin-listed private hosts,
 * DNS-resolution checks and connection-time DNS pinning.
 *
 * Derived from ondata/ckan-mcp-server src/utils/http.ts (commit 09e8cdc), lines 147-160,
 * 463-473 and 578-843. What changed: the settings come from a `NetPolicy` built from the
 * deployment's configuration instead of fixed environment variable names (messages name
 * whatever variable the deployment uses), and the private-host exemption applies only to a
 * request that asks for it (deviations D1 and D4 in docs/test-parity.md).
 */

import type { EngineConfig } from "@ondata-extended/profile-contract";
import { readList } from "../config.js";
import { isBlockedIp } from "./ip.js";

/**
 * A request refused by one of the SSRF/domain-safety guards before any connection was made.
 * The message is a verdict: the destination will never pass, so callers must not turn it
 * into a "retry later" hint.
 */
export class SsrfGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfGuardError";
  }
}

/** The hostname could not be resolved, so it could not be checked: the request is refused (fail closed). */
export class DnsResolutionError extends SsrfGuardError {
  constructor(readonly hostname: string) {
    super(`Cannot resolve "${hostname}" for SSRF validation (failing closed).`);
    this.name = "DnsResolutionError";
  }
}

/** Where outbound requests may go. */
export interface NetPolicy {
  /** Empty = any public host. */
  allowedDomains: string[];
  /** Exact host names that may be private (loopback, RFC 1918, unique-local). Empty = none. */
  privateHosts: string[];
  /** Variable names, for messages. */
  names: { allowedDomains: string; privateHosts: string; httpAllowAll: string };
}

export function netPolicyFromConfig(config: EngineConfig): NetPolicy {
  return {
    allowedDomains: readList(config, "ALLOWED_DOMAINS"),
    privateHosts: readList(config, "PRIVATE_HOSTS"),
    names: {
      allowedDomains: config.nameOf("ALLOWED_DOMAINS"),
      privateHosts: config.nameOf("PRIVATE_HOSTS"),
      httpAllowAll: config.nameOf("HTTP_ALLOW_ALL")
    }
  };
}

const stripBrackets = (h: string) => h.toLowerCase().trim().replace(/^\[|\]$/g, "");

export function isPrivateHostAllowed(hostname: string, policy: NetPolicy): boolean {
  const h = stripBrackets(hostname);
  if (h === "") return false;
  return policy.privateHosts.some((e) => stripBrackets(e) === h);
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/**
 * Validate that a URL is safe to request. Blocks non-HTTP/S protocols and private/internal
 * IP *literals* (a listed private host passes only with `allowPrivateHosts`), and enforces
 * the domain allowlist. Hostnames that resolve to internal IPs
 * are blocked later, at connection time, by the DNS guards.
 */
export function validateUrl(url: string, policy: NetPolicy, opts: { allowPrivateHosts?: boolean; allowlistHostname?: string } = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfGuardError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfGuardError(`Disallowed protocol "${parsed.protocol}". Only http and https are allowed.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  // The private-host exemption applies only to a request that asks for it. Node does not
  // call the dispatcher's DNS lookup for an IP literal, so for a literal this check is the
  // only guard: a strict request must refuse a listed private literal here.
  const privateOk = opts.allowPrivateHosts === true && isPrivateHostAllowed(hostname, policy);

  if (BLOCKED_HOSTNAMES.has(hostname) && !privateOk) {
    throw new SsrfGuardError(`Access to "${hostname}" is not allowed.`);
  }

  // WHATWG URL already normalizes integer/hex/octal/short IPv4 forms (0x7f000001 →
  // 127.0.0.1) to dotted-decimal, so one dotted-quad check covers them (GHSA-8hxx).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isBlockedIp(hostname, privateOk)) {
    throw new SsrfGuardError(`Access to private/internal IP addresses is not allowed.`);
  }

  // IPv6 literals keep their brackets in URL.hostname.
  if (hostname.startsWith("[") && isBlockedIp(hostname.slice(1, -1), privateOk)) {
    throw new SsrfGuardError(`Access to private/internal IPv6 addresses is not allowed.`);
  }

  // A profile that rewrites the caller's host to a known API host (a registry entry) has the
  // caller's host checked against the allowlist instead; every other guard sees the real URL.
  const listed = (opts.allowlistHostname ?? hostname).toLowerCase();
  if (policy.allowedDomains.length > 0 && !policy.allowedDomains.includes(listed)) {
    throw new SsrfGuardError(`Domain "${listed}" is not in the allowed list (${policy.names.allowedDomains}).`);
  }
}

/**
 * A redirect may enter a listed private host only from another listed host, so a public
 * server cannot answer with a 302 to e.g. `http://localhost:5003/` and have us follow it.
 */
export function assertRedirectKeepsPrivateExemption(fromHostname: string, toUrl: string, policy: NetPolicy): void {
  const to = new URL(toUrl).hostname.toLowerCase();
  if (isPrivateHostAllowed(to, policy) && !isPrivateHostAllowed(fromHostname, policy)) {
    throw new SsrfGuardError(
      `A redirect from "${fromHostname}" to "${to}" is not allowed: ` +
      `a private host (${policy.names.privateHosts}) can only be reached from a listed host.`
    );
  }
}

/** With a network-exposed transport a listed private host is reachable by every client. */
export function warnIfPrivateHostsOverHttp(policy: NetPolicy): void {
  if (policy.privateHosts.length === 0) return;
  console.error(
    `[SECURITY WARNING] ${policy.names.privateHosts} is set with the HTTP transport: ${policy.privateHosts.join(", ")} ` +
    "can be reached by every client of this server. List only hosts you want all clients to reach."
  );
}

/**
 * Refuse to run a network-exposed transport without a domain allowlist, unless the
 * deployment explicitly opts out (then warn). stdio is unaffected.
 */
export function assertHttpAllowlistConfigured(config: EngineConfig): void {
  const policy = netPolicyFromConfig(config);
  if (policy.allowedDomains.length > 0) return;

  if (config.get("HTTP_ALLOW_ALL") === "true") {
    console.error(
      "[SECURITY WARNING] HTTP transport is running WITHOUT a domain allowlist " +
      `(${policy.names.httpAllowAll}=true). Any client can drive requests to arbitrary hosts. ` +
      `Set ${policy.names.allowedDomains} to restrict which hosts can be queried.`
    );
    return;
  }

  throw new Error(
    "Refusing to start HTTP transport without a domain allowlist.\n" +
    `Set ${policy.names.allowedDomains}="host1.org,host2.gov" to restrict which hosts can be queried,\n` +
    `or set ${policy.names.httpAllowAll}=true to explicitly run without restriction (NOT recommended when network-exposed).`
  );
}

// ---------------------------------------------------------------------------------------
// DNS guards

export type ResolvedAddress = { address: string; family?: number };
export type DnsLookupModule = {
  lookup: (
    hostname: string,
    options: { all: true; family?: number },
    callback: (err: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void
  ) => void;
};

/**
 * A Node `lookup` (for undici/http Agents) that resolves the hostname, rejects if ANY
 * resolved address is private/internal, and pins the connection to the validated address:
 * no second resolution, so no DNS rebinding window.
 * Strict by default; `allowPrivateHosts` lets a listed host resolve to a private address.
 */
export function createSsrfSafeLookup(
  dnsModule: DnsLookupModule,
  settings: { allowPrivateHosts?: boolean; policy?: NetPolicy } = {}
) {
  return function ssrfSafeLookup(hostname: string, options: any, callback: any): void {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const family = options && typeof options === "object" ? options.family : undefined;
    const allowPrivate = settings.allowPrivateHosts === true && !!settings.policy &&
      isPrivateHostAllowed(hostname, settings.policy);
    dnsModule.lookup(hostname, { all: true, family: family || 0 }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [addresses as ResolvedAddress];
      for (const a of list) {
        if (isBlockedIp(a.address, allowPrivate)) {
          callback(new SsrfGuardError(
            `Access to private/internal IP addresses is not allowed ` +
            `("${hostname}" resolves to ${a.address}).`
          ));
          return;
        }
      }
      if (options && options.all) {
        callback(null, list);
        return;
      }
      callback(null, list[0].address, list[0].family);
    });
  };
}

type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;
let dnsResolverOverride: DnsResolver | null = null;

/** Test seam: override the resolver used by `assertHostnameResolvesSafe`. */
export function __setDnsResolverForTests(fn: DnsResolver | null): void {
  dnsResolverOverride = fn;
}

/**
 * Resolve a hostname and throw if it maps to a private/internal IP. Defence in depth for
 * redirect hops and runtimes without a pinning dispatcher. A no-op where DNS is unavailable
 * (Cloudflare Workers: the platform blocks internal egress). Fails closed when resolution
 * itself fails.
 */
export async function assertHostnameResolvesSafe(
  hostname: string,
  settings: { allowPrivateHosts?: boolean; policy?: NetPolicy } = {}
): Promise<void> {
  let lookup: DnsResolver;
  if (dnsResolverOverride) {
    lookup = dnsResolverOverride;
  } else {
    let dnsMod: any;
    try {
      // String-concatenated specifier: keeps esbuild from bundling a Node builtin into the
      // Workers build.
      dnsMod = await import("node:" + "dns");
    } catch {
      return;
    }
    lookup = (h: string) => dnsMod.promises.lookup(h, { all: true });
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new DnsResolutionError(hostname);
  }

  const allowPrivate = settings.allowPrivateHosts === true && !!settings.policy &&
    isPrivateHostAllowed(hostname, settings.policy);
  for (const a of addresses) {
    if (isBlockedIp(a.address, allowPrivate)) {
      throw new SsrfGuardError(
        `Access to private/internal IP addresses is not allowed ` +
        `("${hostname}" resolves to ${a.address}).`
      );
    }
  }
}

type UndiciModule = { Agent: new (options: { connect: { lookup: unknown } }) => unknown };

const dispatchers = new Map<string, Promise<unknown | null>>();

/**
 * An undici Dispatcher whose connections resolve through `createSsrfSafeLookup`, so
 * `fetch()` connects to exactly the address that was validated. Memoized per
 * (strict | private-allowing + list). Null off Node (Workers).
 */
export function getSafeDispatcher(settings: { allowPrivateHosts?: boolean; policy?: NetPolicy } = {}): Promise<unknown | null> {
  const allowPrivate = settings.allowPrivateHosts === true && !!settings.policy && settings.policy.privateHosts.length > 0;
  const key = allowPrivate ? `private:${settings.policy!.privateHosts.join(",")}` : "strict";
  let entry = dispatchers.get(key);
  if (!entry) {
    entry = (async () => {
      try {
        const dnsMod = (await import("node:" + "dns")) as unknown as DnsLookupModule;
        // Assembled at runtime: esbuild constant-folds `"undici" + ""` and would bundle
        // undici into the browser-platform Workers build.
        const undiciSpecifier = ["und", "ici"].join("");
        const undiciMod = (await import(undiciSpecifier)) as UndiciModule;
        const lookup = createSsrfSafeLookup(dnsMod, allowPrivate ? { allowPrivateHosts: true, policy: settings.policy } : {});
        return new undiciMod.Agent({ connect: { lookup } });
      } catch {
        return null;
      }
    })();
    dispatchers.set(key, entry);
  }
  return entry;
}
