---
"velo": patch
---

Fixed agent edits that write the same bytes the note already holds leaving an undo revision, an agent `add_task` on a closed note that hit a conflict not naming its conflict copy, and `rename_note` reporting "no answer" or "busy" for a rename that had succeeded.
