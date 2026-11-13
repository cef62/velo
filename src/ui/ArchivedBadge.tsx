import { Archive } from "lucide-react";
import { css } from "styled-system/css";
import { Badge } from "@/components/ui";

// A list row is a size container whose font size is the list font (em below = that font). The text badge costs ~72 px;
// it shows only while the title keeps about 8em beside it (measured in the demo: row width >= 119 px + 9.2em, i.e. the
// list's fixed 72 px for badge and gaps, 8em of title, and the date and padding that grow with the font). Narrower rows
// swap it for the Archive icon (36 px); the word stays in the DOM, visually hidden, so the row's accessible name is unchanged.
// If a webview ignores the query the text badge stays: today's look.
export const rowBox = css({ containerType: "inline-size", fontSize: "var(--velo-list-fs)" });

const icon = css({ display: "none", w: "12px", h: "12px", "@container (max-width: calc(119px + 9.2em))": { display: "block" } });
const word = css({ "@container (max-width: calc(119px + 9.2em))": { srOnly: true } });

export const ArchivedBadge = () => (
  <Badge size="sm" variant="subtle" flex="none">
    <Archive aria-hidden className={icon} />
    <span className={word}>archived</span>
  </Badge>
);
