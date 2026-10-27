/** Error text for the UI; the "indexing" rejection (raw, or as reported by the saver) is not an error. */
export const errText = (e: unknown) =>
  e === "indexing" || e === "Save failed: indexing" ? "Still indexing…" : e === "not-found" ? "Note no longer exists" : e === "no-folder" ? "No notes folder" : String(e);
