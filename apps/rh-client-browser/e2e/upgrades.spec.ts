// Spec weekly-upgrade: Reports and proposals (v1-4 task 3.2).
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "../screenshots");

for (const scheme of ["light", "dark"] as const)
  test(`screenshot of the Upgrades tab (${scheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 860 } });
    await page.goto("#/upgrades");
    await expect(page.locator('[data-test="latest"]')).toContainText("Proposed acme/embed-native");
    await page.screenshot({ path: join(SHOTS, `upgrades-${scheme}.png`), fullPage: true });
    await page.close();
  });

test("the Upgrades tab shows the latest report, approves a proposal, dismisses a suggestion and runs an upgrade", async ({
  page,
}) => {
  await page.goto("#/upgrades");
  await expect(page.getByRole("heading", { name: "Upgrades", exact: true })).toBeVisible();
  await expect(page.locator('[data-test="latest"]')).toContainText("acme/embed-native");
  await expect(page.locator('[data-test="proposals"]')).toContainText("Switch the embedder to acme/embed-native");
  await page.locator('[data-test="suggestions"]').getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator('[data-test="suggestions"]')).toHaveCount(0);
  await page.locator('[data-test="proposals"]').getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".upgrades .notice")).toContainText("re-embedded");
  await expect(page.locator('[data-test="proposals"]')).toHaveCount(0);

  await page.getByText("Run one now").click();
  await page.getByRole("button", { name: "Ranking (which papers become cards)" }).click();
  await expect(page.locator('[data-test="result"]')).toContainText("Nothing changed: not enough data", {
    timeout: 15_000,
  });
});
