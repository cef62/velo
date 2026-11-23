// Focus after the command palette closes (#111): it returns to where it was when the palette opened, and the next Escape still
// closes the Filters panel.
import { expect, test, type Page } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

// Two animation frames: an Escape within ~10 ms of the input getting focus finds the focus trap still activating and leaves
// focus on <body> (as on main), which is not what these tests probe.
const settle = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

// Waits for the palette to settle; the zero-delay test below is the one that covers the open itself.
const openPalette = async (page: Page) => {
  await page.keyboard.press(`${mod}+KeyP`);
  await expect(palette(page)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("pointer-events", "none"); // the dialog's dismiss layer is live: a click earlier is ignored
  await settle(page);
};

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => { throw e; });
  await page.goto("/?pill=0");
  await page.evaluate(() => window.__veloDemo.ready);
});

for (const how of ["Escape", "backdrop click"] as const) {
  test(`palette closed by ${how}: focus returns to the Filters button it came from, one Escape closes the panel`, async ({ page }) => {
    await page.getByRole("button", { name: /^Filters/ }).click();
    const panel = page.getByRole("region", { name: "Filters" });
    await expect(panel).toBeVisible();
    const noLinks = panel.getByRole("button", { name: "No links" });
    await noLinks.focus();
    await openPalette(page);
    if (how === "Escape") await page.keyboard.press("Escape");
    else {
      await page.mouse.move(40, 600);
      await page.mouse.click(40, 600, { delay: 50 });
    }
    await expect(palette(page)).toBeHidden();
    await expect(noLinks).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
}

// Real mouse clicks and keys, no pre-focusing (#111). Focus is on <body> (WebKit leaves a clicked button unfocused), on a header
// button (Chromium focuses it on click; a keyboard user), or wherever a dialog handed it back; never inside the panel. One Escape
// still closes the panel: a tooltip that focus coming back opens would take that Escape, so none opens.
const closings = {
  Escape: (p: Page) => p.keyboard.press("Escape"),
  "outside click": (p: Page) => p.mouse.click(40, 600),
  "palette shortcut": (p: Page) => p.keyboard.press(`${mod}+KeyP`),
};
const filtersButton = (p: Page) => p.getByRole("button", { name: /^Filters/ });
const filtersPanel = (p: Page) => p.getByRole("region", { name: "Filters" });
const tooltips = (p: Page) => p.locator("[data-scope=tooltip][data-part=content][data-state=open]");
const openFilters = {
  click: (p: Page) => filtersButton(p).click(),
  keyboard: (p: Page) => filtersButton(p).focus().then(() => p.keyboard.press("Enter")),
};
test("Filters opened by a click on its button: one Escape closes it", async ({ page }) => {
  await filtersButton(page).click();
  await expect(filtersPanel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(filtersPanel(page)).toBeHidden();
});
const hows = Object.keys(closings) as (keyof typeof closings)[];
const paletteCases: { filters: keyof typeof openFilters; opener: "shortcut" | "header button click"; how: keyof typeof closings }[] = [
  ...hows.map((how) => ({ filters: "click" as const, opener: "shortcut" as const, how })),
  ...hows.map((how) => ({ filters: "click" as const, opener: "header button click" as const, how })),
  ...hows.map((how) => ({ filters: "keyboard" as const, opener: "shortcut" as const, how })),
];
for (const c of paletteCases) {
  test(`Filters opened by ${c.filters}, palette opened by ${c.opener}, closed by ${c.how}: one Escape closes the panel, no tooltip shows`, async ({ page }) => {
    await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
    await openFilters[c.filters](page);
    await expect(filtersPanel(page)).toBeVisible();
    if (c.opener === "shortcut") await openPalette(page);
    else {
      await page.getByRole("button", { name: "Command palette" }).click();
      await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
      await settle(page);
    }
    await closings[c.how](page);
    await expect(palette(page)).toBeHidden();
    await settle(page);
    await expect(tooltips(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(filtersPanel(page)).toBeHidden();
  });
}
test("Filters open, Settings opened by a click and closed by Escape: the next Escape closes the panel", async ({ page }) => {
  await filtersButton(page).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await settle(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("[role=dialog][data-state=open]")).toHaveCount(0);
  await settle(page);
  await expect(tooltips(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(filtersPanel(page)).toBeHidden();
});
test("a tooltip asked for by Tab still shows, and Escape closes it before the Filters panel", async ({ page }) => {
  await openFilters.keyboard(page);
  await expect(filtersPanel(page)).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(filtersButton(page)).toBeFocused();
  await expect(tooltips(page)).toHaveCount(1);
  await page.keyboard.press("Escape"); // one Escape, one consumer: the tooltip
  await expect(tooltips(page)).toHaveCount(0);
  await expect(filtersPanel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(filtersPanel(page)).toBeHidden();
});
test("Escape with the Filters panel open: the editor and a search query keep their own Escape first", async ({ page }) => {
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  await page.getByRole("button", { name: /^Filters/ }).click();
  const panel = page.getByRole("region", { name: "Filters" });
  const search = page.getByLabel(/^Search or create/);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Escape"); // the editor's Escape: to the search field
  await expect(search).toBeFocused();
  await expect(panel).toBeVisible();
  await page.keyboard.type("velo");
  await page.keyboard.press("Escape"); // clears the query
  await expect(search).toHaveValue("");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(search).toBeFocused();
});

test("palette closed by Escape: focus returns to the editor, the search field and a list row", async ({ page }) => {
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  const origins = [page.locator(".cm-content"), page.getByLabel(/^Search or create/), page.getByRole("option").nth(1)];
  for (const el of origins) {
    await el.focus();
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(palette(page)).toBeHidden();
    await expect(el).toBeFocused();
  }
});

// The palette input has focus the moment it opens: keys typed right after the shortcut, with no wait, all land in it.
for (const origin of ["editor", "search field", "list row"] as const) {
  test(`typing right after the shortcut from the ${origin}: the palette input gets every key, nothing else changes`, async ({ page }) => {
    await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
    const search = page.getByLabel(/^Search or create/);
    const editor = page.locator(".cm-content");
    const typed = origin === "search field" ? "zz" : ""; // a filter would leave the list too short for a row
    if (origin === "editor") await editor.click();
    else if (origin === "search field") await search.fill(typed);
    else await page.getByRole("option").nth(1).focus();
    const note = await editor.innerText();
    // the key-up follows the key-down at once: where focus is then is where a fast typist's next key goes
    await page.evaluate(() => document.addEventListener("keyup", () => ((window as unknown as { __at: string }).__at = document.activeElement?.getAttribute("aria-label") ?? ""), { capture: true, once: true }));
    await page.keyboard.press(`${mod}+KeyP`);
    await page.keyboard.type("Focus search");
    expect(await page.evaluate(() => (window as unknown as { __at: string }).__at)).toBe("Command");
    await expect(page.getByRole("combobox", { name: "Command" })).toHaveValue("Focus search");
    await settle(page); // only the typing above is zero-delay
    await page.keyboard.press("Escape");
    await expect(palette(page)).toBeHidden();
    expect(await editor.innerText()).toBe(note);
    await expect(search).toHaveValue(typed);
  });
}

test("a palette command that moves focus keeps its own result", async ({ page }) => {
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  await page.locator(".cm-content").focus();
  await openPalette(page);
  await page.keyboard.type("Focus search");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page.getByLabel(/^Search or create/)).toBeFocused();

  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("region", { name: "Filters" }).getByRole("button", { name: "No links" }).focus();
  await openPalette(page);
  await page.keyboard.type("Rename note");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Note title")).toBeFocused();
});
