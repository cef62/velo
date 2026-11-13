import { Archive } from "lucide-react";
import { css } from "styled-system/css";
import { Badge } from "@/components/ui";

// A list row is a size container whose font size is the list font (em below = that font). The text badge costs ~62 px;
// it shows only while the title keeps about 8em beside it. Each list has its own fixed part (date or clock time, due label,
// checkbox, padding), measured in the demo as row width at which the title in a text-badge row falls to 8em:
//   notes    119 px + 9.2em  (date scales with the font)
//   timeline 113 px + 10.5em (the clock time is wider and scales faster)
//   task     219 px + 8em    (row with a due label; the Tasks row does not grow with the font, only the task text)
//   head     231 px          (Tasks group header: fixed uiSm size, so 8 chars of it, no em)
// Narrower rows swap the badge for the Archive icon (34 px); the word stays in the DOM, visually hidden, so the row's
// accessible name is unchanged. Container conditions cannot read var(), so each list gets its own literal query.
// If a webview ignores the query the text badge stays: today's look.
export const rowBox = css({ containerType: "inline-size", fontSize: "var(--velo-list-fs)" });

const icon = css({ display: "none", w: "12px", h: "12px" });
const at = {
  notes: css({ "@container (max-width: calc(119px + 9.2em))": { "& svg": { display: "block" }, "& span": { srOnly: true } } }),
  timeline: css({ "@container (max-width: calc(113px + 10.5em))": { "& svg": { display: "block" }, "& span": { srOnly: true } } }),
  task: css({ "@container (max-width: calc(219px + 8em))": { "& svg": { display: "block" }, "& span": { srOnly: true } } }),
  head: css({ "@container (max-width: 231px)": { "& svg": { display: "block" }, "& span": { srOnly: true } } }),
};

export const ArchivedBadge = ({ list }: { list: keyof typeof at }) => (
  <Badge size="sm" variant="subtle" flex="none" className={at[list]}>
    <Archive aria-hidden className={icon} />
    <span>archived</span>
  </Badge>
);
