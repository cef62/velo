// Dialogs that move focus into their own input must hand it back when they close (#111): to where it was when they opened,
// also when a dialog is opened from the command palette (which is closing at that moment). And the palette's own shortcut
// closes the palette, but never works inside any other dialog.
import { expect, test, type Locator, type Page } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const anyDialog = (page: Page) => page.locator("[role=dialog][data-state=open], [role=alertdialog][data-state=open]");

// Two animation frames: a key within ~10 ms of a dialog's input getting focus finds the focus trap still activating.
const settle = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const origins = {
  editor: { put: (p: Page) => p.locator(".cm-content").click().then(() => p.keyboard.press(`${mod}+KeyA`)), el: (p: Page) => p.locator(".cm-content") },
  "search field": { put: (p: Page) => p.getByLabel(/^Search or create/).focus(), el: (p: Page) => p.getByLabel(/^Search or create/) },
  "list row": { put: (p: Page) => p.getByRole("option").first().focus(), el: (p: Page) => p.getByRole("option").first() },
} satisfies Record<string, { put: (p: Page) => Promise<unknown>; el: (p: Page) => Locator }>;
type Origin = keyof typeof origins;

const viaPalette = (command: string) => async (page: Page) => {
  await page.keyboard.press(`${mod}+KeyP`);
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  await settle(page);
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
};
// WebKit does not focus a button on click, so the origin would be <body>: focus it and press Enter, as a keyboard user does.
const press = async (button: Locator) => {
  await button.focus();
  await button.press("Enter");
};
const noteMenu = (item: RegExp) => async (page: Page) => {
  await page.getByRole("button", { name: "Note menu" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => { throw e; });
  await page.goto("/?pill=0");
  await page.evaluate(() => window.__veloDemo.ready);
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  await expect(page.locator(".cm-content")).toContainText("velo");
});

// A query in the search field makes "Save search…" available; it leaves rows to focus.
type Case = { dialog: string; how: string; origins: Origin[]; query?: string; open: (p: Page) => Promise<void>; back?: (p: Page) => Locator };
const all: Origin[] = ["editor", "search field", "list row"];
const cases: Case[] = [
  { dialog: "Move to new note", how: "shortcut", origins: ["editor"], open: (p) => p.keyboard.press(`${mod}+Shift+KeyN`) },
  { dialog: "Move to new note", how: "palette", origins: ["editor"], open: viaPalette("Move to new note") },
  { dialog: "Move to new note", how: "note menu", origins: ["editor"], open: noteMenu(/Move selection/), back: (p) => p.getByRole("button", { name: "Note menu" }) },
  { dialog: "Merge", how: "palette", origins: all, open: viaPalette("Merge into") },
  { dialog: "Merge", how: "note menu", origins: ["editor"], open: noteMenu(/Merge into/), back: (p) => p.getByRole("button", { name: "Note menu" }) },
  { dialog: "Lock note", how: "shortcut", origins: all, open: (p) => p.keyboard.press(`${mod}+Shift+KeyE`) },
  { dialog: "Lock note", how: "palette", origins: all, open: viaPalette("Lock / unlock") },
  { dialog: "Lock note", how: "button", origins: ["editor"], open: (p) => press(p.getByRole("button", { name: "Encrypt note" })), back: (p) => p.getByRole("button", { name: "Encrypt note" }) },
  { dialog: "Save search", how: "palette", origins: all, query: "velo", open: viaPalette("Save search") },
  {
    dialog: "Save search", how: "Filters panel button", origins: ["editor"], query: "velo",
    open: async (p) => { await p.getByRole("button", { name: /^Filters/ }).click(); await press(p.getByRole("button", { name: /^Save search/ })); },
    back: (p) => p.getByRole("button", { name: /^Save search/ }),
  },
  { dialog: "Export", how: "palette", origins: ["editor", "search field"], open: viaPalette("Export") }, // the list row is gone: Export switches to the Timeline
  { dialog: "Settings", how: "shortcut", origins: all, open: (p) => p.keyboard.press(`${mod}+Comma`) },
  { dialog: "Settings", how: "palette", origins: all, open: viaPalette("Settings") },
];

for (const c of cases) for (const o of c.origins) {
  test(`${c.dialog} opened by ${c.how} from the ${o}: closing it returns focus to ${c.back ? "the control it came from" : `the ${o}`}`, async ({ page }) => {
    if (c.query) await page.getByLabel(/^Search or create/).fill(c.query);
    await origins[o].put(page);
    await settle(page);
    await c.open(page);
    await expect(anyDialog(page)).toHaveCount(1);
    await expect(palette(page)).toBeHidden();
    await expect(page.locator("body")).toHaveCSS("pointer-events", "none"); // the dialog's dismiss layer is live
    await settle(page);
    await page.keyboard.press("Escape");
    await expect(anyDialog(page)).toHaveCount(0);
    await expect(c.back ? c.back(page) : origins[o].el(page)).toBeFocused();
  });
}

