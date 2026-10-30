---
"velo": patch
---

Tags, tag removal, links and tasks now share one rule for what counts as code: fenced blocks, following CommonMark (a ```` ```` ```` fence is not closed by an inner ```` ``` ````). A `#tag` inside such a block no longer shows up in the tag panel, and an agent's tag removal now removes every tag the panel shows. Renaming or merging a note no longer rewrites `[[links]]` inside fenced code, and links there no longer count as backlinks. New titles and renames can no longer contain `]`, which broke every `[[link]]` to the note; existing files with `]` keep working. On macOS, a note whose file name the volume stores decomposed (HFS+, SMB shares) no longer appears twice in the list, and its saves are no longer reported as outside changes.
