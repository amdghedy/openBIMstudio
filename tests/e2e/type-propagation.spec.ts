import { test, expect, type Page } from '@playwright/test';

// Follow-up 7 — browser end-to-end proof for Slice 1 (type edits preserve
// instance overrides), the acceptance test the node suite (T1–T5) could only
// prove at helper/seam level.
//
//   Type edit → every instance of that type follows (resolved value AND
//   rebuilt geometry), and an instance override set BEFORE the type edit
//   survives it unchanged in the rendered model.
//
// Family choice: Generic Equipment, the only builtin family that is BOTH
// freestanding/point-placed AND carries type-scope parameters. Basic Column
// (used by the hosting specs) has NO type-scope parameter at all — every
// one of its parameters is instance-scope, so no type edit is possible on
// it — and Door/Window are wall-hosted. Generic Equipment has type-scope
// thickness / depth / height and instance-scope elevation, with a single
// type "Generic 800 x 800 x 1200" (thickness 0.8, depth 0.8, height 1.2).
// A Basic Column instance is placed as well as an untouched-family control
// (A1: "and no other").
//
// What this spec drives through the REAL UI:
//   - entering the Authoring workspace (home card click)
//   - Parametric Families panel: family <select>, "Place instance" button,
//     canvas clicks that place the instances
//   - Properties palette: the family "Parameters" rows — the Elevation
//     (instance, badge "I") input for the override, then the height
//     (type, badge "T") input for the type edit — real fill + Tab, which
//     fires the palette's onchange → editFamilyParameter → sync path
//   - the "Updated 2 instance(s)" toast the palette fires when a type
//     edit syncs instances
//
// What it does NOT drive through the UI (and why):
//   - the panel open: the Ctrl+Shift+F shortcut does NOT deliver the F
//     keydown in this Playwright/Chromium environment (probed in the
//     ribbon-hosting spec) — so the spec opens the panel through its
//     __obsParamFamilyPanel handle, the same entry point the command
//     palette's "Parametric Families Panel" command calls. Everything
//     INSIDE the panel (family select, Place button) is real DOM
//     interaction, and the viewport clicks that place the instances are
//     real canvas clicks.
//   - element selection: canvas-click selection of a 0.8 m box is not
//     reliably drivable, so the selection is set through
//     __obsAuthoring.setSelectedAuthored — the same API the Family Browser
//     uses. The palette auto-opens on selection; if it does not, the spec
//     clicks the real "Properties" button in the options bar.
//   - state reads: element state via __obsAuthoring.getElements() and the
//     rendered model via a traversal of the live scene graph
//     (__OBS_CTX__.world.scene.three), computing world-space AABBs from
//     the meshes the app itself rendered. These are read-only observation,
//     not interaction.
//
// What the spec asserts on the RENDERED model (not helper return values):
//   - each equipment instance's live-scene bounding box: y-extent =
//     elevation..elevation+height and x/z-extent = 0.8 m about its point,
//     before AND after the edits. The instance-scope elevation edit does
//     NOT rebuild the scene (markAuthoringDirty only), so the rendered
//     model is asserted after the type edit, whose sync calls rebuild().
//   - the control column's live-scene box is unchanged by the edit.
//
// Run ONLY against this branch's own build on :3122 (see
// playwright.family-hosting.config.ts at the repo root): the repo's
// default config reuses any server already on :3000, and a sibling
// worktree's preview server would make this spec silently test the
// wrong build.
//   npx vite build && npx vite preview --port 3122 --host 127.0.0.1 --strictPort
// Marker check first (served page must be THIS build):
//   curl -s http://127.0.0.1:3122/ | grep -o 'assets/index-[^"]*\.js'
//   must equal the asset in dist/index.html
// Then, one spec at a time (1.5-CPU VM — never run browser specs concurrently):
//   npx playwright test --config playwright.family-hosting.config.ts tests/e2e/type-propagation.spec.ts --project=chromium
// Audit re-run 2026-11-22 on main 7f07c3d9: 1 passed (1.7m), no drift —
// the FU7 proof holds as written (the ribbon toast double-fire found
// by the hosting-ribbon audit does not affect this spec: it asserts
// toast presence with .some(), not an exact count).

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
}

