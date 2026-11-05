import { test, expect } from '@playwright/test';

// FIXME: this spec was written against data-testid hooks (import-ifc, model-tree, element-count, tool-move,
// save-project) that the app does not have yet, so it cannot pass. Skipped until those hooks exist.
test.fixme('import, edit, undo, save, reload: state is identical', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('import-ifc')
    .setInputFiles('tests/fixtures/ifc-corpus/wall-demo.ifc');
  await expect(page.getByTestId('model-tree')).toContainText('IfcWall');
  const countBefore = await page.getByTestId('element-count').textContent();

  await page.getByTestId('tool-move').click();
  await page.mouse.click(400, 300);
  await page.mouse.click(500, 320);
  await page.keyboard.press('Control+z');

  await page.getByTestId('save-project').click();
  await page.reload();
  await expect(page.getByTestId('element-count')).toHaveText(countBefore ?? '');
});
