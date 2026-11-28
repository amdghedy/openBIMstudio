import { test, expect, type Page } from '@playwright/test';

// Revit parity Rank 6, item 2 — mass → elements browser proof.
//
// `classifyMassFace` existed unrated and was never called from anywhere:
// no UI, no conversion, no test. `convertMassToElements` (mass-to-elements.ts)
// converts one conceptual mass into native authored elements — one element
// per face — through the same `createElementByType` entry the draw tools
// and plugins use, and the ribbon's Massing groups expose it as
// "Mass to Elements".
//
// What this spec drives through the REAL UI:
//   - Massing & Site tab → "In-Place Mass" dialog (width 4, height 3)
//     → a 4×4×3 conceptual mass, read back through the mass feature api
//   - "Mass to Elements" → the conversion report dialog (6 rows) → Close
// What it asserts on the RENDERED model (not helper return values):
//   - 6 authored elements via __obsAuthoring.getElements(): 4 walls whose
//     start/end are the footprint edges at height 3, 1 roof (footprint
//     polygon, elevation 3), 1 slab (footprint polygon, elevation 0 — the
//     foundation from the mass bottom face, which the old classifier
//     mislabelled as roof)
//   - the live scene graph carries a mesh box per element with the matching
//     extents (walls y 0..3, roof y 3..3.25, slab y 0..0.2)
//   - the "Created 6 element(s)" success toast
//
// Run: npx playwright test tests/e2e/mass-to-elements.spec.ts --project=chromium

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(card).toBeVisible({ timeout: 90000 });
  await card.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 90000 });
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

const gotoTab = async (page: Page, tabId: string) => {
  await page.locator(`button.obs-ribbon__tab[data-tab="${tabId}"]`).click();
  await page.waitForTimeout(350);
};
const clickStripButton = async (page: Page, label: string) => {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(700);
};

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
  id: string; type: string;
  start: [number, number] | null; end: [number, number] | null;
  polygon: Array<[number, number]> | null;
  elevation: number | null; height: number | null; thickness: number | null;
};
const getElements = (page: Page): Promise<ElState[]> =>
  page.evaluate(() => {
    const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
    return els.map((e: any) => ({
      id: String(e.id),
      type: String(e.type),
      start: e.params?.start ? [...e.params.start] : null,
      end: e.params?.end ? [...e.params.end] : null,
      polygon: e.params?.polygon ? e.params.polygon.map((p: any) => [...p]) : null,
      elevation: typeof e.params?.elevation === 'number' ? e.params.elevation : null,
      height: typeof e.params?.height === 'number' ? e.params.height : null,
      thickness: typeof e.params?.thickness === 'number' ? e.params.thickness : null,
    }));
  });

/** World-space AABB per element id from the LIVE scene graph (FU7 pattern). */
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