/** Largest visible canvas = the 3D viewport (document-chain pattern). */
async function viewportBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(
      (c) => c.offsetWidth > 200 && c.offsetHeight > 200,
    );
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible').toBeTruthy();
  return box!;
}

/** Deterministic toast capture: the ribbon renders obs-toast events as .obs-toast. */
async function installToastLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__toastLog = [];
    window.addEventListener('obs-toast', (e: any) =>
      (window as any).__toastLog.push([String(e.detail?.kind ?? ''), String(e.detail?.message ?? '')]),
    );
  });
}
const toastLog = (page: Page) =>
  page.evaluate(() => (window as any).__toastLog as Array<[string, string]> ?? []);

/** Authored elements, read through the same handle the app's UI uses. */
type ElState = {
  id: string; type: string; familyId: string | null; familyTypeId: string | null;
  point: [number, number] | null;
  height: number | null; thickness: number | null; depth: number | null; elevation: number | null;
};
const getElements = (page: Page): Promise<ElState[]> =>
  page.evaluate(() => {
    const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
    return els.map((e: any) => ({
      id: String(e.id),
      type: String(e.type),
      familyId: e.familyId ? String(e.familyId) : null,
      familyTypeId: e.familyTypeId ? String(e.familyTypeId) : null,
      point: e.params?.point ? [...e.params.point] : null,
      height: typeof e.params?.height === 'number' ? e.params.height : null,
      thickness: typeof e.params?.thickness === 'number' ? e.params.thickness : null,
      depth: typeof e.params?.depth === 'number' ? e.params.depth : null,
      elevation: typeof e.params?.elevation === 'number' ? e.params.elevation : null,
    }));
  });

/**
 * World-space AABB of every element id present in the LIVE scene graph,
 * computed from the meshes the app itself rendered (geometry.boundingBox
 * transformed by each mesh's matrixWorld). A group carrying an elementId
 * contributes its whole subtree; a mesh carrying one contributes itself.
 * Returns null when the scene is not reachable yet.
 */
type SceneBox = { min: [number, number, number]; max: [number, number, number] };
const getSceneBoxes = (page: Page): Promise<Record<string, SceneBox> | null> =>
  page.evaluate(() => {
    const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
    if (!scene || typeof scene.traverse !== 'function') return null;
    scene.updateMatrixWorld(true);
    const boxes: Record<string, SceneBox> = {};
    const addMesh = (id: string, m: any) => {
      const g = m.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      const e = m.matrixWorld.elements as number[];
      const b = boxes[id] ?? (boxes[id] = {
        min: [Infinity, Infinity, Infinity] as [number, number, number],
        max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
      });
      for (const cx of [bb.min.x, bb.max.x])
        for (const cy of [bb.min.y, bb.max.y])
          for (const cz of [bb.min.z, bb.max.z]) {
            const x = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
            const y = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
            const z = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
            b.min[0] = Math.min(b.min[0], x); b.min[1] = Math.min(b.min[1], y); b.min[2] = Math.min(b.min[2], z);
            b.max[0] = Math.max(b.max[0], x); b.max[1] = Math.max(b.max[1], y); b.max[2] = Math.max(b.max[2], z);
          }
    };
    scene.traverse((o: any) => {
      const id = o?.userData?.elementId ? String(o.userData.elementId) : null;
      if (!id) return;
      o.traverse((m: any) => { if (m.isMesh) addMesh(id, m); });
    });
    return boxes;
  });

