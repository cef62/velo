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
