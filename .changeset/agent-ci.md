---
"velo": patch
---

Fix `velo --mcp` answering "busy" forever after a crash when the leftover agent file pointed at a reused process id: it now works directly on the notes again. "Copy setup command" now gives the AppImage's real path instead of its temporary mount path on Linux.
