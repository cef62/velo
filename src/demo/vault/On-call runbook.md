---
created: {{-44 11:00}}
modified: {{-7 16:30}}
tags: [work]
---
# On-call runbook

## Balance endpoint is slow

1. Check the p95 dashboard
2. Look for long-running reconciliation queries
3. If the replica lag is above 30 s, fail reads over to the primary

## Webhooks are backing up

1. Check the queue depth
2. Scale the consumer deployment to 6 replicas
3. Page the integrations team if a single merchant is above 50% of the queue

## Escalation

Payments: Priya → Tomás. Data: Lena.
