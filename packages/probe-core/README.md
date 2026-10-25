# @probelab/core

`@probelab/core` is the engine independent ProbeLab runner for deterministic simulation probes. It has no Node, DOM, Three.js, React, or game package dependency. The package is ESM and ships TypeScript declarations.

This package is MIT licensed; source and local tarball reuse are supported. It has not been published to npm.

## Build and verify

From the repository root:

```sh
npm run build --prefix packages/probe-core
npm run test --prefix packages/probe-core
```

The test command builds the declarations and JavaScript, then runs the core's `node:test` suite.

## Public API

The package root exports the public types and functions. An adapter owns game-specific state, commands, physics, and codecs; core owns deterministic scheduling, inspection, traces, package validation, replay, and minimization.

| API | Purpose |
| --- | --- |
| `ProbeAdapter<State>` | Encodes and decodes world/config/start/state/command DTOs; performs a pure fixed-step simulation; provides inspection geometry and the explicit oracle config. |
| `createRunController(adapter, request, strategy)` | Creates an incremental run. Use `advance(n)`, `pause()`, `resume()`, and `cancel()` to bound work between host/UI turns. |
| `runCase(adapter, request, strategy)` | Runs a case to completion or first fault for headless callers. `request.maxTicks` remains a hard limit. |
| `deriveSeed(...parts)` / `deriveCaseSeed(root, map, case, probe)` | Derives stable SHA-256 seeds without shared PRNG state. |
| `createProbePackage(adapter, request, result)` | Exports an actual run result as a validated `ProbePackage`. |
| `importProbePackage(input, limits?)` | Parses and validates JSON text or UTF-8 bytes. Returns `{ok:true,value}` or a structured error. |
| `verifyPackageIntegrity(pkg, limits?)` | Validates an in-memory package and returns an error string, or `undefined` when valid. |
| `checkCompatibility(pkg, adapter)` | Reports adapter descriptor differences after package integrity validation. |
| `replayPackage(adapter, pkg, options)` | Strictly reproduces a package, or explicitly tests it against a healthy regression target. |
| `minimizeFailure(...)` / `minimizeFailureAsync(...)` | Searches deletion and neutral-command candidates and returns only evidenced results. |

The full adapter contract and call signatures are in [CONTRACT.md](./CONTRACT.md). A strategy may inject action selection, coverage keys, neutral input, and command normalization; no game-specific controls are built into core.

## Package format

`ProbePackage` is data only. Schema version 1 contains:

- `tool: {name:'ProbeLab', version:'0.1.0'}` and a versioned simulation `descriptor`;
- explicit `oracle` thresholds, world/config hashes, coverage counts, case seed and initial/final PRNG state;
- encoded world, config, start, finite initial state, standalone `debugWorld`, and the exact per-tick commands;
- an outcome (`failed`, `healthy`, or `incomplete`) and each tick's complete state DTO plus canonical `stateHash`;
- `integrity: {algorithm:'sha256', contentHash}`.

The content hash covers the entire package body, including tool version, descriptor, inputs, commands, coverage, and trace. Canonical JSON uses UTF-8 SHA-256, sorts object keys by Unicode code point, preserves array order, and serializes `-0` as `0`. Replay validates the package body and hash itself; callers do not have to import first.

Data is never evaluated as code. The importer rejects unknown or missing schema fields, accessors, cycles, non-plain objects, prototype-pollution keys, untagged non-finite numbers, malformed special-number tags, and invalid or excessive structures. Default import limits are 32 MiB, depth 96, 1,000,000 data nodes, arrays of 250,000 items, strings of 1,000,000 UTF-16 code units, and at most 3,600 commands and trace ticks. Hosts can supply stricter or larger `ImportLimits` explicitly.

The tags `{"$probeNumber":"NaN"}`, `{"$probeNumber":"+Infinity"}`, and `{"$probeNumber":"-Infinity"}` are allowed only in post-step state snapshots and only at descriptor-declared `numericPaths`. Initial state must be finite. World, config, start, command, geometry, and metadata fields do not accept these tags.

## Replay and minimization

`{mode:'strict'}` checks tool/package integrity, descriptor compatibility, world/config/oracle hashes, the debug collision scene, start-state round-trip, every recorded command, every full tick-state hash, and the first failure. If `targetWorld` or `targetConfig` is supplied, it must match the stored hash.

`{mode:'regress', targetWorld?, targetConfig?}` explicitly runs the stored start and commands against a target adapter/build. It reports target hash and descriptor differences and evaluates the target outcome without comparing its state hashes to the old build's state hashes.

Minimization requires an injected `budget.clock` and has hard run, tick, and elapsed-time budgets. Core never reads a wall clock. The async form yields between candidate work and bounded replay batches, so a host can deliver cancellation; it returns the best verified candidate found so far, or the original package if cancellation arrives before a candidate run. A result is marked `reduced` only after two final runs agree on failure signature, tick, and complete failure state.