test('a 4×4×3 mass converts to 4 walls + roof + foundation slab in the browser', async ({ page }) => {
  test.setTimeout(300000); // the mass api readiness wait alone takes ~124 s (120 s boot fallback)
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);
  await installToastLog(page);
  // ctx.features.mass is set by setupInPlaceMass in critical-gaps-boot's runOnce
  // (isReady-gated, 120 s fallback): the dialog silently toasts and
  // returns when it is missing, so wait for the module like adaptive.
  await page.waitForFunction(
    () => !!(window as any).__OBS_CTX__?.features?.mass,
    undefined,
    { timeout: 150000 },
  );
  await viewportBox(page);

  // ── 1. Create the mass through the real dialog.
  await gotoTab(page, 'massing-site');
  await clickStripButton(page, 'In-Place Mass');
  const massModal = page.locator('.obs-form-modal');
  await expect(massModal).toBeVisible({ timeout: 15000 });
  await expect(massModal.getByText('Create In-Place Mass')).toBeVisible();
  await massModal.locator('input').nth(0).fill('4');
  await massModal.locator('input').nth(1).fill('3');
  await massModal.getByRole('button', { name: 'Create Mass', exact: true }).click();
  await page.waitForTimeout(800);
  const mass = await page.waitForFunction(
    () => {
      const list = (window as any).__OBS_CTX__?.features?.mass?.list?.() ?? [];
      return list[0] ?? null;
    },
    undefined,
    { timeout: 20000 },
  ).then((h) => h.evaluate((m: any) => ({
    id: String(m.id), name: String(m.name),
    basePolygon: m.basePolygon.map((p: any) => [...p]) as Array<[number, number]>,
    height: Number(m.height),
  })));
  expect(mass.basePolygon).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]]);
  expect(mass.height).toBe(3);
  console.log('[mass-to-elements] mass:', mass.id, mass.basePolygon, 'h=', mass.height);

  // ── 2. Convert it through the ribbon button.
  await clickStripButton(page, 'Mass to Elements');
  const overlay = page.locator('.obs-form-modal-overlay');
  await expect(overlay.getByText(`Mass to elements — ${mass.name}`)).toBeVisible({ timeout: 15000 });
  await expect(overlay.getByText('6 row(s)')).toBeVisible();
  await expect(overlay.getByText('6 element(s) created')).toBeVisible();
  await overlay.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForTimeout(800);

  // ── 3. The six authored elements, with the right parameters.
  const els = await getElements(page);
  const walls = els.filter((e) => e.type === 'wall');
  const roofs = els.filter((e) => e.type === 'roof');
  const slabs = els.filter((e) => e.type === 'slab');
  expect(walls, `expected 4 walls, got ${JSON.stringify(els.map((e) => e.type))}`).toHaveLength(4);
  expect(roofs).toHaveLength(1);
  expect(slabs).toHaveLength(1);
  const edgeSet = new Set(walls.map((w) => `${w.start!.join(',')}->${w.end!.join(',')}`));
  for (const [a, b] of [[[0, 0], [4, 0]], [[4, 0], [4, 4]], [[4, 4], [0, 4]], [[0, 4], [0, 0]]] as Array<[[number, number], [number, number]]>) {
    expect(edgeSet.has(`${a.join(',')}->${b.join(',')}`), `a wall must span ${a} → ${b}`).toBe(true);
  }
  for (const w of walls) {
    expect(w.elevation).toBe(0);
    expect(w.height).toBe(3);
  }
  expect(roofs[0].polygon).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]]);
  expect(roofs[0].elevation).toBe(3);
  expect(slabs[0].polygon).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]]);
  expect(slabs[0].elevation).toBe(0);
  console.log('[mass-to-elements] elements:', els.map((e) => `${e.type}:${e.id.slice(0, 8)}`).join(' '));

  // ── 4. The rendered model: one mesh box per element, right extents.
  // Wait for the boxes to be STABLE, not merely present: creation fires a
  // rebuild per element, and measuring the instant every id first appears
  // caught a transient once (one run measured a 0.255 m wall box — the bare
  // thickness — that two targeted probes could not reproduce; the steady
  // state is the mitered 4.255 m box). Two identical reads 500 ms apart
  // mean the scene has settled; the extents asserted below are unchanged.
  const boxes = await page.waitForFunction(
    async (ids: string[]) => {
      const read = () => {
        const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
        if (!scene) return null;
        scene.updateMatrixWorld(true);
        const out: Record<string, number[]> = {};
        scene.traverse((o: any) => {
          const id = o?.userData?.elementId ? String(o.userData.elementId) : null;
          if (!id || !ids.includes(id)) return;
          o.traverse((m: any) => {
            if (!m.isMesh || !m.geometry) return;
            const g = m.geometry;
            if (!g.boundingBox) g.computeBoundingBox();
            const bb = g.boundingBox;
            if (!bb) return;
            const e = m.matrixWorld.elements as number[];
            const b = out[id] ?? (out[id] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
            for (const cx of [bb.min.x, bb.max.x])
              for (const cy of [bb.min.y, bb.max.y])
                for (const cz of [bb.min.z, bb.max.z]) {
                  const x = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
                  const y = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
                  const z = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
                  b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z);
                  b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z);
                }
          });
        });
        return Object.keys(out).length === ids.length ? out : null;
      };
      const first = read();
      if (!first) return null;
      await new Promise((r) => setTimeout(r, 500));
      const second = read();
      if (!second) return null;
      const same = ids.every((id) => first[id].every((v, i) => Math.abs(v - second[id][i]) < 1e-6));
      return same ? first : null;
    },
    els.map((e) => e.id),
    { timeout: 30000 },
  ).then(async () => {
    const raw = await getSceneBoxes(page);
    return raw;
  });
  expect(boxes, 'the live scene must carry every converted element').toBeTruthy();
  for (const w of walls) {
    const b = boxes![w.id];
    expect(b, `wall ${w.id} must render`).toBeTruthy();
    expect(b!.min[1]).toBeCloseTo(0, 2);
    expect(b!.max[1]).toBeCloseTo(3, 2);
    // The rendered wall is its 4 m edge PLUS the mitre extension at both
    // ends (half a thickness into each corner of the closed loop), so the
    // live box is 4 + thickness long — a lone wall measures exactly 4 m.
    // The +thickness here is the proof the corner joins engaged.
    const planLen = Math.max(b!.max[0] - b!.min[0], b!.max[2] - b!.min[2]);
    expect(planLen).toBeCloseTo(4 + (w.thickness ?? 0.25), 1);
  }
  const roofBox = boxes![roofs[0].id];
  expect(roofBox.min[1]).toBeCloseTo(3, 2);
  expect(roofBox.max[1]).toBeCloseTo(3.25, 2);
  const slabBox = boxes![slabs[0].id];
  expect(slabBox.min[1]).toBeCloseTo(0, 2);
  expect(slabBox.max[1]).toBeCloseTo(0.2, 2);

  // ── 5. Toast confirmation, no page errors.
  const toasts = await toastLog(page);
  expect(
    toasts.some(([k, m]) => k === 'success' && m.startsWith('Created 6 element(s)')),
    `a success toast must confirm the conversion (log: ${JSON.stringify(toasts)})`,
  ).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
