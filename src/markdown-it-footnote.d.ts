// The plugin ships no types; @types/markdown-it-footnote targets the old @types/markdown-it, not markdown-it 15's own.
declare module "markdown-it-footnote" {
  import type { PluginSimple } from "markdown-it";
  const footnote: PluginSimple;
  export default footnote;
}
