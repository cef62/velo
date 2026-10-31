---
created: {{-47 19:30}}
modified: {{-12 21:00}}
tags: [reading]
---
# CRDT reading notes

Notes from the papers and blog posts on conflict-free replicated data types.

- **G-Set** — grow-only set; merge is union. Perfect for check-in logs.
- **OR-Set** — add and remove, each add tagged with a unique id.
- **LWW-Register** — last writer wins; needs a total order on timestamps.

The key insight: if merge is commutative, associative and idempotent, replicas converge no matter the order messages arrive in.

Used for the sync layer of Project Lantern. Also on my [[Reading list]].
