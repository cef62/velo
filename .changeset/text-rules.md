---
"velo": patch
---

Tags, tag removal, links and tasks now share one rule for what counts as code: fenced blocks follow CommonMark (a ```` ```` ```` fence is not closed by an inner ```` ``` ````) and indented code blocks are skipped everywhere, so a `#tag` inside code no longer shows up in the tag panel, and an agent's tag removal removes every tag the panel shows. Renaming or merging a note no longer rewrites `[[links]]` inside code blocks, and links in code no longer count as backlinks. A title can no longer contain `]` (it becomes `-`, like `/`), because it broke every `[[link]]` to the note. On macOS, a note whose file name the volume stores decomposed (HFS+, SMB shares) no longer appears twice in the list.
