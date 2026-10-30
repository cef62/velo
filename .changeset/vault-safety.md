---
"velo": patch
---

Made the notes folder safer: renaming or merging a note no longer garbles linked notes that aren't UTF-8; a locked `.txt` note's leftover plain copy stays hidden from AI agents; locking or unlocking no longer reports a failure after the note has already moved; files left in the notes folder by a crash are cleaned up when the vault opens (a stray plaintext temp file is deleted and a note hidden mid-rename comes back); agent summaries of a note are wiped when it is locked; Lock all now refreshes the Connections view; changing the notes folder closes the note from the old folder instead of leaving it editable with failing saves; and with front-matter dates off, a note's created date no longer jumps to the last save.
