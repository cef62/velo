---
"velo": patch
---

Fixed an agent being told "velo did not answer" when you typed in the open note while velo saved its change, and fixed `add_task` and `set_task_done` replying with a hash that could cover your newer typing: the agent now gets the hash its own save left (so its next hash-guarded write can't overwrite your typing), or the conflict error.
