// The update pill and the What's new window's install (#149): the main window refuses that install only while a modal
// is open. The pill's own popover is non-modal, and What's new closes it, so the normal path is never refused.
import { expect, test, type Page } from "@playwright/test";
import { MODAL, OVERLAY } from "../src/ui/modal";

const state = (page: Page) =>
  page.evaluate(([modal, overlay]) => ({ modal: !!document.querySelector(modal), overlay: !!document.querySelector(overlay) }), [MODAL, OVERLAY] as const);

test("What's new closes the pill popover; only a real dialog blocks the install", async ({ page, context }) => {
  page.on("pageerror", (e) => { throw e; });
  await page.goto("/?pill=0&update=big");
  await page.evaluate(() => window.__veloDemo.ready);
  await page.getByRole("button", { name: /velo 0\.19\.0 is ready/ }).click();
  const whatsNew = page.getByRole("button", { name: "What's new" });
  await expect(whatsNew).toBeVisible();
  // the open popover keeps shortcuts away (as before), but it is no modal: the install would go ahead
  expect(await state(page)).toEqual({ modal: false, overlay: true });

  const tab = context.waitForEvent("page");
  await whatsNew.click();
  await (await tab).close(); // the demo opens whatsnew.html in a tab
  await expect(whatsNew).toBeHidden();
  expect(await state(page)).toEqual({ modal: false, overlay: false });

  await page.keyboard.press("ControlOrMeta+Comma"); // Settings: a modal that can hold unsaved input
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await state(page)).toEqual({ modal: true, overlay: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await state(page)).toEqual({ modal: false, overlay: false }); // closed: Install again goes ahead
});
