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

// The demo relays the tab's request to the main tab's real `whatsnew-install` listener (src/demo/updates.ts `relay`), so
// this checks what the listener decides, not only what the selectors match.
test("the What's new install goes through main's listener: refused under a modal, started under the popover", async ({ page, context }) => {
  page.on("pageerror", (e) => { throw e; });
  await page.goto("/?pill=0&update=big");
  await page.evaluate(() => window.__veloDemo.ready);
  const pill = page.getByRole("button", { name: /velo 0\.19\.0 is ready/ });
  await pill.click();
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "What's new" }).click();
  const tab = await opened;
  tab.on("pageerror", (e) => { throw e; });
  const install = tab.getByRole("button", { name: "Install and restart" });
  await expect(install).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Comma"); // Settings: a modal in main
  await expect(page.getByRole("dialog")).toBeVisible();
  await install.click();
  await expect(tab.getByText(/The update did not start: Close the open dialog in the velo window first/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await pill.click(); // the pill's popover again: open, but no modal
  expect(await state(page)).toEqual({ modal: false, overlay: true });
  await tab.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: /^Installing…/ })).toBeVisible(); // main saved, froze and installed
  await expect(tab.getByText(/Downloading velo 0\.19\.0/).first()).toBeVisible();

  // the demo's install then fails: main lets go of it, so Try again starts a new one
  await expect(tab.getByText("Update failed: This is a demo: nothing was installed.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Update failed/ })).toBeVisible();
  await tab.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: /^Installing…/ })).toBeVisible();
  await expect(tab.getByText(/Downloading velo 0\.19\.0/).first()).toBeVisible();
});
