// Spec feature-profiles: the core profile in the browser (v2-0 tasks 4.1–4.3, 5.3). Runs only with RH_PROFILE=core.
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "../screenshots");

test.skip(process.env.RH_PROFILE !== "core", "the core profile only");

test("the tab bar has only Feed, Library, Charter and Settings; the rest is under the hood and opens by URL", async ({
  page,
}) => {
  await page.goto("#/feed");
  await expect(page.getByRole("tab")).toHaveText(["Feed", "Library", "Charter", "Settings"]);
  await page.getByRole("tab", { name: "Settings" }).click();
  const hood = page.locator(".under-the-hood");
  await expect(hood.getByRole("heading", { name: "Under the hood" })).toBeVisible();
  for (const id of ["runs", "digest", "plugins"]) await expect(hood.locator(`[data-tab="${id}"]`)).toBeVisible();
  await hood.locator('[data-tab="digest"]').click();
  await expect(page).toHaveURL(/#\/digest$/);
  await expect(page.locator(".digest-section").first()).toBeVisible();
  // The tab bar stays the same on a page that is under the hood.
  await expect(page.getByRole("tab")).toHaveCount(4);
});

test("Advanced features: switching the harness on brings its Quality view without a restart, and off again", async ({
  page,
}) => {
  await page.goto("#/settings");
  const harness = page.locator('.advanced li[data-plugin="rh.harness"] input[type="checkbox"]');
  await expect(page.locator(".advanced li")).toHaveCount(9);
  await expect(harness).not.toBeChecked();
  await harness.check();
  await expect(page.locator('.under-the-hood [data-tab="quality"]')).toBeVisible();
  await page.locator('.under-the-hood [data-tab="quality"]').click();
  await expect(page.getByRole("heading", { name: "Quality", exact: true })).toBeVisible();
  await page.goto("#/settings");
  await page.locator('.advanced li[data-plugin="rh.harness"] input[type="checkbox"]').uncheck();
  await expect(page.locator('.under-the-hood [data-tab="quality"]')).toHaveCount(0);
});

test("a feature that needs another offers to switch both on", async ({ page }) => {
  await page.goto("#/settings");
  const upgrades = page.locator('.advanced li[data-plugin="rh.upgrades"]');
  await upgrades.locator('input[type="checkbox"]').check();
  await expect(upgrades).toContainText("Needs");
  await upgrades.getByRole("button", { name: "Turn on both" }).click();
  await expect(upgrades.locator(".needs")).toHaveCount(0);
  await expect(page.locator('.under-the-hood [data-tab="upgrades"]')).toBeVisible();
  // Back to the plain core state for the other tests.
  await upgrades.locator('input[type="checkbox"]').uncheck();
  await page.locator('.advanced li[data-plugin="rh.harness"] input[type="checkbox"]').uncheck();
  await expect(page.locator('.under-the-hood [data-tab="upgrades"]')).toHaveCount(0);
});

test("the Charter has no Proposals section and the Digest only sections with something in them, without errors", async ({
  page,
}) => {
  await page.goto("#/charter");
  await expect(page.getByRole("heading", { name: /Charter/ }).first()).toBeVisible();
  await expect(page.locator('[data-test="charter-proposals"]')).toHaveCount(0);
  await page.goto("#/digest");
  await expect(page.locator(".digest-section").first()).toBeVisible();
  for (const empty of ["quality", "sources", "upgrade", "charter", "exploration"])
    await expect(page.locator(`[data-section="${empty}"]`)).toHaveCount(0);
  await expect(page.locator('[data-section="changes"]')).toBeVisible();
  await expect(page.locator("p.error, .notice.error")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const)
  for (const view of ["feed", "settings"] as const)
    test(`screenshot of the core ${view} (${scheme})`, async ({ browser }) => {
      const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 860 } });
      await page.goto(`#/${view}`);
      await expect(page.getByRole("tab")).toHaveCount(4);
      // The left pane scrolls by itself: bring the new Settings sections into view.
      if (view === "settings") {
        await expect(page.locator(".advanced li")).toHaveCount(9);
        await page.locator(".advanced").scrollIntoViewIfNeeded();
      }
      await page.screenshot({ path: join(SHOTS, `core-${view}-${scheme}.png`), fullPage: true });
      await page.close();
    });