/** Place one instance of the named panel family at a canvas point (real UI inside the panel + real canvas click). */
async function placeFamilyInstance(
  page: Page,
  familyOptionText: string,
  expectedType: string,
  at: { x: number; y: number },
  excludeIds: string[],
): Promise<ElState> {
  await page.waitForFunction(
    () => !!(window as any).__obsParamFamilyPanel,
    undefined,
    { timeout: 90000 },
  );
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.open?.());
  await expect(page.locator('#obs-param-family-panel.is-open')).toBeVisible({ timeout: 15000 });
  const famId = await page.evaluate((label: string) => {
    const sel = document.querySelector('#obs-param-family-panel [data-family]') as HTMLSelectElement | null;
    if (!sel) return null;
    const opt = [...sel.options].find((o) => o.textContent === label);
    return opt ? opt.value : null;
  }, familyOptionText);
  expect(famId, `the ${familyOptionText} family must be listed in the panel`).toBeTruthy();
  await page.locator('#obs-param-family-panel [data-family]').selectOption(famId!);
  await page.waitForTimeout(400);
  const typeText = await page.evaluate(() => {
    const sel = document.querySelector('#obs-param-family-panel [data-type]') as HTMLSelectElement | null;
    return sel ? sel.options[sel.selectedIndex]?.textContent ?? null : null;
  });
  console.log(`[type-prop] placing ${familyOptionText} (type: ${typeText})`);
  await page.locator('#obs-param-family-panel [data-act="place"]').click();
  await page.waitForTimeout(500);
  const tool = await page.evaluate(
    () => (window as any).__OBS_CTX__?.features?.authoring?.getActiveTool?.() ?? null,
  );
  expect(tool, `the ${expectedType} place tool must become active`).toBe(expectedType);
  // Let the pointer settle over the canvas before clicking: the snap
  // system updates its last result asynchronously on pointermove, and an
  // instant click can commit the PREVIOUS hover position instead of this
  // one (observed: two instant clicks at different screen-x placed both
  // instances at the same world point).
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(700);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  const placed = await page.waitForFunction(
    (args: { type: string; exclude: string[] }) => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      return els.find((e: any) =>
        e.type === args.type && e.familyId && e.params?.point && !args.exclude.includes(String(e.id)),
      ) ?? null;
    },
    { type: expectedType, exclude: excludeIds },
    { timeout: 20000 },
  ).then((h) => h.evaluate((e: any) => ({
    id: String(e.id),
    type: String(e.type),
    familyId: e.familyId ? String(e.familyId) : null,
    familyTypeId: e.familyTypeId ? String(e.familyTypeId) : null,
    point: [...e.params.point] as [number, number],
    height: typeof e.params?.height === 'number' ? e.params.height : null,
    thickness: typeof e.params?.thickness === 'number' ? e.params.thickness : null,
    depth: typeof e.params?.depth === 'number' ? e.params.depth : null,
    elevation: typeof e.params?.elevation === 'number' ? e.params.elevation : null,
  } as ElState)));
  return placed;
}

/**
 * Edit one family parameter through the REAL Properties-palette input.
 * The family rows are the only rows carrying a T/I scope badge; the label
 * is the family's label-or-name (equipment: "height" and "elevation" are
 * the raw parameter names — only thickness has a display label, "Width").
 * fill() + Tab fires the palette's onchange handler.
 */
async function setFamilyParam(page: Page, label: string, scope: 'T' | 'I', value: number): Promise<void> {
  const input = page.locator(
    `xpath=//div[@id="obs-property-palette"]//div[label[text()="${label}"] and span[text()="${scope}"]]/input`,
  );
  await expect(input, `the ${label} (${scope}) family parameter row must exist`).toHaveCount(1, { timeout: 15000 });
  await expect(input).toBeVisible();
  await input.fill(String(value));
  await page.keyboard.press('Tab');
}

