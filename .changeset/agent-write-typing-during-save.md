---
"velo": patch
---

Fixed an agent being told "velo did not answer" when you typed in the open note while velo saved its change: it now gets the hash its own save left (so its next hash-guarded write can't overwrite your typing), or the conflict error.
