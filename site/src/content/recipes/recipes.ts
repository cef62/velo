// The recipes: one page each under /recipes/<slug>/. Keyboard steps name an Action, so the keys shown are the app's real
// defaults (src/shortcuts.ts); fixed keys (Enter, Esc, arrows) are given as [macOS, Windows/Linux]. Agent recipes take
// their tool calls and results from transcripts.json, written by `cargo test recipe_transcripts` (src-tauri).
import type { Action } from '../../../../src/shortcuts.ts';

export type Fixed = readonly [mac: string, other: string];
export type KeyStep = {
  /** Shortcut: an Action (its default binding) or fixed keys. */
  keys?: Action | Fixed;
  /** A pointer or menu step instead of (or with) keys. */
  act?: string;
  /** Text typed, shown monospace with a caret. */
  text?: string;
  /** Keys pressed after the text (e.g. Enter). */
  after?: Fixed;
  /** What you see. May hold inline HTML (<code>). */
  result: string;
};
type Common = {
  slug: string;
  title: string;
  summary: string;
  goal: string;
  prerequisites: string[];
  shot: string;
  /** Inline HTML allowed. */
  why: string;
};
export type KeysRecipe = Common & { kind: 'keys'; steps: KeyStep[] };
export type AgentRecipe = Common & { kind: 'agent'; transcript: string; prompt: string; answer: string };
export type Recipe = KeysRecipe | AgentRecipe;

const ENTER: Fixed = ['↩', 'Enter'];
const ESC: Fixed = ['Esc', 'Esc'];
const AGENT_PREREQ = [
  'Settings → General → Agent access (MCP) turned on and saved.',
  'Claude Code set up with the command from Settings → Copy setup command (<code>claude mcp add velo -- &lt;path to velo&gt; --mcp</code>). macOS or Linux.',
];

