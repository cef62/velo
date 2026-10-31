---
created: {{-33 20:15}}
modified: {{-2 23:10}}
tags: [side-project]
---
# Lantern — sync design

Back to [[Project Lantern]].

Each device keeps an append-only log of habit check-ins. A check-in is `(habit_id, day, device_id, lamport)`. Merging two logs is a set union, so there are no conflicts to resolve — the property I liked most in the [[CRDT reading notes]].

Open questions:

- How to delete a habit? Tombstones, probably.
- Do I need vector clocks, or is a Lamport counter plus device id enough for ordering?
- What happens when the clocks on two phones disagree by a day?

- [ ] Write a property test: merge is commutative and idempotent 📅 {{+3}}
- [ ] Benchmark merging 10k check-ins

#ideas