// Real mouse clicks, no pre-focusing (#111). WebKit does not focus a clicked button, so focus is on <body> when these dialogs open,
// and it stays there when they close; Chromium focuses the button and gets it back. The note menu is used first: its button used to
// become the origin of every later dialog opened from <body>.
const clicked: { dialog: string; query?: string; open: (p: Page) => Promise<void>; back: (p: Page) => Locator }[] = [
  { dialog: "Lock note", open: (p) => p.getByRole("button", { name: "Encrypt note" }).click(), back: (p) => p.getByRole("button", { name: "Encrypt note" }) },
  {
    dialog: "Save search", query: "velo",
    open: async (p) => { await p.getByRole("button", { name: /^Filters/ }).click(); await p.getByRole("button", { name: /^Save search/ }).click(); },
    back: (p) => p.getByRole("button", { name: /^Save search/ }),
  },
  { dialog: "Settings", open: (p) => p.getByRole("button", { name: "Settings" }).click(), back: (p) => p.getByRole("button", { name: "Settings" }) },
  {
    dialog: "Merge (from the palette opened by a click)",
    open: async (p) => {
      await p.getByRole("button", { name: "Command palette" }).click();
      await expect(p.getByRole("combobox", { name: "Command" })).toBeFocused();
      await settle(p);
      await p.keyboard.type("Merge into");
      await p.keyboard.press("Enter");
    },
    back: (p) => p.getByRole("button", { name: "Command palette" }),
  },
];
const useNoteMenu = async (page: Page) => {
  await noteMenu(/Merge into/)(page);
  await expect(anyDialog(page)).toHaveCount(1);
  await settle(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Note menu" })).toBeFocused();
};
for (const c of clicked) {
  test(`${c.dialog} opened by a mouse click after the note menu was used: closing it returns focus to the clicked button or <body>`, async ({ page, browserName }) => {
    await useNoteMenu(page);
    await page.getByRole("option").nth(2).click();
    if (c.query) {
      await page.getByLabel(/^Search or create/).click();
      await page.keyboard.type(c.query);
    }
    await c.open(page);
    await expect(anyDialog(page)).toHaveCount(1);
    await expect(palette(page)).toBeHidden();
    await settle(page);
    await page.keyboard.press("Escape");
    await expect(anyDialog(page)).toHaveCount(0);
    if (browserName === "webkit") await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    else await expect(c.back(page)).toBeFocused();
    // focus handed back after Escape opens no tooltip: shown unasked, it would take the next Escape
    await settle(page);
    await expect(page.locator("[data-scope=tooltip][data-part=content][data-state=open]")).toHaveCount(0);
  });
}
test("the window losing focus while the palette is open: the dialog it runs still returns focus to the editor", async ({ page }) => {
  await origins.editor.put(page);
  await page.keyboard.press(`${mod}+KeyP`);
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  await settle(page);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur"))); // switching apps and back
  await page.keyboard.type("Merge into");
  await page.keyboard.press("Enter");
  await expect(anyDialog(page)).toHaveCount(1);
  await expect(palette(page)).toBeHidden();
  await settle(page);
  await page.keyboard.press("Escape");
  await expect(anyDialog(page)).toHaveCount(0);
  await expect(origins.editor.el(page)).toBeFocused();
});
test("a dialog opened by its shortcut with focus on <body>: closing it leaves focus on <body>, not on an older origin", async ({ page }) => {
  await useNoteMenu(page);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press(`${mod}+Shift+KeyE`);
  await expect(anyDialog(page)).toHaveCount(1);
  await settle(page);
  await page.keyboard.press("Escape");
  await expect(anyDialog(page)).toHaveCount(0);
  await settle(page);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

for (const o of all) {
  test(`palette shortcut pressed twice from the ${o}: the second press closes it and focus returns`, async ({ page }) => {
    await origins[o].put(page);
    await page.keyboard.press(`${mod}+KeyP`);
    await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
    await settle(page);
    await page.keyboard.press(`${mod}+KeyP`);
    await expect(palette(page)).toBeHidden();
    await expect(origins[o].el(page)).toBeFocused();
    await page.keyboard.press(`${mod}+KeyP`); // and it opens again
    await expect(palette(page)).toBeVisible();
  });
}

test("inside the palette no other shortcut leaks through", async ({ page }) => {
  await page.keyboard.press(`${mod}+KeyP`);
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  await settle(page);
  await page.keyboard.press(`${mod}+Comma`); // Settings
  await page.keyboard.press(`${mod}+Shift+KeyL`); // Timeline
  await expect(palette(page)).toBeVisible();
  await expect(anyDialog(page)).toHaveCount(1);
});

// Each of these dialogs owns every key: the palette shortcut neither opens the palette over them nor closes them.
const others: { name: string; open: (p: Page) => Promise<void> }[] = [
  { name: "Settings", open: (p) => p.keyboard.press(`${mod}+Comma`) },
  { name: "Move to new note", open: async (p) => { await p.locator(".cm-content").click(); await p.keyboard.press(`${mod}+KeyA`); await p.keyboard.press(`${mod}+Shift+KeyN`); } },
  { name: "Merge", open: viaPalette("Merge into") },
  { name: "Lock note", open: (p) => p.keyboard.press(`${mod}+Shift+KeyE`) },
  { name: "Export", open: viaPalette("Export") },
];
for (const d of others) {
  test(`palette shortcut inside ${d.name}: does nothing`, async ({ page }) => {
    await d.open(page);
    await expect(anyDialog(page)).toHaveCount(1);
    await expect(palette(page)).toBeHidden();
    await settle(page);
    await page.keyboard.press(`${mod}+KeyP`);
    await settle(page);
    await expect(palette(page)).toBeHidden();
    await expect(anyDialog(page)).toHaveCount(1);
  });
}

test("palette shortcut inside the lock screen does nothing", async ({ page }) => {
  await page.getByRole("option", { name: /^Private journal/ }).first().click();
  await expect(page.locator("[data-lock-screen]")).toBeVisible();
  await expect(page.getByLabel("Passphrase")).toBeFocused();
  await page.keyboard.press(`${mod}+KeyP`);
  await settle(page);
  await expect(palette(page)).toBeHidden();
  await expect(page.locator("[data-lock-screen]")).toBeVisible();
});
