// Focus after the command palette closes (#111): it returns to where it was when the palette opened, so Escape in the
// Filters panel (its handler only hears keys from inside it) still closes the panel.
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
