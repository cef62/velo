// Focus after the command palette closes (#111): it returns to where it was when the palette opened, so Escape in the
// Filters panel (its handler only hears keys from inside it) still closes the panel.
import { expect, test, type Page } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

const openPalette = async (page: Page) => {
  await page.keyboard.press(`${mod}+KeyP`);
  await expect(palette(page)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("pointer-events", "none"); // the dialog's dismiss layer is live: a click earlier is ignored
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
