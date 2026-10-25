# `@probelab/core` public contract (v0.1.0)

The first public API is defined in `src/types.ts`; implementations and consumers should depend on these names. The core is adapter driven and owns scheduling, deterministic random streams, inspection ordering, trace/package validation, replay, and minimization. It never imports host APIs or game code. `State`, `Command`, `World`, `Config`, and `Start` are supplied by an adapter; package boundaries store validated, versioned DTOs.

## Adapter and run

`ProbeAdapter<State>` declares a `SimulationDescriptor`, data-only encode/decode methods for world/config/start/state/command, `createInitialState`, `cloneState`, pure fixed-`dt` `step`, `inspect`, `toDebugWorld`, and `getOracleConfig(config)`. The oracle config is read explicitly from scenario config: `boundsMode:'position'|'actor'`, enabled axes (`x/y/z`), per-axis tolerance tuple, and penetration epsilon. `inspect` returns required numeric state fields plus optional AABBs and stable-ID colliders. Adapters may implement `validateStart`; an illegal initial state becomes `invalid-start` and is never counted as a simulation fault. `toDebugWorld` supplies a small data-only scene that makes imported records viewable without game assets.

`CommandStrategy<State>.nextCommand(context)` is called by the scheduler with a case-local `RandomSource`, current state/inspection, stable case seed, and per-case `CoverageSnapshot`. `coverageKey` lets a strategy expose spatial or other finite coverage buckets; `adapter.coverageCapacity` is optional and only then can core report a meaningful visited/capacity ratio. This is the injection point for action-sequence and coverage-biased policies; no game-specific commands or coordinates live in core. `deriveSeed(...parts)` provides stable SHA-256 seed derivation.

Command DTOs represent complete per-tick input. If an adapter uses edge fields or explicit tick numbers, its strategy supplies `normalizeCommands(commands)` so every deletion or neutral replacement rebuilds those fields before execution; the default assumes absolute per-tick intent.

`createRunController(adapter, request, strategy)` returns a bounded, synchronous controller. The host calls `advance(n)` to execute at most `n` ticks per UI turn, and controls it with `pause()`, `resume()`, and `cancel()`. `runCase` is the unbounded convenience API for trusted headless callers; callers still provide `maxTicks`. The first deterministic fault ends the case. Simulation exceptions are returned as `error`, never mislabeled as a numeric fault.

Exported signatures are:

```ts
createRunController<State>(adapter, request, strategy): RunController<State>
runCase<State>(adapter, request, strategy): CaseResult
createProbePackage<State>(adapter, request, result): ProbePackage
importProbePackage(input: string | Uint8Array, limits?): ImportResult
checkCompatibility<State>(pkg, adapter): CompatibilityResult
replayPackage<State>(adapter, pkg, {mode:'strict'|'regress', targetWorld?, targetConfig?}): ReplayResult
minimizeFailure<State>(adapter, pkg, strategy, budget): MinimizeResult
minimizeFailureAsync<State>(adapter, pkg, strategy, budget, {yield}?): Promise<MinimizeResult>
deriveSeed(...parts: string[]): string
```

## Checks and stable ordering

For each post-step observation the built-in oracle checks, in order: numeric non-finite fields, world bounds, solid actor/collider AABB penetration. Multiple hits are ordered by path, axis/direction, or collider ID. Signatures identify the rule and target, not the tick. Invalid start validation is separate. AABB touching and overlap at or below `penetrationEpsilon` are not penetration. Missing geometry disables only the corresponding geometric oracle; adapter-specific checks can be supplied as a host-side strategy/checker in later compatible protocol versions.

## Packages, replay, regression, and import

`ProbePackage` is data only and carries the exact tool identity `{name:'ProbeLab',version:'0.1.0'}` (covered by the content hash), descriptor, oracle, encoded inputs, normalized world/config SHA-256 hashes, initial state, standalone debug geometry, commands, per-tick complete state summaries and actor AABBs, PRNG initial/final state, outcome, coverage, and SHA-256 integrity hash. `createProbePackage` exports a real `CaseResult`; `importProbePackage(input: string | Uint8Array)` performs byte/depth/node/array/string/command/trace limits, strict schema checks, special-number placement checks, and canonical content-hash validation before returning data. `verifyPackageIntegrity` repeats those structural and content-hash checks for direct in-memory callers; replay never relies on an earlier import call. It never evaluates strings as code or imports modules from package fields.

`checkCompatibility(package, adapter)` reports exact compatibility differences. `replayPackage(adapter, package, {mode:'strict'})` requires adapter/simulation implementation, world, config, state/command/schema, tick rate and oracle compatibility, then compares complete state hashes and the first failure signature. `{mode:'regress', targetWorld?, targetConfig?}` is an explicit healthy-target check: keeps original start/commands, requires valid target start, reports declared world/config hash differences, and does not compare target state hashes to the old baseline.

## Minimize

`minimizeFailure(adapter, package, strategy, budget)` and `minimizeFailureAsync(adapter, package, strategy, budget, {yield})` execute deletion and neutral-command candidates from the same initial state, accept only a matching *first* failure signature, and preserve the original package evidence. They report attempts, elapsed time, tick counts, and stop reason. Supply `budget.clock` for time accounting; core never reads `Date.now` or `performance`. The async form yields at candidate and bounded replay-batch boundaries so hosts can receive cancellation, then returns the best verified candidate so far (or the original package if cancellation arrives before any candidate run); it marks a result `reduced` only after two final runs match the same complete failure state. Cancellation/run/tick/time budgets return the best verified package so far or an honest non-reproduction result.

## Canonical data and special values

Canonical hashing is UTF-8 SHA-256 over compact canonical JSON: object keys sort by Unicode code point, arrays keep order, finite numbers use ECMAScript JSON number serialization, and `-0` canonicalizes to `0`. DTOs reject undefined, cycles, non-plain objects, prototype-pollution keys, non-finite numbers, and non-string object keys. The explicit tags `{"$probeNumber":"NaN"}`, `{"$probeNumber":"+Infinity"}`, and `{"$probeNumber":"-Infinity"}` are accepted only in post-step state/trace/failure-state snapshots and only at descriptor-declared numeric paths. They are rejected in world/config/start/command/geometry/metadata, encoded initial state, and at any other state path.

All core APIs are pure with respect to the host: no implicit clock, global randomness, filesystem, process, DOM, renderer, or mutable cross-case state. Wall time may only be read by the explicit minimization accounting wrapper and never influences choices or results.
