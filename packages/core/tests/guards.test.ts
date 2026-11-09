// Ported from ondata/ckan-mcp-server tests/unit/http.test.ts (guard sections: lines 14-362, 1025-1053) (commit 09e8cdc). Expectations unchanged;
// only the way the tests reach the code changed (imports, env prefix APP_ instead of ondata's,
// policy-building wrappers in ./helpers.ts). See docs/test-parity.md.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SsrfGuardError, isBlockedIp, getSafeDispatcher, __setDnsResolverForTests } from '../src/index.js';
import { validateServerUrl, createSsrfSafeLookup, assertHttpAllowlistConfigured, assertHostnameResolvesSafe } from './helpers.js';

describe('validateServerUrl', () => {
  it('allows valid http URL', () => {
    expect(() => validateServerUrl('http://portal-b.example')).not.toThrow();
  });

  it('allows valid https URL', () => {
    expect(() => validateServerUrl('https://portal-a.example')).not.toThrow();
  });

  it('blocks non-http/s protocol (file://)', () => {
    expect(() => validateServerUrl('file:///etc/passwd')).toThrow('Disallowed protocol');
  });

  it('blocks non-http/s protocol (ftp://)', () => {
    expect(() => validateServerUrl('ftp://example.com')).toThrow('Disallowed protocol');
  });

  it('refuses blocked literals as SsrfGuardError', () => {
    expect(() => validateServerUrl('http://169.254.169.254/')).toThrow(SsrfGuardError);
    expect(() => validateServerUrl('http://[::1]/')).toThrow(SsrfGuardError);
  });

  it('blocks localhost', () => {
    expect(() => validateServerUrl('http://localhost/api')).toThrow('not allowed');
  });

  it('blocks loopback 127.0.0.1', () => {
    expect(() => validateServerUrl('http://127.0.0.1')).toThrow('private/internal');
  });

  it('blocks loopback 127.x.x.x range', () => {
    expect(() => validateServerUrl('http://127.0.0.2')).toThrow('private/internal');
  });

  it('blocks AWS metadata 169.254.169.254', () => {
    expect(() => validateServerUrl('http://169.254.169.254/latest/meta-data/')).toThrow('private/internal');
  });

  it('blocks private class A (10.x.x.x)', () => {
    expect(() => validateServerUrl('http://10.0.0.1')).toThrow('private/internal');
  });

  it('blocks private class B (172.16.x.x)', () => {
    expect(() => validateServerUrl('http://172.16.0.1')).toThrow('private/internal');
  });

  it('blocks private class C (192.168.x.x)', () => {
    expect(() => validateServerUrl('http://192.168.1.1')).toThrow('private/internal');
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(() => validateServerUrl('http://[::1]')).toThrow('private/internal');
  });

  it('blocks IPv6 unique local fc00::', () => {
    expect(() => validateServerUrl('http://[fc00::1]')).toThrow('private/internal');
  });

  it('blocks IPv6 link-local fe80::', () => {
    expect(() => validateServerUrl('http://[fe80::1]')).toThrow('private/internal');
  });

  it('blocks ip6-localhost (SSRF bypass via /etc/hosts alias)', () => {
    expect(() => validateServerUrl('http://ip6-localhost:8080/api')).toThrow('not allowed');
  });

  it('blocks ip6-loopback (SSRF bypass via /etc/hosts alias)', () => {
    expect(() => validateServerUrl('http://ip6-loopback/api')).toThrow('not allowed');
  });

  it('throws on invalid URL', () => {
    expect(() => validateServerUrl('not-a-url')).toThrow('Invalid URL');
  });

  it('blocks internal IPs in non-dotted encodings (URL normalizes them) — GHSA-8hxx', () => {
    // WHATWG URL normalizes integer/hex/octal/short IPv4 to dotted-decimal.
    for (const u of [
      'http://2130706433/',       // 127.0.0.1 as integer
      'http://0x7f000001/',       // 127.0.0.1 as hex
      'http://0177.0.0.1/',       // 127.x octal first octet
      'http://127.1/',            // short form
      'http://2852039166/',       // 169.254.169.254 as integer
    ]) {
      expect(() => validateServerUrl(u), u).toThrow('private/internal');
    }
  });
});

