# Contract stability: the plan to a stable, documented 1.0

The profile contract (`packages/profile-contract`) is the API between the core and a profile: the `Profile` object a
profile gives the core, and the `EngineContext` (`ctx`) the core gives each handler. Both run in the same process; the
contract is TypeScript types, not a network protocol. Anyone writing a profile depends on it, so it has to become
stable and documented. This is the plan. Decided 2026-11-10 (`docs/DECISIONS.md`).

## Today: 0.x

- No stability promise. The contract may change in any 0.x release while real profiles show what it needs; each
  change so far is recorded in `docs/DECISIONS.md` with the profile that drove it.
- Documented by the type comments in `packages/profile-contract/src/index.ts` and by `docs/writing-a-profile.md`,
  whose example profile is tested in `npm run check`.
- What is public is not yet drawn sharply. The contract package is public as a whole. The core's entry point today
  exports both what profiles and hosts use (`createEngine`, `createMcpServer`, `registerProfiles`, the hosts, the
  error classes, the output and SPARQL helpers, `createTextPrompt`, `createInstanceRegistry`, `isWorkers`) and
  internals and test hooks (`__setDnsResolverForTests`, `getSafeDispatcher`, `readBoundedBytes`, ...). Drawing that
  line is part of the road to 1.0.

## The road to 1.0

1.0 is released when all of these hold:

1. **Two profiles in production.** Two profiles run as real services, not test instances (expected first: CKAN and
   parliament; the SKOS profile counts as well), so the contract has been shaped by different servers in use.
2. **The open contract questions are decided**, each with a test:
   - capability gating: a tool that needs Node (e.g. one that starts a browser) is registered only where the host can
     run it;
   - the host-policy retry rule: whether a profile can widen what is retried (italianparliament-mcp retries an
     unparsable 2xx), so faithful ports can drop their own retry loops;
   - row output as the rows are (own key order, text only, no cap), so a port can use `rows` instead of its own
     formatting;
   - anything the remaining parliament tools show.
3. **Reviewed with the maintainer who would own it.** If ondata adopts the core, the 1.0 contract is reviewed with
   its maintainer before it is frozen.
4. **The public surface is drawn.** The core's entry point exports only what profiles and hosts use; internals and
   test hooks move to separate, explicitly unstable entry points.
5. **The safeguards and documentation below are in place.**

## After 1.0

(Planned; none of this exists yet.)

- **Semantic versioning for the contract and the public core exports.** A breaking change (a removed or renamed
  member, a narrowed type, a changed meaning) needs a new major version. Additions are minor versions.
- **Deprecation before removal.** A member to be removed is marked `@deprecated`, with what to use instead, for at
  least one minor release before the major release that removes it.
- **A changelog** for the contract and the public core exports, entry by entry, with the migration for each
  breaking change.
- **Contract version and server versions are separate.** Today one version covers the whole platform
  (`docs/DECISIONS.md`, 2026-11-09), and a deployment reports it in `initialize` and `/health`. From 1.0 the contract
  and core packages carry their own version, and each server keeps its own, so a contract major does not change the
  version a CKAN or parliament user sees when that server's behaviour is unchanged.

## Safeguards (to be built before 1.0)

- **An API snapshot.** The public types of the contract and the core are extracted into a checked-in report (API
  Extractor or an equivalent); `npm run check` fails when they change without the report being updated, so no change
  to the API is accidental and every one is visible in review.
- **A conformance test** that every profile runs: tool names carry the profile's prefix (or the profile declares
  none), no telemetry field is a secret, every request goes through `ctx.http`, every tool has a fixture, errors get
  the core's text plus the profile's hint.
- **The example profile is the living reference.** It is kept on the current contract and tested in `npm run check`,
  so the guide cannot drift from the code without a failure.

## Documentation (to be built before 1.0, except the guide, which exists)

- **Reference** to be generated from the types (TypeDoc) and published with each release.
- **Guide**: `docs/writing-a-profile.md`, kept in step with the example profile.
- **A stability section** in the reference: what is public, what is internal, and the versioning rules above.

## Who decides

Until a decision on ownership, Björn. If ondata adopts the core, its maintainer decides contract changes; the rules
above are a proposal for that.
