// Screenshots (docs/media/<name>.png) and clips (docs/media/<name>.poster.png, plus test-results/capture/clips/<name>.webm
// + .json, encoded to docs/media/<name>.mp4 by scripts/encode-media.mjs) of the browser demo for the docs site.
// Every Shot/Clip name the site uses is made here.
import { test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NOW = "2026-10-30T16:00:00Z";
const MEDIA = fileURLToPath(new URL("../docs/media/", import.meta.url));
const CLIPS = fileURLToPath(new URL("../test-results/capture/clips/", import.meta.url));
const FEATURE = { width: 1280, height: 800 };
const RECIPE = { width: 1000, height: 700 };

// no transitions, animations or blinking caret: the same pixels on every run
const STILL = `*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
  .cm-cursorLayer, .cm-dropCursor { display: none !important; }`; // CodeMirror draws its own caret

// Clips only: a pill at the bottom centre naming each shortcut pressed (⌘P, ↓, ↩); plain typing shows in the app itself.
const KEY_OVERLAY = () => {
  const SYM: Record<string, string> = { Enter: "↩", Escape: "Esc", ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Backspace: "⌫", Tab: "⇥", " ": "Space" };
  addEventListener("DOMContentLoaded", () => {
    const pill = document.createElement("div");
    pill.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
      "padding:6px 16px;border-radius:999px;background:rgba(20,20,22,.82);color:#fff;font:600 22px/1.3 system-ui,sans-serif;" +
      "letter-spacing:.04em;opacity:0;transition:opacity .35s";
    document.body.appendChild(pill);
    let timer = 0;
    addEventListener("keydown", (e) => {
      if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      const mods = (e.ctrlKey ? "⌃" : "") + (e.altKey ? "⌥" : "") + (e.shiftKey ? "⇧" : "") + (e.metaKey ? "⌘" : "");
      const named = SYM[e.key] ?? (e.key.length > 1 ? e.key : null);
      const typing = e.target instanceof HTMLInputElement || (e.target as HTMLElement).isContentEditable;
      if (!mods && (!named || (typing && e.key === " "))) return; // a typed character
      const key = e.code.startsWith("Key") ? e.code.slice(3) : (named ?? e.key.toUpperCase());
      pill.textContent = mods + key;
      pill.style.opacity = "1";
      clearTimeout(timer);
      timer = window.setTimeout(() => (pill.style.opacity = "0"), 900);
    }, true);
  });
};

type Opts = { viewport?: { width: number; height: number }; theme?: "light" | "dark"; video?: boolean };

async function open(browser: Browser, { viewport = FEATURE, theme = "light", video = false }: Opts = {}) {
  const o: BrowserContextOptions = video
    ? { viewport, deviceScaleFactor: 1, recordVideo: { dir: CLIPS, size: viewport } }
    : { viewport, deviceScaleFactor: 2 };
  const ctx = await browser.newContext({ ...o, colorScheme: theme });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.clock.setFixedTime(new Date(NOW)); // before navigation: the UI reads the browser clock
  if (video) await page.addInitScript(KEY_OVERLAY);
  await page.goto(`/?now=${NOW}&pill=0&theme=${theme}`);
  await page.evaluate(() => window.__veloDemo.ready);
  await page.addStyleTag({ content: STILL });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const keys = async (page: Page, ...ks: string[]) => {
  for (const k of ks) {
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
  }
};
const search = async (page: Page, text: string) => (await keys(page, "Meta+KeyL"), await page.keyboard.type(text));
const openNote = (page: Page, title: string) => page.getByRole("option", { name: new RegExp(`^${title}`) }).first().click();
// today's daily note, the search box cleared again (it opens with the note's title), the caret in the note
const dailyNote = async (page: Page) => {
  await keys(page, "Meta+Shift+KeyD", "Meta+KeyL", "Meta+KeyA", "Backspace");
  await page.locator(".cm-content").click();
};
// a chip in the Filters panel (the search box shows selected tags as chips too)
const chip = (page: Page, name: string) => page.getByRole("region", { name: "Filters" }).getByRole("button", { name: new RegExp(`^${name}( \\d+)?$`) }).click();

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0); // no hover highlight
  await page.waitForTimeout(400); // debounced search / panel loads settle
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${MEDIA}${name}.png`, animations: "disabled", caret: "hide" });
  await page.context().close();
}

test.describe.configure({ mode: "serial" });

test("screenshots", async ({ browser }) => {
  mkdirSync(MEDIA, { recursive: true });
  const step = (name: string, opts: Opts, act: (page: Page) => Promise<unknown>) =>
    test.step(name, async () => {
      const page = await open(browser, opts);
      await act(page);
      await shot(page, name);
    });

  // landing
  await step("hero", {}, async (p) => (await openNote(p, "Project Lantern"), await keys(p, "Meta+Shift+KeyC")));
  await step("search", {}, (p) => search(p, "lantern"));
  await step("tags", {}, async (p) => (await keys(p, "Meta+Shift+KeyT"), await chip(p, "#recipes")));
  await step("saved-searches", {}, async (p) => (await keys(p, "Meta+Shift+KeyT"), await chip(p, "Travel plans")));
  await step("timeline", {}, (p) => keys(p, "Meta+Shift+KeyL"));
  await step("export", {}, async (p) => (await keys(p, "Meta+Shift+KeyL"), await p.getByRole("button", { name: "Export…" }).click()));
  await step("related", {}, async (p) => (await openNote(p, "Learning Rust"), await keys(p, "Meta+Shift+KeyC")));
  // agents: an agent's change is a revision marked "agent" in the note's Info tab
  await step("agents", {}, async (p) => {
    await openNote(p, "Meeting — Sprint planning");
    await keys(p, "Meta+KeyI");
    await p.getByRole("tab", { name: "Info" }).click();
  });
  await step("encryption", {}, (p) => openNote(p, "Private journal"));

  // recipes
  await step("recipe-capture", { viewport: RECIPE }, async (p) => {
    await dailyNote(p);
    await p.keyboard.insertText("- [ ] Review the roadmap\n\n");
  });
  await step("recipe-search", { viewport: RECIPE }, async (p) => {
    await search(p, "lantern");
    await keys(p, "Meta+Shift+KeyT");
    await chip(p, "#ideas");
  });
  await step("recipe-tasks", { viewport: RECIPE }, (p) => keys(p, "Meta+Shift+KeyX"));
  await step("recipe-timeline", { viewport: RECIPE }, async (p) => {
    await keys(p, "Meta+Shift+KeyL");
    await p.getByRole("button", { name: /^Timeline:/ }).click();
    await p.getByRole("menuitemradio", { name: "7 days" }).click();
    await p.getByRole("button", { name: "Export…" }).click();
  });
  await step("recipe-lock", { viewport: RECIPE }, async (p) => (await search(p, "private"), await keys(p, "Enter")));
  await step("recipe-related", { viewport: RECIPE }, async (p) => {
    await openNote(p, "Learning Rust");
    await keys(p, "Meta+Shift+KeyC", "ArrowDown");
  });
  await step("recipe-palette", { viewport: RECIPE }, async (p) => {
    await openNote(p, "Learning Rust");
    await keys(p, "Meta+KeyP");
    await p.keyboard.type("lock");
  });
  // agent recipes: the view in velo that shows what the agent read or wrote
  await step("recipe-agent-week", { viewport: RECIPE }, async (p) => {
    await keys(p, "Meta+Shift+KeyL");
    await p.getByRole("button", { name: /^Timeline:/ }).click();
    await p.getByRole("menuitemradio", { name: "7 days" }).click();
  });
  await step("recipe-agent-meeting", { viewport: RECIPE }, async (p) => {
    await openNote(p, "Meeting — Payments retro");
    await keys(p, "Meta+KeyI");
    await p.getByRole("tab", { name: "Info" }).click();
  });
  await step("recipe-agent-standup", { viewport: RECIPE }, async (p) => {
    await dailyNote(p);
    // the section the recipe's agent appends (insertText: no list auto-continue; the caret ends on a blank line so the lines above render)
    await p.keyboard.insertText("## Standup\n\n- Yesterday: payments retro, sync design for [[Project Lantern]]\n- Today: review Lena's PR, send Priya the migration risks\n- Blocked: nothing\n\n");
    await keys(p, "Meta+Shift+KeyX");
  });
});

// ---- clips ----

const human = (page: Page, text: string) => page.keyboard.type(text, { delay: 110 });
const beat = (page: Page, ms = 700) => page.waitForTimeout(ms);
const press = async (page: Page, ...ks: string[]) => {
  for (const k of ks) {
    await page.keyboard.press(k);
    await beat(page, 650);
  }
};

async function clip(browser: Browser, name: string, act: (page: Page) => Promise<unknown>) {
  mkdirSync(CLIPS, { recursive: true });
  const t0 = Date.now();
  const page = await open(browser, { video: true });
  const start = (Date.now() - t0) / 1000; // the encoder cuts the blank page load before this
  await beat(page, 600);
  await act(page);
  await beat(page, 1200);
  // the poster is a screenshot of where the clip ends (the key pill has faded), not a video frame: the same pixels on
  // every run, and it shows what the clip is about when reduced motion keeps it from playing
  await page.screenshot({ path: `${MEDIA}${name}.poster.png`, animations: "disabled", caret: "hide" });
  const video = page.video()!;
  await page.context().close();
  await video.saveAs(`${CLIPS}${name}.webm`);
  await video.delete();
  writeFileSync(`${CLIPS}${name}.json`, JSON.stringify({ start }));
}

test("clips", async ({ browser }) => {
  rmSync(CLIPS, { recursive: true, force: true }); // encode-media.mjs encodes every webm left here
  await test.step("clip-search", () => clip(browser, "clip-search", async (p) => {
    await press(p, "Meta+KeyL");
    await human(p, "lantern");
    await beat(p);
    await press(p, "ArrowDown", "Enter", "Meta+Shift+KeyT");
    await chip(p, "#ideas");
    await beat(p, 1000);
    await chip(p, "#side-project");
  }));
  await test.step("clip-palette", () => clip(browser, "clip-palette", async (p) => {
    await press(p, "Meta+KeyP");
    await human(p, "timeline");
    await press(p, "Enter", "Meta+KeyP");
    await human(p, "export");
    await press(p, "Enter");
    await beat(p, 1000);
    await press(p, "Escape");
  }));
  await test.step("clip-related", () => clip(browser, "clip-related", async (p) => {
    await press(p, "Meta+KeyL");
    await human(p, "learning rust");
    await press(p, "Enter", "Meta+Shift+KeyC", "ArrowDown", "Shift+Enter");
    await beat(p, 1000);
    await press(p, "ArrowDown", "Enter");
    await beat(p, 1000);
    await press(p, "Meta+KeyJ", "Escape");
  }));
  await test.step("clip-tasks", () => clip(browser, "clip-tasks", async (p) => {
    await press(p, "Meta+Shift+KeyX");
    // tick with the checkbox: a click on the row opens its note and moves focus to the editor
    await p.getByRole("listitem").filter({ hasText: "Review Lena" }).locator('[data-part="control"]').click();
    await beat(p, 1000);
    await p.getByRole("button", { name: "Show done" }).click();
    await p.getByRole("group", { name: "Done" }).scrollIntoViewIfNeeded(); // the Done group is at the end of the list
    await beat(p, 1200);
    await press(p, "Meta+Shift+KeyL");
  }));
});
