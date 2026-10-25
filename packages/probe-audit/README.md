# @probelab/audit

Engine-independent directed map checks. MIT licensed, no game code or renderer dependency.

Provide `AuditMap` (surface IDs and bounds, spawn points, explicit routes, actor profile, semantic source hash) and an `AuditDriver` that calls your real fixed-step movement implementation. Run `auditMap(map, driver, options)`. Each route is tried normally and, when needed, with jump recovery. Records retain actual commands, state snapshots, arrivals and stalled motion. Call `importAuditReport` for bounded data-only import with content-hash verification.

Confirmed malformed bounds/spawn overlaps are `error`; route, visual/collision/shot and hidden-collider discrepancies are `review`. A stalled route is not a proof of global unreachability. Visual comparison covers declared axis-aligned boxes, not screenshot aesthetics or arbitrary triangle meshes. Default ray tests represent blocking without weapon-specific penetration. The host owns mapping its actual renderer/collision/shot policies into the surface channels.

`sourceHash` must include map data, movement/simulation implementation and audit-driver versions. It is an integrity/replay compatibility marker, not a trusted cryptographic signature.

Default budgets: 24 routes, 1200 ticks/attempt; configurable up to 256 routes/3600 ticks. Imports are bounded to 32MiB/3 million data nodes; extremely large exports may require splitting runs. Cancellation/budget exhaustion is marked incomplete. See the standalone demo for a working adapter.