describe('isBlockedIp', () => {
  it('blocks IPv4 loopback / private / special ranges', () => {
    for (const ip of ['127.0.0.1', '127.0.0.2', '10.0.0.1', '172.16.0.1', '172.31.255.255',
                       '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '255.255.255.255']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback / unique-local / link-local / mapped', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });

  // GHSA-x32r-mh7g-q2rf: IPv6 ranges that embed an IPv4 address reached internal
  // hosts because the classifier only prefix-matched a handful of spellings.
  it('blocks IPv6 ranges embedding IPv4 (NAT64 / 6to4 / IPv4-compatible)', () => {
    for (const ip of [
      '64:ff9b::a9fe:a9fe',    // NAT64 well-known -> 169.254.169.254 (cloud metadata)
      '64:ff9b::a00:1',        // NAT64 -> 10.0.0.1
      '64:ff9b:1::a9fe:a9fe',  // NAT64 local-use -> metadata
      '2002:7f00:1::',         // 6to4 -> 127.0.0.1
      '2002:c0a8:101::',       // 6to4 -> 192.168.1.1
      '::127.0.0.1',           // IPv4-compatible loopback
      '::192.168.1.1',         // IPv4-compatible private
      '::a9fe:a9fe',           // IPv4-compatible metadata
      '2001::1'                // Teredo (hardening, not part of the bypass)
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('classifies on parsed words, not on how the address is spelled', () => {
    for (const ip of ['0064:ff9b::a9fe:a9fe', '64:FF9B:0:0:0:0:A9FE:A9FE',
                      '64:ff9b:0000:0000:0000:0000:a9fe:a9fe', '0:0:0:0:0:0:a9fe:a9fe']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    // public addresses survive the same spellings
    expect(isBlockedIp('2606:4700:4700:0000:0000:0000:0000:1111')).toBe(false);
  });

  it('fails CLOSED on an unparseable IPv6 literal', () => {
    for (const ip of ['::ffff::1', '1:2:3:4:5:6:7:8:9', 'fe80::gggg', '64:ff9b::1.2.3.999']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('blocks the IPv4 benchmarking range 198.18.0.0/15', () => {
    expect(isBlockedIp('198.18.0.1')).toBe(true);
    expect(isBlockedIp('198.19.255.255')).toBe(true);
    expect(isBlockedIp('198.17.0.1')).toBe(false);
    expect(isBlockedIp('198.20.0.1')).toBe(false);
  });

  it("blocks multicast, reserved and site-local ranges", () => {
    for (const ip of ["224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "ff00::1", "ff02::1", "fec0::1", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(isBlockedIp("223.255.255.254")).toBe(false);
  });
});

describe('GHSA-x32r-mh7g-q2rf bypass chain', () => {
  afterEach(() => __setDnsResolverForTests(null));

  it('literal guard rejects an IPv6 literal embedding cloud metadata', () => {
    expect(() => validateServerUrl('http://[64:ff9b::a9fe:a9fe]/')).toThrow('private/internal');
    expect(() => validateServerUrl('http://[2002:c0a8:101::]/api/3')).toThrow('private/internal');
  });

  it('DNS guard rejects a hostname whose AAAA record is a NAT64 metadata address', async () => {
    __setDnsResolverForTests(async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }]);
    await expect(assertHostnameResolvesSafe('nat64.evil')).rejects.toThrow('private/internal');
  });

  it('connection-time lookup rejects the same AAAA record', async () => {
    const lookup = createSsrfSafeLookup({
      lookup: (_h: string, _o: any, cb: any) => cb(null, [{ address: '64:ff9b::a9fe:a9fe', family: 6 }])
    } as any);
    await expect(new Promise((resolve, reject) =>
      lookup('nat64.evil', {}, (err: any, addr: any) => err ? reject(err) : resolve(addr))))
      .rejects.toThrow('private/internal');
  });
});

describe('assertHostnameResolvesSafe', () => {
  afterEach(() => __setDnsResolverForTests(null));

  it('throws SsrfGuardError (never a transport hint) when a hostname resolves to an internal IP', async () => {
    __setDnsResolverForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(assertHostnameResolvesSafe('metadata.evil')).rejects.toBeInstanceOf(SsrfGuardError);
  });

  it('passes for a hostname resolving to a public IP', async () => {
    __setDnsResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(assertHostnameResolvesSafe('example.com')).resolves.toBeUndefined();
  });

  it('throws when a hostname resolves to an internal IP', async () => {
    __setDnsResolverForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(assertHostnameResolvesSafe('metadata.evil')).rejects.toThrow('private/internal');
  });

  it('fails CLOSED when DNS resolution errors (does not proceed)', async () => {
    __setDnsResolverForTests(async () => { throw new Error('ENOTFOUND'); });
    await expect(assertHostnameResolvesSafe('unresolvable.example')).rejects.toThrow('failing closed');
  });
});

describe('createSsrfSafeLookup', () => {
  const fakeDns = (addresses: { address: string; family?: number }[]) => ({
    lookup: (_h: string, _o: any, cb: any) => cb(null, addresses)
  });

  it('passes through when all resolved addresses are public', async () => {
    const lookup = createSsrfSafeLookup(fakeDns([{ address: '93.184.216.34', family: 4 }]));
    const result = await new Promise<any>((resolve, reject) =>
      lookup('example.com', {}, (err: any, addr: any, fam: any) => err ? reject(err) : resolve({ addr, fam })));
    expect(result.addr).toBe('93.184.216.34');
  });

  it('rejects when the hostname resolves to an internal IP (DNS-name bypass)', async () => {
    const lookup = createSsrfSafeLookup(fakeDns([{ address: '127.0.0.1', family: 4 }]));
    await expect(new Promise((resolve, reject) =>
      lookup('evil.lvh.me', {}, (err: any, addr: any) => err ? reject(err) : resolve(addr))))
      .rejects.toThrow('private/internal');
  });

  it('rejects when ANY resolved address is internal (rebinding multi-record)', async () => {
    const lookup = createSsrfSafeLookup(fakeDns([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]));
    await expect(new Promise((resolve, reject) =>
      lookup('mixed.example', {}, (err: any, addr: any) => err ? reject(err) : resolve(addr))))
      .rejects.toThrow('private/internal');
  });
});

type LookupOptions = { all?: boolean; family?: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: { address: string; family: number }[]
) => void;

describe('getSafeDispatcher', () => {
  it('returns a memoized undici dispatcher on Node', async () => {
    const dispatcher: any = await getSafeDispatcher();
    expect(dispatcher).toBeTruthy();
    expect(typeof dispatcher.dispatch).toBe('function');
    expect(await getSafeDispatcher()).toBe(dispatcher);
  });

  // A listener on loopback plus a DNS module we control: if a request ever reaches
  // `hits`, the guard let a connection through to an internal address.
  const withLoopbackListener = async (
    run: (port: number, hits: () => number) => Promise<void>
  ) => {
    const http = await import('node:http');
    let hits = 0;
    const server = http.createServer((_req, res) => { hits++; res.end('reached'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await run(port, () => hits);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };

  const scriptedDns = (answers: string[]) => {
    let calls = 0;
    return {
      calls: () => calls,
      lookup: (_hostname: string, options: LookupOptions | undefined, callback: LookupCallback) => {
        const address = answers[Math.min(calls, answers.length - 1)];
        calls++;
        callback(null, [{ address, family: 4 }]);
      }
    };
  };

  it('rejects a fetch whose hostname resolves to loopback, with a live listener there', async () => {
    const { Agent } = await import('undici');
    await withLoopbackListener(async (port, hits) => {
      const dns = scriptedDns(['127.0.0.1']);
      const dispatcher = new Agent({ connect: { lookup: createSsrfSafeLookup(dns) } });
      try {
        await expect(
          fetch(`http://loopback.example:${port}/`, { dispatcher } as unknown as RequestInit)
        ).rejects.toThrow();
        expect(hits()).toBe(0);
      } finally {
        await dispatcher.close();
      }
    });
  });

  it('pins the connection to the first resolution, so rebinding cannot swap in loopback', async () => {
    const { Agent } = await import('undici');
    await withLoopbackListener(async (port, hits) => {
      // First answer is public (192.0.2.1, TEST-NET-1: allowed but unroutable), every
      // later answer is the loopback the listener sits on. A second resolution would
      // land on the listener; pinning means there is no second resolution.
      const dns = scriptedDns(['192.0.2.1', '127.0.0.1']);
      const dispatcher = new Agent({
        connect: { lookup: createSsrfSafeLookup(dns), timeout: 500 }
      });
      try {
        await expect(
          fetch(`http://rebind.example:${port}/`, {
            dispatcher,
            signal: AbortSignal.timeout(3000)
          } as unknown as RequestInit)
        ).rejects.toThrow();
        expect(dns.calls()).toBe(1);
        expect(hits()).toBe(0);
      } finally {
        await dispatcher.close();
      }
    });
  });
});

describe('assertHttpAllowlistConfigured', () => {
  const origAllowed = process.env.APP_ALLOWED_DOMAINS;
  const origAllowAll = process.env.APP_HTTP_ALLOW_ALL;

  afterEach(() => {
    if (origAllowed === undefined) delete process.env.APP_ALLOWED_DOMAINS; else process.env.APP_ALLOWED_DOMAINS = origAllowed;
    if (origAllowAll === undefined) delete process.env.APP_HTTP_ALLOW_ALL; else process.env.APP_HTTP_ALLOW_ALL = origAllowAll;
  });

  it('throws when no allowlist and no opt-out', () => {
    delete process.env.APP_ALLOWED_DOMAINS;
    delete process.env.APP_HTTP_ALLOW_ALL;
    expect(() => assertHttpAllowlistConfigured()).toThrow('Refusing to start HTTP transport');
  });

  it('passes when allowlist is set', () => {
    process.env.APP_ALLOWED_DOMAINS = 'www.portal-a.example';
    delete process.env.APP_HTTP_ALLOW_ALL;
    expect(() => assertHttpAllowlistConfigured()).not.toThrow();
  });

  it('passes (with warning) when explicit opt-out is set', () => {
    delete process.env.APP_ALLOWED_DOMAINS;
    process.env.APP_HTTP_ALLOW_ALL = 'true';
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => assertHttpAllowlistConfigured()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('validateServerUrl — APP_ALLOWED_DOMAINS', () => {
  const origEnv = process.env.APP_ALLOWED_DOMAINS;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.APP_ALLOWED_DOMAINS;
    else process.env.APP_ALLOWED_DOMAINS = origEnv;
  });

  it('allows any domain when env var is unset', () => {
    delete process.env.APP_ALLOWED_DOMAINS;
    expect(() => validateServerUrl('https://portal-c.example')).not.toThrow();
  });

  it('allows domain present in the list', () => {
    process.env.APP_ALLOWED_DOMAINS = 'portal-a.example,portal-b.example';
    expect(() => validateServerUrl('https://portal-a.example')).not.toThrow();
  });

  it('blocks domain not in the list', () => {
    process.env.APP_ALLOWED_DOMAINS = 'portal-a.example';
    expect(() => validateServerUrl('https://portal-c.example')).toThrow('not in the allowed list');
  });

  it('ignores empty entries (trailing/leading commas)', () => {
    process.env.APP_ALLOWED_DOMAINS = ',portal-a.example,';
    expect(() => validateServerUrl('https://portal-a.example')).not.toThrow();
  });
});

