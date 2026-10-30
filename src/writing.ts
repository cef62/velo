/** Suggested title for text moved to a new note: its first non-blank line without list/heading/task markers, at most 60 code points. */
export function extractTitle(selection: string): string {
  const line = selection.split("\n").find((l) => l.trim() !== "") ?? "";
  return Array.from(line.replace(/^(?:[#\-*\s]|\[[ xX]\])+/, "")).slice(0, 60).join("").trimEnd();
}
