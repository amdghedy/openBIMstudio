import { expect, type Page } from '@playwright/test';

/**
 * Open the command palette and type `query`, robustly.
 * Flakes seen in CI (Chromium and WebKit): Ctrl+P pressed before the palette's global key listener existed
 * (keystroke lost), or text typed before the input had focus (characters lost, no row ever matched).
 * Ctrl+P TOGGLES, so we only press again while the palette is verifiably closed.
 */
export async function openPaletteWith(page: Page, query: string): Promise<void> {
  const palette = page.locator('#obs-command-palette');
  const input = palette.locator('input');
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press('Control+p');
    await expect(palette).toBeVisible({ timeout: 1500 });
    await expect(input).toBeFocused({ timeout: 1500 });
    await input.fill('');
    await input.pressSequentially(query);
    await expect(input).toHaveValue(query, { timeout: 1500 });
  }).toPass({ timeout: 20000, intervals: [250, 500, 1000] });
}
