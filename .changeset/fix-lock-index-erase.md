---
"velo": patch
---

Locking a note now fails, leaving the note unlocked, when its text cannot be erased from the search index; before, the lock reported success and the note's plain text stayed findable in search (and its tasks and tags listed) until velo noticed the deleted file, or until the next launch if the index kept failing.
