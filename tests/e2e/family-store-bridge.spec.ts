import { test, expect, type Page } from "@playwright/test";

/**
 * family-store-bridge.spec.ts — browser proof for the two-way bridge
 * between the TS family service (familyStore) and the legacy Family
 * Creator editor (localStorage obs.families.v1).
 *
 * - Editor save -> the family appears in the Parametric Panel and the
 *   Family Browser (live, without reopening), and persists exactly
 *   once across a reload.
 * - The sample Parametric Door (service) is visible in the editor's
 *   Library dropdown.
 * - Shared parameters sync both ways (editor -> manager storage,
 *   manager storage -> editor list).
 * - Editor delete removes the family from the service too.
 *
 * Run against the branch's own preview server, never :3000:
 *   npm run build
 *   npx vite preview --port 3122 --host 127.0.0.1
 *   npx playwright test --config <config with baseURL http://127.0.0.1:3122,
 *     no webServer> tests/e2e/family-store-bridge.spec.ts --project=chromium
 */

const LS_LIB = "obs.families.v1";
const LS_SHARED = "openbimstudio.shared-parameters";
const BRIDGE_NAME = "Bridge Test Table";
const DELETE_NAME = "Bridge Delete Me";

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector(".obs-workspace-card[data-workspace=\"authoring\"]", { timeout: 20000 });
  await page.locator(".obs-workspace-card[data-workspace=\"authoring\"]").click();
  await expect(page.locator("#home-screen")).toBeHidden({ timeout: 20000 });
  await page.waitForSelector("canvas", { timeout: 20000 });
}

async function waitBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__obsFamily && (window as any).__obsFamilyBridge,
    undefined,
    { timeout: 30000 },
  );
  // The sample Parametric Door is seeded synchronously with the service.
  await expect
    .poll(() => listNames(page), { timeout: 15000 })
    .toContain("Parametric Door");
}

async function listNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as any).__obsFamily.list() as Array<{ name: string }>).map((f) => f.name),
  );
}

async function countName(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) =>
      ((window as any).__obsFamily.list() as Array<{ name: string }>).filter((f) => f.name === n)
        .length,
    name,
  );
}

async function openCreator(page: Page): Promise<void> {
  // A12: the "Family Creator" button lives on the Parametric tab's strip
  // ("Families" group) — it moved there from the Insert tab's
  // "Load from Library" group. (A separate "Family Creator" panel toggle
  // also exists on the Manage tab, but that is not the engine this opens.)
  const tab = page.locator('button.obs-ribbon__tab[data-tab="parametric"]');
  if (await tab.count()) await tab.first().click();
  await page.getByRole("button", { name: "Family Creator", exact: true }).first().click();
  await expect(page.locator(".obs-fe-backdrop.is-open")).toBeVisible({ timeout: 15000 });
}

async function closeCreator(page: Page): Promise<void> {
  await page.locator(".obs-fe-close").click();
  await expect(page.locator(".obs-fe-backdrop.is-open")).toBeHidden({ timeout: 10000 });
}

