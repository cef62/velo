// The note list's minimum width grows with the font size (#119): at the largest font, an archived Timeline row keeps
// its title at the width it has at font 14 and 216 px (about 7em); a font change widens a list that sits at the minimum.
import { expect, test, type Page } from "@playwright/test";

const setFont = async (page: Page, font: number) => {
  await page.keyboard.press("ControlOrMeta+Comma");
  const d = page.getByRole("dialog");
  await d.locator("#set-font").fill(String(font));
  await d.getByRole("button", { name: /^Save/ }).click();
  await d.waitFor({ state: "hidden" });
};
const listWidth = (page: Page) => page.evaluate(() => (document.querySelector("[data-divider]")!.previousElementSibling as HTMLElement).offsetWidth);
const dragToMin = async (page: Page) => {
  const b = (await page.getByRole("separator", { name: "Resize note list" }).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(5, b.y + 100, { steps: 5 });
  await page.mouse.up();
};
const open = async (page: Page, w = 1280, h = 720) => {
  page.on("pageerror", (e) => { throw e; });
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/?pill=0");
  await page.evaluate(() => window.__veloDemo.ready);
};
const archivedTimelineTitle = async (page: Page) => {
  await page.getByRole("tab", { name: /^Timeline/ }).click();
  return page.evaluate(() => {
    const t = document.querySelector("[data-archived][role=option] span")!.getBoundingClientRect().width;
    return { title: t, em: t / parseFloat(getComputedStyle(document.querySelector("[data-archived][role=option]")!).fontSize) };
  });
};
const archiveWelcome = async (page: Page) => {
  await page.getByRole("option", { name: /^Welcome to velo/ }).first().click();
  await page.getByLabel("Note menu").click();
  await page.getByRole("menuitem", { name: /^Archive note/ }).click();
  await page.getByLabel("Show archived notes").click();
};

test("at font 32 the divider's minimum keeps the archived Timeline title at about 7em", async ({ page }) => {
  await open(page);
  await archiveWelcome(page);
  await setFont(page, 32);
  await dragToMin(page);
  expect(await listWidth(page)).toBe(387);
  const { title, em } = await archivedTimelineTitle(page);
  expect(em, `title ${title}px`).toBeGreaterThanOrEqual(6.9); // 97.6 px / 14 px at font 14 and 216 px
});

test("raising the font while the list is at 216 widens it; lowering it brings 216 back", async ({ page }) => {
  await open(page);
  await dragToMin(page);
  expect(await listWidth(page)).toBe(216);
  await setFont(page, 32);
  expect(await listWidth(page)).toBe(387);
  await setFont(page, 14);
  expect(await listWidth(page)).toBe(216); // the stored 216 was never rewritten
});

test("in the smallest window (600x400) at font 32 the note keeps its 320 px column", async ({ page }) => {
  await open(page, 600, 400);
  await setFont(page, 32);
  await dragToMin(page);
  const m = await page.evaluate(() => {
    const l = document.querySelector("[data-divider]")!.previousElementSibling as HTMLElement;
    return { list: l.offsetWidth, note: (document.querySelector("[data-divider]")!.nextElementSibling as HTMLElement).offsetWidth, scroll: document.documentElement.scrollWidth };
  });
  expect(m.list).toBe(279);
  expect(m.note).toBeGreaterThanOrEqual(320);
  expect(m.scroll).toBeLessThanOrEqual(600);
});
