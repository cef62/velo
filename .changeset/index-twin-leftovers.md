---
"velo": patch
---

Fixed a locked note's text staying searchable through a plain copy beside it when the two names differ only in letter case (including `ß`/`ss` and similar pairs), when the title is not a valid file name (such as `What?`), when either copy could not be read yet (an offline cloud file), or after the note was renamed in letter case only and then locked; a plain note also no longer gets a second search entry or shows as changed at every rescan in these cases. A locked copy that is a link (git-annex) still locks its plain copy, a folder named like a locked note no longer hides the plain note's text from search, and a locked copy left by a failed lock now shows in the note list at once and the error names it.