/** Select one element (service-level: the Family Browser's own API) and make sure the palette is open for it. */
async function selectAndOpenPalette(page: Page, id: string): Promise<void> {
  await page.evaluate((eid: string) => {
    (window as any).__obsAuthoring?.setSelectedAuthored?.([eid], 'replace');
  }, id);
  const opened = await page.waitForFunction(
    () => {
      const p = document.querySelector('#obs-property-palette') as HTMLElement | null;
      return !!p && getComputedStyle(p).display !== 'none';
    },
    undefined,
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  if (!opened) {
    // Selection did not auto-open the palette: open it with the real
    // "Properties" button in the options bar.
    await page.locator('#obs-options-bar').getByRole('button', { name: 'Properties', exact: true }).click();
    await expect(page.locator('#obs-property-palette')).toBeVisible({ timeout: 15000 });
  }
  await expect(page.locator('#obs-property-palette')).toBeVisible({ timeout: 15000 });
}

test('type edit propagates to all instances and the pre-set override survives, in the rendered model', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);
  await installToastLog(page);
  const box = await viewportBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // ── 1. Two Generic Equipment instances + one Basic Column control ──
  // Placement points differ in BOTH screen axes so the two instances
  // cannot silently land on the same world point.
  const eq1 = await placeFamilyInstance(page, 'Generic Equipment (equipment)', 'equipment', { x: cx - box.width * 0.20, y: cy - box.height * 0.10 }, []);
  console.log('[type-prop] equipment 1:', eq1.id, 'at', eq1.point, 'params h/t/d/elev:', eq1.height, eq1.thickness, eq1.depth, eq1.elevation);
  const eq2 = await placeFamilyInstance(page, 'Generic Equipment (equipment)', 'equipment', { x: cx + box.width * 0.20, y: cy + box.height * 0.10 }, [eq1.id]);
  console.log('[type-prop] equipment 2:', eq2.id, 'at', eq2.point, 'params h/t/d/elev:', eq2.height, eq2.thickness, eq2.depth, eq2.elevation);
  const col = await placeFamilyInstance(page, 'Basic Column (column)', 'column', { x: cx, y: cy - box.height * 0.22 }, [eq1.id, eq2.id]);
  console.log('[type-prop] control column:', col.id, 'at', col.point, 'params h/t/d/elev:', col.height, col.thickness, col.depth, col.elevation);
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.close?.());
  await page.waitForTimeout(400);

  // The two instances must be genuinely distinct placements — if they
  // co-located, the per-instance assertions below would be vacuous.
  expect(eq1.point).toBeTruthy();
  expect(eq2.point).toBeTruthy();
  expect(
    Math.hypot(eq1.point![0] - eq2.point![0], eq1.point![1] - eq2.point![1]),
    `the two equipment instances must land at different points (got ${eq1.point} and ${eq2.point})`,
  ).toBeGreaterThan(1);

  // Both instances are born from the same type: 800 x 800 x 1200.
  for (const el of [eq1, eq2]) {
    expect(el.familyId, 'the instance must carry the equipment family').toBeTruthy();
    expect(el.familyTypeId, 'the instance must carry the equipment type').toBeTruthy();
    expect(el.height).toBe(1.2);
    expect(el.thickness).toBe(0.8);
    expect(el.depth).toBe(0.8);
    expect(el.elevation).toBe(0);
  }
  expect(eq1.familyTypeId).toBe(eq2.familyTypeId);
  expect(col.height).toBe(3);
  expect(col.thickness).toBe(0.3);

  // Baseline rendered model: each box is 0.8 x 1.2 x 0.8 standing on y=0.
  const baseBoxes = await page.waitForFunction(
    (ids: string[]) => {
      const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
      if (!scene) return null;
      let found = 0;
      scene.traverse((o: any) => { if (o?.userData?.elementId && ids.includes(String(o.userData.elementId))) found++; });
      return found >= ids.length ? true : null;
    },
    [eq1.id, eq2.id, col.id],
    { timeout: 30000 },
  ).then(() => getSceneBoxes(page));
  expect(baseBoxes, 'the live scene must expose all three instances').toBeTruthy();
  const base1 = baseBoxes![eq1.id];
  const base2 = baseBoxes![eq2.id];
  const baseCol = baseBoxes![col.id];
  expect(base1, 'equipment 1 must have a rendered mesh').toBeTruthy();
  expect(base2, 'equipment 2 must have a rendered mesh').toBeTruthy();
  expect(baseCol, 'control column must have a rendered mesh').toBeTruthy();
  for (const [name, b, y0, y1] of [
    ['equipment 1', base1, 0, 1.2],
    ['equipment 2', base2, 0, 1.2],
    ['control column', baseCol, 0, 3],
  ] as const) {
    expect(b!.min[1]).toBeCloseTo(y0, 2);
    expect(b!.max[1]).toBeCloseTo(y1, 2);
  }
  expect(base1!.max[0] - base1!.min[0]).toBeCloseTo(0.8, 2);
  expect(base1!.max[2] - base1!.min[2]).toBeCloseTo(0.8, 2);
  // Each rendered box is centred on its own element's point.
  for (const [name, b, el] of [
    ['equipment 1', base1, eq1],
    ['equipment 2', base2, eq2],
    ['control column', baseCol, col],
  ] as const) {
    expect((b!.min[0] + b!.max[0]) / 2, `${name} box centre x`).toBeCloseTo(el.point![0], 2);
    expect((b!.min[2] + b!.max[2]) / 2, `${name} box centre z`).toBeCloseTo(el.point![1], 2);
  }
  console.log('[type-prop] baseline scene boxes:', JSON.stringify({ eq1: base1, eq2: base2, col: baseCol }));

  // ── 2. Instance override BEFORE the type edit, via the real palette ──
  // Select equipment 1; the palette auto-opens in edit mode for it.
  await selectAndOpenPalette(page, eq1.id);
  const famName = await page.locator('#obs-property-palette').innerText();
  expect(famName, 'the palette must show the Family block for Generic Equipment').toContain('Generic Equipment');
  expect(famName, 'the palette must show the Parameters section').toContain('Parameters');

  // Elevation is instance-scope ("I"): 0 → 0.5 on equipment 1 only.
  await setFamilyParam(page, 'elevation', 'I', 0.5);
  const afterOverride = await page.waitForFunction(
    (args: { id1: string; id2: string }) => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      const a = els.find((e: any) => e.id === args.id1);
      const b = els.find((e: any) => e.id === args.id2);
      if (!a || !b) return null;
      if (a.params.elevation !== 0.5 || b.params.elevation !== 0) return null;
      return { a: { h: a.params.height, e: a.params.elevation }, b: { h: b.params.height, e: b.params.elevation } };
    },
    { id1: eq1.id, id2: eq2.id },
    { timeout: 30000 },
  ).then((h) => h.evaluate((v: any) => v));
  expect(afterOverride, 'the elevation override must land on equipment 1 only').toBeTruthy();
  expect(afterOverride!.a).toEqual({ h: 1.2, e: 0.5 });
  expect(afterOverride!.b).toEqual({ h: 1.2, e: 0 });
  console.log('[type-prop] after instance override:', JSON.stringify(afterOverride));

  // ── 3. Type edit via the real palette: height 1.2 → 1.8 (badge "T") ──
  // The palette re-rendered after step 2, so the input is located fresh.
  await setFamilyParam(page, 'height', 'T', 1.8);
  const afterTypeEdit = await page.waitForFunction(
    (args: { id1: string; id2: string; colId: string }) => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      const a = els.find((e: any) => e.id === args.id1);
      const b = els.find((e: any) => e.id === args.id2);
      const c = els.find((e: any) => e.id === args.colId);
      if (!a || !b || !c) return null;
      if (a.params.height !== 1.8 || b.params.height !== 1.8) return null;
      return {
        a: { h: a.params.height, t: a.params.thickness, d: a.params.depth, e: a.params.elevation },
        b: { h: b.params.height, t: b.params.thickness, d: b.params.depth, e: b.params.elevation },
        c: { h: c.params.height, t: c.params.thickness, e: c.params.elevation },
      };
    },
    { id1: eq1.id, id2: eq2.id, colId: col.id },
    { timeout: 30000 },
  ).then((h) => h.evaluate((v: any) => v));
  expect(afterTypeEdit, 'both equipment instances must receive the type height').toBeTruthy();
  // A1: every instance of the type follows the type edit…
  expect(afterTypeEdit!.a.h).toBe(1.8);
  expect(afterTypeEdit!.b.h).toBe(1.8);
  // …and nothing else moves: untouched type values, and the other family.
  expect(afterTypeEdit!.a.t).toBe(0.8);
  expect(afterTypeEdit!.a.d).toBe(0.8);
  expect(afterTypeEdit!.b.t).toBe(0.8);
  expect(afterTypeEdit!.b.d).toBe(0.8);
  expect(afterTypeEdit!.c).toEqual({ h: 3, t: 0.3, e: 0 });
  // A3: the override set before the type edit survives it unchanged.
  expect(afterTypeEdit!.a.e).toBe(0.5);
  expect(afterTypeEdit!.b.e).toBe(0);
  console.log('[type-prop] after type edit (element state):', JSON.stringify(afterTypeEdit));

  // The palette's own feedback: the type edit synced both instances.
  const toasts = await toastLog(page);
  expect(
    toasts.some(([k, m]) => k === 'success' && m === 'Updated 2 instance(s)'),
    `a success toast must confirm both instances synced (log: ${JSON.stringify(toasts)})`,
  ).toBe(true);

  // ── 4. The RENDERED model: rebuilt geometry follows the type edit,
  //    the override survives in the rendered box ──
  const finalBoxes = await page.waitForFunction(
    (args: { id1: string; id2: string; colId: string }) => {
      const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
      if (!scene) return null;
      scene.updateMatrixWorld(true);
      const out: Record<string, { min: number[]; max: number[] }> = {};
      const collect = (id: string) => {
        const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        let seen = false;
        scene.traverse((o: any) => {
          if (String(o?.userData?.elementId ?? '') !== id) return;
          o.traverse((m: any) => {
            if (!m.isMesh || !m.geometry) return;
            if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
            const bb = m.geometry.boundingBox;
            if (!bb) return;
            seen = true;
            const e = m.matrixWorld.elements as number[];
            for (const cx of [bb.min.x, bb.max.x])
              for (const cy of [bb.min.y, bb.max.y])
                for (const cz of [bb.min.z, bb.max.z]) {
                  const x = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
                  const y = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
                  const z = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
                  b.min[0] = Math.min(b.min[0], x); b.min[1] = Math.min(b.min[1], y); b.min[2] = Math.min(b.min[2], z);
                  b.max[0] = Math.max(b.max[0], x); b.max[1] = Math.max(b.max[1], y); b.max[2] = Math.max(b.max[2], z);
                }
          });
        });
        if (seen) out[id] = b;
      };
      collect(args.id1); collect(args.id2); collect(args.colId);
      if (!out[args.id1] || !out[args.id2] || !out[args.colId]) return null;
      // Equipment 1: raised box (override elevation 0.5, new height 1.8).
      if (Math.abs(out[args.id1].min[1] - 0.5) > 0.02) return null;
      if (Math.abs(out[args.id1].max[1] - 2.3) > 0.02) return null;
      // Equipment 2: new height from the ground (no override).
      if (Math.abs(out[args.id2].min[1] - 0) > 0.02) return null;
      if (Math.abs(out[args.id2].max[1] - 1.8) > 0.02) return null;
      return out;
    },
    { id1: eq1.id, id2: eq2.id, colId: col.id },
    { timeout: 30000 },
  ).then((h) => h.evaluate((v: any) => v as Record<string, SceneBox> | null));
  expect(finalBoxes, 'the rendered scene must converge on the post-edit geometry').toBeTruthy();
  const f1 = finalBoxes![eq1.id];
  const f2 = finalBoxes![eq2.id];
  const fCol = finalBoxes![col.id];
  // Equipment 1: override survives IN THE RENDERED MODEL — its box floats
  // at elevation 0.5 and reaches 0.5 + 1.8 = 2.3.
  expect(f1.min[1]).toBeCloseTo(0.5, 2);
  expect(f1.max[1]).toBeCloseTo(2.3, 2);
  // Equipment 2: follows the type edit from the ground: 0 → 1.8.
  expect(f2.min[1]).toBeCloseTo(0, 2);
  expect(f2.max[1]).toBeCloseTo(1.8, 2);
  // Footprints unchanged (type width/depth untouched): 0.8 m both.
  expect(f1.max[0] - f1.min[0]).toBeCloseTo(0.8, 2);
  expect(f1.max[2] - f1.min[2]).toBeCloseTo(0.8, 2);
  expect(f2.max[0] - f2.min[0]).toBeCloseTo(0.8, 2);
  expect(f2.max[2] - f2.min[2]).toBeCloseTo(0.8, 2);
  // Control column: untouched by the equipment type edit, in the model too.
  expect(fCol.min[1]).toBeCloseTo(0, 2);
  expect(fCol.max[1]).toBeCloseTo(3, 2);
  // The rebuilt boxes stay centred on their own elements' points.
  for (const [name, b, el] of [
    ['equipment 1', f1, eq1],
    ['equipment 2', f2, eq2],
    ['control column', fCol, col],
  ] as const) {
    expect((b.min[0] + b.max[0]) / 2, `${name} box centre x`).toBeCloseTo(el.point![0], 2);
    expect((b.min[2] + b.max[2]) / 2, `${name} box centre z`).toBeCloseTo(el.point![1], 2);
  }
  console.log('[type-prop] final scene boxes:', JSON.stringify({ eq1: f1, eq2: f2, col: fCol }));

  expect(errors, errors.join('\n')).toEqual([]);
});
