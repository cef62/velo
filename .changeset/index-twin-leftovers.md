---
"velo": patch
---

Fixed a plain note beside a locked copy keeping its text in search, getting a second search entry, or showing as changed at every rescan when the two names differ only in letter case (including `ß`/`ss` and similar pairs), when the title is not a valid file name (such as `What?`), or when the plain copy could not be read (offline cloud file); a locked copy that is a link (git-annex) still locks its plain copy, a folder named like a locked note no longer hides the plain note's text from search, and a locked copy left by a failed lock now shows in the note list at once.
