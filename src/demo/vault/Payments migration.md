---
created: {{-52 09:00}}
modified: {{-2 17:10}}
tags: [work]
---
# Payments migration

Moving balances and ledger entries from the old monolith database to the new payments service.

## Phases

1. **Dual write** — every ledger write goes to both stores. Done.
2. **Backfill** — copy history merchant by merchant. Done.
3. **Read switch** — balance endpoint reads from the new store behind a flag. In progress.
4. **Cleanup** — drop the old tables after 30 quiet days.

## Risks

- Reconciliation job is slow (see [[Meeting — Payments retro]])
- Rounding: always store minor units as integers

- [ ] Flip the read flag for 10% of merchants 📅 {{+3}}
- [ ] Plan the cleanup window with the DBAs

#work