test("editor save appears in the panel and browser, persists once across reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await enterAuthoring(page);
  await waitBridge(page);

  const beforeLen = await page.evaluate(
    () => ((window as any).__obsFamily.list() as unknown[]).length,
  );

  // Service -> editor: the sample Parametric Door is in the Library dropdown.
  await openCreator(page);
  const libText = await page.locator("#fe-lib").innerText();
  expect(libText).toContain("Parametric Door");

  // Editor -> service: save a family from the Creator. The editor
  // opens on its default Parameters tab; the name field is on Identity.
  await page.locator('.obs-fe-tab[data-tab="identity"]').click();
  await page.locator("#fe-name").fill(BRIDGE_NAME);
  await page.locator("#fe-save-lib").click();
  await expect.poll(() => listNames(page), { timeout: 10000 }).toContain(BRIDGE_NAME);

  // The library entry carries the stamped service id.
  const libEntry = await page.evaluate(
    ([key, name]) => {
      const lib = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<
        string,
        { serviceId?: string }
      >;
      return lib[name];
    },
    [LS_LIB, BRIDGE_NAME] as const,
  );
  expect(libEntry?.serviceId, "library entry stamped with serviceId").toBeTruthy();

  // Live refresh: the Parametric Panel (already open behind the modal)
  // shows it without being reopened.
  await closeCreator(page);
  const panelSelect = page.locator("#obs-param-family-panel [data-family]");
  await expect
    .poll(async () => panelSelect.innerText(), { timeout: 10000 })
    .toContain(BRIDGE_NAME);

  // The Family Browser shows it too.
  await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.familyBrowser.open(),
  );
  const browser = page.locator("#obs-family-browser");
  await expect(browser).toBeVisible({ timeout: 10000 });
  await expect(browser).toContainText(BRIDGE_NAME);

  // Reload: exactly one copy, and the seed door is still exactly one.
  await page.reload();
  await enterAuthoring(page);
  await waitBridge(page);
  expect(await countName(page, BRIDGE_NAME)).toBe(1);
  expect(await countName(page, "Parametric Door")).toBe(1);
  const afterLen = await page.evaluate(
    () => ((window as any).__obsFamily.list() as unknown[]).length,
  );
  // The seed catalog re-adds on every boot (pre-existing loader defect,
  // out of this item's scope): log the drift, do not assert on it.
  // eslint-disable-next-line no-console
  console.log(`family list length before reload=${beforeLen} after=${afterLen}`);

  expect(errors, `page errors: ${errors.join("; ")}`).toEqual([]);
});

test("shared parameters sync both ways", async ({ page }) => {
  await enterAuthoring(page);
  await waitBridge(page);

  // Manager storage -> editor: seed a param straight into the manager's
  // storage key, sync, and it shows in the editor's Shared list.
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify([
        {
          guid: "svc-shared-guid-1",
          name: "SvcShared",
          group: "General",
          type: "length",
          defaultValue: 0.5,
          isInstance: true,
        },
      ]),
    );
  }, LS_SHARED);
  await page.evaluate(() => (window as any).__obsFamilyBridge.syncSharedParameters());

  await openCreator(page);
  await page.locator('.obs-fe-tab[data-tab="shared"]').click();
  await expect(page.locator("#fe-shared-list")).toContainText("SvcShared");

  // Editor -> manager storage: add a param in the editor.
  await page.locator("#fe-shared-name").fill("BridgeShared");
  await page.locator("#fe-shared-add").click();
  const stored = await page.evaluate((key) => {
    const list = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ name: string }>;
    return list.map((p) => p.name);
  }, LS_SHARED);
  expect(stored).toContain("BridgeShared");
  await closeCreator(page);
});

test("editor delete removes the family from the service", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());

  await enterAuthoring(page);
  await waitBridge(page);

  // Seed the family through the bridge handle (the app's own API).
  await page.evaluate((name) => {
    (window as any).__obsFamilyBridge.pushEditorFamily({
      name,
      displayCategory: "Generic Models",
      parameters: [],
      types: [],
      geometry: { kind: "Extrusion", profile: "Rectangle", depth: "0.5" },
    });
  }, DELETE_NAME);
  await expect.poll(() => listNames(page), { timeout: 10000 }).toContain(DELETE_NAME);

  await openCreator(page);
  await page.locator("#fe-lib").selectOption(DELETE_NAME);
  await page.locator("#fe-del-lib").click();
  // The delete goes through the native confirm() the editor still
  // uses; the dialog handler above accepts it.
  await expect.poll(() => listNames(page), { timeout: 10000 }).not.toContain(DELETE_NAME);
  const stillThere = await page.evaluate(
    (key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? "{}")),
    LS_LIB,
  );
  expect(stillThere).not.toContain(DELETE_NAME);
  await closeCreator(page);
});
