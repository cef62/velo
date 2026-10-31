---
created: {{-55 21:05}}
modified: {{-1 22:40}}
tags: [side-project, ideas]
---
# Project Lantern

An offline-first habit tracker. Works with no account and no server; syncs between my phone and laptop when both are on the same network.

## Why

Every habit app I tried wants a login and a subscription. I want something that feels like a paper notebook but nags me a little.

## Pieces

- Local store: SQLite on desktop, IndexedDB in the browser build
- Sync: see [[Lantern — sync design]]
- UI: a single week view, one row per habit

## Status

- [x] Data model sketched @done({{-40}})
- [x] Week view prototype @done({{-21}})
- [ ] Peer discovery over mDNS 📅 {{+6}}
- [ ] Export to CSV

Related reading: [[CRDT reading notes]]. Might become the example for my [[Conference talk proposal]].
