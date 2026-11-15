// Title bar under a long save error with Retry, at the narrow bars (#145): the note title never shows as a sliver
// (its floor of 2.5em with an ellipsis, or out of the layout whole but still in the accessibility tree), also beside the
// archived badge; the error's icon stays fully inside the lead, and the lead keeps 4 px on its right so the focused
// error's 3 px outline stays whole in WebKit.
import { expect, test } from "@playwright/test";

for (const archived of [false, true]) {
  test(`a long save error with Retry${archived ? " and the archived badge" : ""}: no title sliver, the error icon whole, 4 px for its outline`, async ({ page }) => {
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
    if (archived) {
      await page.getByLabel("Note menu").click();
      const item = page.getByRole("menuitem", { name: /^Archive note/ });
      await item.hover();
      await item.click();
      await expect(page.locator("[data-titlebar]").getByText("archived")).toBeAttached();
      await page.locator(".cm-content").click();
    }
    await page.evaluate(() => ((window as unknown as { __failSave: boolean }).__failSave = true));
    await page.keyboard.type("x");
    await expect(page.getByRole("alert")).toBeVisible();
    await page.locator("[data-preview]").click(); // Preview: the narrowest lead

    for (const w of [300, 320, 340, 350, 360, 370, 380, 390, 400]) {
      await page.evaluate((w) => { const e = document.querySelector<HTMLElement>("[data-titlebar]")!; e.style.width = `${w}px`; e.style.flex = "none"; }, w);
      // the bar's ResizeObserver re-renders the mode: poll until the invariants hold
      await expect(async () => {
        const m = await page.evaluate(() => {
          const bar = document.querySelector<HTMLElement>("[data-titlebar]")!;
          const lead = bar.firstElementChild!;
          const title = lead.querySelector("h2")!;
          const icon = bar.querySelector("[role=alert] svg")!.getBoundingClientRect();
          const l = lead.getBoundingClientRect();
          return {
            hidden: getComputedStyle(title).position === "absolute", // srOnly: out of the layout, still read
            titleW: title.getBoundingClientRect().width,
            floor: 2.5 * parseFloat(getComputedStyle(lead).fontSize),
            iconInside: icon.left >= l.left && icon.right <= l.right && icon.top >= l.top && icon.bottom <= l.bottom, // also vertically: a wrapped icon sits on the clipped second line
            pr: getComputedStyle(lead).paddingRight,
            overflow: bar.scrollWidth - bar.clientWidth,
            retry: [...bar.querySelectorAll("button")].some((b) => b.textContent === "Retry"),
          };
        });
        expect(m.hidden || m.titleW >= m.floor - 1, `title ${m.titleW}px at bar ${w}`).toBe(true);
        expect(m.iconInside, `icon inside the lead at bar ${w}`).toBe(true);
        expect(m.pr).toBe("4px");
        expect(m.overflow).toBe(0);
        expect(m.retry).toBe(true);
      }).toPass();
      // at 300 the title is out of the layout: it must stay in the accessibility tree
      if (w === 300) await expect(page.locator("[data-titlebar]").getByRole("heading", { name: "Welcome to velo" })).toHaveCount(1);
    }
  });
}