export const recipes: Recipe[] = [
  {
    kind: 'keys',
    slug: 'capture',
    title: 'Capture a thought from anywhere, and the daily note',
    summary: 'Quick capture adds a task without leaving what you are doing; the daily note is one shortcut away.',
    goal: 'Write down a to-do from any app in two keystrokes, then plan the day in today’s note.',
    prerequisites: ['velo running (the window can be hidden).'],
    shot: 'recipe-capture',
    steps: [
      { keys: 'capture', result: 'velo comes up with the search box in capture mode: it reads <code>→ Inbox</code>.' },
      { text: 'Call Dana about the beta', after: ENTER, result: 'The line <code>- [ ] Call Dana about the beta</code> is added to the Inbox note and capture mode ends (Esc cancels instead). If the shortcut brought velo up, Enter or Esc hides it again, so you are back in the app you were using.' },
      { keys: 'daily_note', result: 'Today’s daily note opens, titled with the date (for example <code>2026-10-30</code>); it is created if missing.' },
      { text: '- [ ] Review the roadmap', result: 'Autosave keeps it; like every <code>- [ ]</code> line it shows up in Tasks.' },
    ],
    why: 'Quick capture writes a task line into a plain note: the Inbox, or today’s daily note if you pick that under Settings → Quick capture goes to. The daily note is an ordinary note titled with the date, so search, links and Tasks treat it like any other.',
  },
  {
    kind: 'keys',
    slug: 'search',
    title: 'Find anything: search, tags, filter chips, saved searches',
    summary: 'Type to filter, narrow with tag chips, and keep the combination as a saved search.',
    goal: 'Get from “I wrote something about Atlas meetings” to the list of those notes, and keep that view for next time.',
    prerequisites: ['A few notes with <code>#tags</code> in them.'],
    shot: 'recipe-search',
    steps: [
      { keys: 'focus_search', result: 'The search box has focus.' },
      { text: 'atlas', result: 'The list filters on every keystroke, with matches highlighted. Enter opens the highlighted note, or creates a note titled “atlas” if nothing matches.' },
      { keys: 'toggle_tags', result: 'The Filters panel opens with every tag and its note count.' },
      { act: 'Click the <code>#meeting</code> chip', result: 'Only notes tagged <code>#meeting</code> that also match “atlas” stay. A <code>#meeting</code> chip shows inside the search box; the Filters button counts it.' },
      { act: 'Click Save search… in the Filters panel', text: 'Atlas meetings', after: ENTER, result: '“Atlas meetings” appears in the Saved row, above the tags, already applied (its chip is pressed). The search box now shows it as one chip in place of <code>#meeting</code>.' },
      { keys: ['⌘←', 'Home'], result: 'The caret moves to the start of the search box.' },
      { keys: ['⌫', 'Backspace'], result: 'Backspace at the start removes the last chip. Here that is the saved search, which clears as one: its search text and tag go too. (The × at the right of the box clears every chip the same way.)' },
      { act: 'Click the “Atlas meetings” chip in the Filters panel', result: 'Its search text and tags come back, replacing the current filters. Click it again to clear them.' },
    ],
    why: 'Tag chips keep notes having all selected tags, combined with the search text. Saved searches are stored per machine in the settings, and the list, Tasks, the timeline and export all follow the active filters. Right-click a saved chip (or Shift+F10) to rename or delete it.',
  },
  {
    kind: 'keys',
    slug: 'tasks',
    title: 'Tasks across notes',
    summary: 'Every <code>- [ ]</code> line from every note in one list, grouped by due date.',
    goal: 'See what is open everywhere, tick things off, and check what you finished this week.',
    prerequisites: ['Notes with task lines: <code>- [ ] text</code>, optionally ending in <code>📅 YYYY-MM-DD</code>.'],
    shot: 'recipe-tasks',
    steps: [
      { keys: 'toggle_tasks', result: 'The left pane switches to Tasks: open tasks grouped Overdue, Today, Upcoming and No date, each with its note.' },
      { keys: 'focus_search', text: 'atlas', result: 'Tasks follow the search box: only tasks whose text or note matches stay.' },
      { keys: ENTER, result: 'In the search box, Enter opens the first task shown: its note opens with the cursor on that line.' },
      { keys: ['Space', 'Space'], act: 'on a focused task row (Tab to the list: it is one Tab stop, ↑/↓ move), or click its checkbox',  result: 'The task is ticked, with its <code>@done</code> date, and “Ticked · Undo” shows under the list. Enter on a focused row opens its note.' },
      { act: 'Click Show done in the Tasks bar', result: 'A Done group lists the tasks ticked in the last 7 days.' },
      { keys: 'toggle_tasks', result: 'Back to Notes.' },
    ],
    why: 'Tasks are plain markdown lines, so they live in whatever note they belong to and stay readable outside velo. Ticking edits the file (<code>- [x]</code> plus a done date), so the Tasks view, export and agents all agree on what is done.',
  },
  {
    kind: 'keys',
    slug: 'timeline',
    title: 'Timeline and export of a week',
    summary: 'List the week by day, then export exactly that as Markdown or PDF.',
    goal: 'Review what you wrote in the last 7 days and hand it to someone as one file.',
    prerequisites: ['Notes created or edited in the last week.'],
    shot: 'recipe-timeline',
    steps: [
      { keys: 'toggle_timeline', result: 'The left pane lists notes newest first, grouped by day: Today, Yesterday, the weekday, then the date.' },
      { act: 'Open the menu in the Timeline bar (it reads “Updated · All”), choose 7 days', result: 'Only notes updated in the last 7 days. Created or Updated is remembered; the range is not.' },
      { keys: 'toggle_tags', act: 'Click a tag chip (optional)', result: 'The timeline follows the filters, like the list.' },
      { act: 'Click the Export button in the Timeline bar', result: 'The Export dialog states its scope, e.g. “From the Timeline · Updated in the last 7 days”, plus any filters.' },
      { act: 'Pick Markdown or PDF, Full notes or Tasks only, then Export…', result: 'Markdown asks where to save; PDF opens the system print dialog (choose Save as PDF).' },
    ],
    why: 'Export takes exactly what the timeline shows. The file starts with a task summary (open tasks, and tasks done in the range with their <code>@done</code> date), then one section per note. Locked notes are never exported and are counted as left out; an export holds at most 1,000 notes.',
  },
  {
    kind: 'keys',
    slug: 'lock',
    title: 'Lock a private note (and Lock all)',
    summary: 'Encrypt one note with age; lock everything again when you step away.',
    goal: 'Keep a private note encrypted on disk, and make velo ask for your passphrase before showing it again.',
    prerequisites: ['The note open in the editor.'],
    shot: 'recipe-lock',
    steps: [
      { keys: 'toggle_lock', result: 'The first time, velo asks you to create a passphrase (twice; it can’t be recovered). Press Create & lock. The note is now <code>Title.md.age</code>.' },
      { keys: 'lock_all', result: 'velo forgets the decrypted notes and the key.' },
      { keys: 'focus_search', text: 'private', result: 'Locked notes are still found by title.' },
      { keys: ENTER, result: '“This note is locked” asks for your passphrase in place of the note. Unlock shows it; Esc goes back to the list.' },
      { keys: 'toggle_lock', result: 'On an open locked note, the same shortcut unlocks it back to a plain <code>.md</code> file.' },
    ],
    why: 'Each locked note is age-encrypted to your identity, which lives in the OS keychain and, wrapped with your passphrase, in <code>.velo/identity.age</code>. Locked notes are never written to disk or the index as plaintext, never shown to agents, and never exported. After Lock all, quitting and relaunching unlocks from the keychain as usual.',
  },
  {
    kind: 'keys',
    slug: 'related',
    title: 'Navigate with Related',
    summary: 'Walk from note to note through links, backlinks, mentions and shared tags, and turn mentions into links.',
    goal: 'Explore what is connected to the note you are in without losing your place, and link the notes you mention.',
    prerequisites: ['A note open that links to, or mentions, other notes.'],
    shot: 'recipe-related',
    steps: [
      { keys: 'toggle_connections', result: 'The side panel opens on Related: Linked from, Links to, Mentions and Shared tags.' },
      { keys: ['↓', '↓'], result: 'Moves through the tree, section headers included; ← and → collapse and expand.' },
      { keys: ['⇧↩', 'Shift+Enter'], result: 'On a mention, Link it wraps the words in the open note in <code>[[ ]]</code> (⌘Z undoes it). On a missing link target it creates the note.' },
      { keys: ENTER, result: 'Opens the highlighted note and keeps you in the panel, so you can walk on. Space peeks at it instead.' },
      { keys: 'back', result: 'Back along the trail (the trail row at the top does the same).' },
      { keys: ESC, result: 'Back to the editor. ⌘↩ on a row opens the note and jumps to the editor in one step.' },
    ],
    why: 'Links are plain <code>[[wikilinks]]</code> in the files, and renaming a note rewrites links to it. Related reads them both ways, plus unlinked mentions of titles and aliases. The No links chip in the Filters panel lists notes with no links at all. Locked notes show their title only.',
  },
  {
    kind: 'keys',
    slug: 'palette',
    title: 'Command palette for everything',
    summary: 'Every action by name, with its shortcut, including the ones that have none.',
    goal: 'Run any action without remembering its shortcut, and learn the shortcut while you are at it.',
    prerequisites: ['None.'],
    shot: 'recipe-palette',
    steps: [
      { keys: 'command_palette', result: 'The palette opens: Recent, then the open note’s actions, then All commands, each with its shortcut.' },
      { text: 'lock', result: '“Lock all notes” and “Lock / unlock note” match; names that start with what you typed come first.' },
      { keys: ['↓', '↓'], result: 'Moves the highlight. A note action without an open note is listed as disabled with the reason (“open a note first”).' },
      { keys: ENTER, result: 'Runs the action as its shortcut would, and it moves to Recent.' },
      { keys: 'command_palette', text: 'export', result: '“Export…” is the only match. It has no default shortcut, so the palette is the keyboard way to run it; Save search… and Merge into… work the same way.' },
      { keys: ESC, result: 'Closes the palette. While you type, its footer points the other way: “Looking for a note? Esc, then ⌘L”.' },
    ],
    why: 'The palette lists actions by the same names as Settings → Keyboard shortcuts and shows your current bindings, so a remapped or cleared shortcut shows up here at once.',
  },
  {
    kind: 'agent',
    slug: 'agent-week',
    title: 'Summarise this week’s notes',
    summary: 'Claude lists your notes by date, reads the ones from this week and writes a summary.',
    goal: 'Get a short digest of the week without opening every note.',
    prerequisites: AGENT_PREREQ,
    shot: 'recipe-agent-week',
    transcript: 'summarise-week',
    prompt: 'Summarise this week’s notes.',
    answer:
      'This week (Mon 26 – Fri 30 Oct) you worked on five notes:\n\n' +
      '- **Project Atlas kickoff** (Mon): sync engine first, sharing later; beta by mid-December. Open: send the kickoff recap, book the design review.\n' +
      '- **Reading - Shape Up** (Tue): fix the time and vary the scope; breadboard before wireframes.\n' +
      '- **Atlas roadmap** (Wed): sync prototype in November, private beta in December, sharing in January. Main risk: conflict handling on flaky networks.\n' +
      '- **Hiring loop notes** (Thu): two strong onsites; you still need a frontend interviewer. Open: feedback for candidate B.\n' +
      '- **2026-10-29** (daily note): reviewed the roadmap with Dana, ran the onsites.\n\n' +
      'Grocery list was last changed on 14 Oct, so I left it out.',
    why: '<code>search_notes</code> with an empty query lists notes newest first, 50 per page (page on with <code>offset</code>), each with its modified date, tags and a snippet, so one call finds the week; <code>read_note</code> fills in the notes the snippets cut short. Read-only tools need no summary and change nothing. Locked notes are never listed.',
  },
  {
    kind: 'agent',
    slug: 'agent-meeting',
    title: 'File meeting notes with tags and tasks',
    summary: 'Claude creates the note, tags it and adds follow-up tasks, each as its own revision.',
    goal: 'Turn a few lines about a meeting into a filed, tagged note with tasks that show up in Tasks.',
    prerequisites: AGENT_PREREQ,
    shot: 'recipe-agent-meeting',
    transcript: 'file-meeting-notes',
    prompt:
      'File my notes from the Atlas design review: we chose an operation log over snapshots for the sync engine, and sharing waits until after the beta. Link it to the kickoff, tag it atlas and meeting, and add follow-ups: write the operation log RFC by 6 November, and share the notes with Lee.',
    answer:
      'Filed **Atlas design review**, linked to [[Project Atlas kickoff]] and tagged #atlas and #meeting (in its front matter). It has two tasks:\n\n' +
      '- Write the operation log RFC, due 2026-11-06\n' +
      '- Share the review notes with Lee\n\n' +
      'Each change is a separate revision, marked as an agent change, in the note’s revision list (side panel, Info tab), so you can restore any step.',
    why: 'Every write tool takes a one-line <code>summary</code>; velo saves a revision with it, marked as an agent change, before writing. <code>add_tags</code> puts tags in the front-matter <code>tags:</code> list (or a <code>#tag</code> line when front matter is off) and reports each note as changed, unchanged or failed. <code>add_task</code> with <code>due</code> appends <code>📅 YYYY-MM-DD</code>, so the task lands in the right Tasks group.',
  },
  {
    kind: 'agent',
    slug: 'agent-standup',
    title: 'Daily note standup',
    summary: 'Claude opens today’s daily note, checks yesterday and your open tasks, and appends a standup.',
    goal: 'Start the day with a standup written into the daily note, from what is actually in your notes.',
    prerequisites: AGENT_PREREQ,
    shot: 'recipe-agent-standup',
    transcript: 'daily-standup',
    prompt: 'Write my standup in today’s daily note (today is 2026-10-30).',
    answer:
      'Added a Standup section to **2026-10-30**:\n\n' +
      '- Yesterday: reviewed the Atlas roadmap, ran two hiring onsites\n' +
      '- Today: send the kickoff recap, write feedback for candidate B\n' +
      '- Blocked: need a frontend interviewer\n\n' +
      'You have five open tasks without a due date; I left the grocery list out of the standup.',
    why: '<code>daily_note</code> opens the note for a date and creates it if missing (with no date it uses today). <code>list_tasks</code> returns the same groups as the Tasks view. <code>append_to_note</code> only adds at the end, so it cannot clobber what you wrote; if the note is open in velo, the change goes through the editor.',
  },
];
