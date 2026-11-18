// Settings in a window shorter than the dialog: header and footer keep their size, only the tab panel scrolls, so Cancel
// and Save stay on screen on every tab.
import { expect, test } from "@playwright/test";

for (const [w, h] of [[1280, 800], [1100, 800], [800, 400], [800, 300], [600, 400], [500, 350]]) {
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
      const m = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])")!;
        const kids = [...panel.children] as HTMLElement[];
        const squeezed = kids.filter((k) => k.scrollHeight > k.clientHeight + 1).length; // a row whose content spills past its box
        panel.scrollTop = panel.scrollHeight;
        const last = kids[kids.length - 1].getBoundingClientRect();
        return { squeezed, lastInView: last.bottom <= panel.getBoundingClientRect().bottom + 1 };
      });
      expect(m.squeezed, "rows squeezed").toBe(0);
      expect(m.lastInView, "last row reachable by scrolling").toBe(true);
    });
  }
}
