// Focus after the command palette closes (#111): it returns to where it was when the palette opened, so Escape in the
// Filters panel (its handler only hears keys from inside it) still closes the panel.
import { expect, test, type Page } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const focusAt = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "body";
    if (a.closest(".cm-editor")) return "editor";
    return a.getAttribute("aria-label") ?? a.textContent?.trim() ?? a.tagName.toLowerCase();
  });

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
    await page.keyboard.press(`${mod}+KeyP`);
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    if (how === "Escape") await page.keyboard.press("Escape");
    else await page.mouse.click(2, 2);
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
    await expect(noLinks).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
}

test("diag: where focus lands after the palette, from each origin", async ({ page }) => {
  const out: Record<string, string> = {};
  const roundTrip = async (name: string, prep: () => Promise<void>) => {
    await prep();
    await page.keyboard.press(`${mod}+KeyP`);
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
    await page.waitForTimeout(300);
    out[name] = await focusAt(page);
  };
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  await roundTrip("editor", () => page.locator(".cm-content").click());
  await roundTrip("search", () => page.getByRole("combobox", { name: /search/i }).first().focus());
  await roundTrip("list row", () => page.getByRole("option").nth(1).focus());
  console.log("DIAG " + JSON.stringify(out));
});
