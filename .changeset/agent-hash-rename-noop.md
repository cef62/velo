---
"velo": patch
---

Fixed `rename_note` replying with a hash that could cover your typing saved right after the rename, and an agent write that changed nothing in the open note replying with an out-of-date hash after a line-ending-only change on disk: the agent now gets the hash of the note as its own call left it.
