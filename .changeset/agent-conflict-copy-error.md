---
"velo": patch
---

Fixed an agent edit to the note open in velo reporting success when the note changed on disk meanwhile and the edit went to a conflict copy: the agent now gets an error that names the copy.
