---
"velo": patch
---

Re-indexing many changed notes (after a git checkout or a sync) took seconds instead of minutes, and search and editing stayed responsive while it ran; locking a note stayed instant. If velo quit or crashed during such a re-index, the next launch rebuilt the search index once.
