---
created: {{-38 22:00}}
modified: {{-30 22:45}}
tags: [reading, books]
---
# Book — A Philosophy of Software Design

John Ousterhout. Short, opinionated, very good.

> Complexity is anything related to the structure of a software system that makes it hard to understand and modify.

## Ideas I want to keep

- **Deep modules**: a simple interface over a lot of functionality. Shallow modules add interface cost without hiding much.
- **Information leakage** is the real enemy, more than duplication.
- Define errors out of existence where you can.
- Comments should describe what is not obvious from the code.

Applied the deep-module idea to the ledger exporter in the Payments migration.

From my [[Reading list]].
