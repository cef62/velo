---
created: {{-10 14:00}}
modified: {{-2 09:30}}
tags: [work, meeting]
---
# Meeting — Payments retro

## What went well

- The dual-write phase caught two rounding bugs before customers did
- Pairing between backend and data teams

## What didn't

- The reconciliation job ran for 9 hours on the first night
- Alerts fired on the old system for a week after the cutover

## Actions

- [x] Silence legacy alerts after cutover @done({{-8}})
- [ ] Partition the reconciliation job by merchant 📅 {{+10}}
- [ ] Write the lessons into the [[On-call runbook]]

See [[Payments migration]].
