# `@probelab/cli` (0.1.0)

Node.js command line and programmatic entry point for ProbeLab. The `probe` executable uses the trusted `@probelab/sandbox` registry by default, so it does not load the FPS game. A host can supply a different trusted registry through the public `main(args, registry, io?)` API.

```text
probe run --scenario drop --seed demo --probes 16 --ticks 3600 --concurrency 4 --output ./probe-output
probe check ./probe-output/cases/probe-0001.probe.json
probe replay ./probe-output/cases/probe-0001.probe.json
probe minimize ./probe-output/cases/probe-0001.probe.json --budget runs=500,ticks=3600,ms=10000
probe regress ./probe-output/cases/probe-0001.probe.json --adapter sandbox-fixed --target-scenario healthy --allow-world-change --allow-config-change
```

The CLI writes exactly one JSON document to stdout. Progress and human-readable errors go to stderr. Reports are written under `--output` in JSON, Markdown, or both (`--format json|md|both`). Fault packets are saved under `cases/`; use `--save-all` to retain healthy packets as well. `--max-faults` and `--max-output-bytes` cap saved packet evidence. Runs also cap a case at 3,600 ticks and a command at 1,000,000 total probe ticks.

Exit codes are `0` for a healthy run or successful replay/regression, `1` for a detected fault or failed expectation, `2` for invalid input, incompatible adapters, or simulation errors, and `130` for interrupted runs with an incomplete report.

Input files are data only. They cannot name modules to load or execute. The API registry must be provided by trusted host code:

```ts
import { main, type ProbeRegistry } from '@probelab/cli';

declare const trustedRegistry: ProbeRegistry;
const result = await main(['run', '--scenario', 'healthy'], trustedRegistry);
```

This package is MIT licensed. No npm publication is performed by this repository.
