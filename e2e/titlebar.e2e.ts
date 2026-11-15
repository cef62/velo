// Title bar under a long save error with Retry, at the narrowest bars (#145): the note title never shows as a sliver
// (a readable minimum with an ellipsis, or gone whole), the error's icon stays fully inside the lead, and the lead keeps
// 4 px on its right so the focused error's 3 px outline stays whole in WebKit.
import { expect, test } from "@playwright/test";

test("a long save error with Retry: no title sliver, the error icon whole, 4 px for its outline", async ({ page }) => {
  page.on("pageerror", (e) => { throw e; });
  // the demo saves never fail: make them fail on demand
  await page.route("**/src/demo/api.ts*", async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/(const saveNote = async \([^)]*\) => \{)/, `$1 if (window.__failSave) throw "Save failed: ${"disk is full ".repeat(8)}";`);
    await route.fulfill({ response: res, body });
  });
  await page.goto("/?pill=0");
  await page.evaluate(() => window.__veloDemo.ready);
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => ((window as unknown as { __failSave: boolean }).__failSave = true));
  await page.keyboard.type("x");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.locator("[data-preview]").click(); // Preview: the narrowest lead

  for (const w of [300, 320, 340, 360, 380, 400]) {
    await page.evaluate((w) => { const e = document.querySelector<HTMLElement>("[data-titlebar]")!; e.style.width = `${w}px`; e.style.flex = "none"; }, w);
    await page.waitForTimeout(100); // the bar's ResizeObserver re-renders the mode
    const m = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>("[data-titlebar]")!;
      const lead = bar.firstElementChild!;
      const title = lead.querySelector("h2")!;
      const icon = bar.querySelector("[role=alert] svg")!.getBoundingClientRect();
      const l = lead.getBoundingClientRect();
      return {
        titleW: getComputedStyle(title).display === "none" ? 0 : title.getBoundingClientRect().width,
        floor: 2.5 * parseFloat(getComputedStyle(lead).fontSize),
        iconInside: icon.left >= l.left && icon.right <= l.right,
        pr: getComputedStyle(lead).paddingRight,
        overflow: bar.scrollWidth - bar.clientWidth,
      };
    });
    expect(m.titleW === 0 || m.titleW >= m.floor - 1, `title ${m.titleW}px at bar ${w}`).toBe(true);
    expect(m.iconInside, `icon inside the lead at bar ${w}`).toBe(true);
    expect(m.pr).toBe("4px");
    expect(m.overflow).toBe(0);
  }
});
