---
"velo": patch
---

Fixed `rename_note` replying with a hash that could cover your typing saved right after the rename, and fixed an agent write to the open note, after an outside tool changed only its line endings, replying with an out-of-date hash or going to a conflict copy: the agent now gets the hash of the note as its own call left it.
