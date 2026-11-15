---
"velo": patch
---

Fixed the "more window errors suppressed" count reaching velo.log when an error flood was the last thing that happened, once its 10 seconds had passed, and made agent setup failures in velo.log name their kind (for example `io NotFound`) instead of only a size.
