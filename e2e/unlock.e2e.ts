// The inline unlock screen (#126, #131): everything behind it (title bar, banners, tag bar, editor, preview) sits in one
// `display: contents` wrapper made inert, so neither Tab nor a script can put focus there and typing cannot reach the
// note hidden behind it. The note list stays live on purpose: picking another note there dismisses the unlock.
import { expect, test, type Page } from "@playwright/test";

const row = (page: Page, title: string) => page.getByRole("option", { name: new RegExp(`^${title}`) }).first();

/** Where focus is: "editor" in CodeMirror, "behind" elsewhere inside the wrapper (found by structure, not by `[inert]`, so the checks still run without it), else a short label of the element. */
const focusAt = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "body";
    if (a.closest(".cm-editor")) return "editor";
    if (document.querySelector("[data-titlebar]")?.parentElement?.contains(a)) return "behind";
    return a.getAttribute("aria-label") ?? a.getAttribute("role") ?? a.tagName.toLowerCase();
  });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => { throw e; });
  await page.goto("/?pill=0");
  await page.evaluate(() => window.__veloDemo.ready);
  await row(page, "Welcome to velo").click();
  await expect(page.locator(".cm-content")).toContainText("velo");
  await row(page, "Private journal").click();
  await expect(page.locator("[data-lock-screen]")).toBeVisible();
  await expect(page.getByLabel("Passphrase")).toBeFocused();
});

test("behind the unlock screen the note area is inert: Tab, focus() and typing never reach it", async ({ page }) => {
  // the wrapper is the title bar's parent: it holds the tag bar, the editor and the preview too
  const wrapped = await page.evaluate(() => {
    const w = document.querySelector("[data-titlebar]")?.parentElement;
    return {
      parts: ['[aria-label="Note tags"]', ".cm-content", "[data-preview-host]"].filter((q) => w?.querySelector(q)),
      display: w && getComputedStyle(w).display,
      focusables: w?.querySelectorAll("button, input, textarea, [tabindex], [contenteditable=true]").length ?? 0,
    };
  });
  expect(wrapped.parts).toEqual(['[aria-label="Note tags"]', ".cm-content", "[data-preview-host]"]);
  expect(wrapped.display).toBe("contents");
  expect(wrapped.focusables).toBeGreaterThan(1); // the title bar's controls and the editor: there is something to keep out

  // Tab and Shift+Tab around the whole page: never inside the wrapper; the list is reachable
  const seen = new Set<string>();
  for (const k of ["Tab", "Shift+Tab"]) {
    await page.getByLabel("Passphrase").focus();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(k);
      seen.add(await focusAt(page));
    }
  }
  // soft: without `inert` each behaviour check below reports its own failure
  expect.soft(seen).not.toContain("behind");
  expect.soft(seen).not.toContain("editor");
  expect(seen).toContain("option"); // a note row: the list stays reachable

  // a script cannot focus inside it either (inert applies through `display: contents`), and typing goes nowhere
  const before = await page.locator(".cm-content").innerText();
  const focused = await page.evaluate(() => {
    const w = document.querySelector("[data-titlebar]")!.parentElement!;
    return [...w.querySelectorAll<HTMLElement>("button, input, textarea, [tabindex], [contenteditable=true]")].filter((el) => (el.focus(), document.activeElement === el)).length;
  });
  expect.soft(focused).toBe(0);
  await page.locator(".cm-content").evaluate((el: HTMLElement) => el.focus()); // stays put while inert; in the editor without it
  await page.keyboard.type("zzz");
  expect.soft(await page.locator(".cm-content").innerText()).toBe(before);
  // last, so that without `inert` the behaviour checks above are what fail
  expect(await page.locator("[data-titlebar]").evaluate((t) => t.parentElement!.hasAttribute("inert"))).toBe(true);
});

test("Escape lifts inert, puts focus back on the list, and the highlight stays on the locked row (#131)", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-lock-screen]")).toHaveCount(0);
  expect(await page.locator("[inert]").count()).toBe(0);
  await expect(row(page, "Private journal")).toBeFocused();
  await expect(row(page, "Private journal")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toContainText("velo"); // the note shown before is back, editable
  await page.locator(".cm-content").focus();
  expect(await focusAt(page)).toBe("editor");
});
