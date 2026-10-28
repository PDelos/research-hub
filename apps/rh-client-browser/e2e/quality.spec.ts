// Spec harness: Quality view (v1-2 task 4.2).
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "../screenshots");

test("the Quality tab shows the judge, the cards over time and a replay with its verdict", async ({ page }) => {
  await page.goto("#/quality");
  await expect(page.getByRole("heading", { name: "Quality", exact: true })).toBeVisible();
  await expect(page.locator('[data-test="judge"]')).toContainText("Agrees with you");
  await page.getByText("Try a setting").click();
  await page.getByLabel("Setting to replay").fill('{ "cardsPerSweep": 9 }');
  await page.getByRole("button", { name: "Replay" }).click();
  await expect(page.locator('[data-test="replays"] li').first()).toContainText("cardsPerSweep 9");
  await expect(page.locator('[data-test="replays"] li').first()).toContainText("not enough data");
  await page.getByLabel("Setting to replay").fill('{ "cardsPerSweep": 40 }');
  await page.getByRole("button", { name: "Replay" }).click();
  await expect(page.locator(".quality .error")).toContainText("cardsPerSweep: must be an integer from 1 to 15");
});

for (const scheme of ["light", "dark"] as const)
  test(`screenshot of the Quality tab (${scheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 860 } });
    await page.goto("#/quality");
    await expect(page.locator('[data-test="replays"]')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `quality-${scheme}.png`), fullPage: true });
    await page.close();
  });
