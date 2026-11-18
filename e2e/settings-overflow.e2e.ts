// Settings in a window shorter than the dialog: header and footer keep their size, only the tab panel scrolls, so Cancel
// and Save stay on screen on every tab.
import { expect, test } from "@playwright/test";

for (const [w, h] of [[800, 400], [800, 300], [500, 350]]) {
  for (const tab of ["General", "Appearance", "Keyboard shortcuts"]) {
    test(`Settings ${tab} at ${w}x${h}: Cancel and Save stay in the window`, async ({ page }) => {
      page.on("pageerror", (e) => { throw e; });
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/?pill=0");
      await page.evaluate(() => window.__veloDemo.ready);
      await page.keyboard.press("ControlOrMeta+Comma");
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: tab }).click();
      for (const name of ["Cancel", "Save"]) {
        const b = await dialog.getByRole("button", { name: name === "Save" ? /^Save (⌘|Ctrl)/ : name }).boundingBox();
        expect(b, name).not.toBeNull();
        expect(b!.y + b!.height, `${name} bottom`).toBeLessThanOrEqual(h);
        expect(b!.x + b!.width, `${name} right`).toBeLessThanOrEqual(w);
      }
      await expect(dialog.getByRole("button", { name: /^Save (⌘|Ctrl)/ })).toBeInViewport({ ratio: 1 });
    });
  }
}
