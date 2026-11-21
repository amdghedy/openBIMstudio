/**
 * AI that models — natural-language modelling, NL query and the generative
 * grid study, proven in the real browser with no API key and no server.
 *
 * 1. The command palette (Ctrl+P) offers "Model: draw a 4×6 room with a
 *    door and two windows"; running it models a real native room — 4 walls
 *    forming the 4×6 rectangle, 1 hosted door, 2 hosted windows — through
 *    the same history-wrapped authoring engine the draw tools use.
 * 2. NL query over the live model selects by category and by a real
 *    property criterion ("taller than 3.5 m" matches nothing, proving the
 *    criterion is live, not vacuous).
 * 3. The generative grid study scores five spacings and picks the best.
 * 4. An unparseable sentence is an honest refusal, not a hallucinated room.
 *
 * Keyless by design: nothing here calls a provider. The cloud AI chat
 * still needs the user's own API key — only the words-to-model path
 * itself needs no key (see the ai-modelling registry entry).
 */
import { test, expect, type Page } from "@playwright/test";

test.setTimeout(600000);

const TELEMETRY_NOISE = [/api\/visits/, /ipapi\.co/, /ERR_TUNNEL_CONNECTION_FAILED/];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`response ${r.status()}: ${r.url()}`);
  });
  return errors;
}

// The app's own telemetry fires console.errors in any run here and is
// unrelated to AI modelling: the visits endpoint 404s on vite preview and
// is CSP-blocked to the Workers host, and ipapi.co has no route out of
// this VM. Everything else still fails the test.
function assertNoRealErrors(errors: string[], label: string): void {
  const hasVisits404 = errors.some((e) => /^response 404: .*\/api\/visits/.test(e));
  const fatal = errors.filter((e) => {
    if (TELEMETRY_NOISE.some((re) => re.test(e))) return false;
    if (
      hasVisits404 &&
      e === "console.error: Failed to load resource: the server responded with a status of 404 (Not Found)"
    ) {
      return false;
    }
    return true;
  });
  expect(fatal, `${label}: ${fatal.join("\n")}`).toEqual([]);
}

async function enterAuthoring(page: Page): Promise<void> {
  const home = page.locator(".obs-home.is-open");
  if (await home.count()) {
    await page
      .locator('.obs-workspace-card[data-workspace="authoring"]')
      .evaluate((el) => (el as HTMLElement).click())
      .catch(() => {});
    await expect(home).toHaveCount(0, { timeout: 30000 });
  }
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.authoring), { timeout: 60000 })
    .toBe(true);
}

async function getElements(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.getElements());
}

async function authoredCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const ctx = (window as any).__OBS_CTX__;
    ctx?.world?.scene?.three?.traverse?.((o: any) => {
      if (o?.userData?.elementId) seen.add(String(o.userData.elementId));
    });
    return seen.size;
  });
}

function wallLength(el: any): number {
  const [ax, az] = el.params.start;
  const [bx, bz] = el.params.end;
  return Math.hypot(bx - ax, bz - az);
}

test("AI models: palette command draws the 4×6 room, NL query selects it, grid study scores", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await enterAuthoring(page);
  // The workflow packs load after authoring (dynamic imports); wait for
  // them instead of racing the palette.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            typeof (window as any).__OBS_CTX__?.features?.workflowPack8?.runNlModel === "function" &&
            typeof (window as any).__OBS_CTX__?.features?.workflowPack5?.runGridSpacingStudy === "function",
        ),
      { timeout: 120000 },
    )
    .toBe(true);

  // 1. Model the room from the palette — the user-visible, keyless path.
  await page.keyboard.press("Control+p");
  await expect(page.locator("#obs-command-palette")).toBeVisible({ timeout: 15000 });
  await page.locator("#obs-command-palette input").fill("4×6 room");
  // getByText(exact) finds the label itself; the click bubbles to the row's
  // onclick, which executes the command. (Clicking the palette container
  // instead just closes the palette via its backdrop handler.)
  const row = page.getByText("Model: draw a 4×6 room with a door and two windows", { exact: true });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect.poll(() => getElements(page).then((els) => els.length), { timeout: 60000 }).toBe(7);

  const els = await getElements(page);
  const walls = els.filter((e) => e.type === "wall");
  const doors = els.filter((e) => e.type === "door");
  const windows = els.filter((e) => e.type === "window");
  expect(walls).toHaveLength(4);
  expect(doors).toHaveLength(1);
  expect(windows).toHaveLength(2);
  // The four walls form the 4×6 rectangle, south → east → north → west.
  expect(walls.map(wallLength)).toEqual([4, 6, 4, 6]);
  for (const w of walls) expect(w.params.height).toBe(3.0);
  expect(walls[0].params.start).toEqual([0, 0]);
  expect(walls[0].params.end).toEqual([4, 0]);
  expect(walls[2].params.start).toEqual([4, 6]);
  // Openings are really hosted: door centred on the south wall, windows
  // spread on the north wall, with the real default sizes.
  const wallIds = new Set(walls.map((w) => w.id));
  expect(doors[0].hostId).toBe(walls[0].id);
  expect(doors[0].params.width).toBe(0.9);
  expect(doors[0].params.offsetAlongHost).toBe(2);
  for (const win of windows) {
    expect(wallIds.has(win.hostId)).toBe(true);
    expect(win.hostId).toBe(walls[2].id);
    expect(win.params.width).toBe(1.2);
    expect(win.params.sillHeight).toBe(0.9);
  }
  expect(windows.map((w) => w.params.offsetAlongHost).sort()).toEqual([1.25, 2.75]);
  // And the room is really in the 3D scene, not just in the document.
  await expect.poll(() => authoredCount(page), { timeout: 30000 }).toBeGreaterThanOrEqual(7);

  // 2. NL query over the live model.
  const selected = async () =>
    page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.getSelectedIds());
  await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.workflowPack8.runNlQuery("select all walls"),
  );
  await expect.poll(selected, { timeout: 30000 }).toHaveLength(4);
  await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.workflowPack8.runNlQuery("select all doors"),
  );
  await expect.poll(selected, { timeout: 30000 }).toHaveLength(1);
  // The height criterion is live: no wall is taller than 3.5 m, so the
  // query matches nothing. (Before the params→properties fix this matched
  // all 4.) A zero-hit query leaves the previous selection alone by
  // design, so clear it first and assert both the count and the selection.
  const tall = await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.workflowPack8.runNlQuery("select walls taller than 3.5m"),
  );
  expect(tall.matchedCount).toBe(0);
  await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.setSelectedAuthored([]));
  await expect.poll(selected, { timeout: 30000 }).toHaveLength(0);

  // 3. Generative grid study: five scored spacings, best first.
  const study = await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.workflowPack5.runGridSpacingStudy(),
  );
  expect(Array.isArray(study)).toBe(true);
  expect(study).toHaveLength(5);
  expect(study[0].spacing).toBe(7.5);
  expect(study[0].score).toBe(120);
  expect(study.map((c: any) => c.spacing).sort()).toEqual([3, 4.5, 6, 7.5, 9]);

  // 4. An unparseable sentence refuses honestly and creates nothing.
  const before = (await getElements(page)).length;
  const bad = await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.workflowPack8.runNlModel("draw something nice"),
  );
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/does not describe a room|no room size/);
  expect((await getElements(page)).length).toBe(before);

  assertNoRealErrors(errors, "page errors");
});
