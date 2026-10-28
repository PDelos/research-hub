// Spec slots and plugin-system: the grouped Plugins tab (v1-3 task 4.1).
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "../screenshots");

test("the Plugins tab groups slots, add-ons, preferences and a collapsed core", async ({ page }) => {
  await page.goto("#/plugins");
  const slots = page.locator('[data-group="slots"]');
  await expect(slots.locator('[data-slot="embedder"]')).toContainText("Preset: SCIDOCS, LitSearch, your stars");
  await expect(slots.locator('[data-slot="kb-search"]')).toContainText("Preset: planned");
  await expect(slots.locator('[data-slot="kb-search"]').getByRole("button", { name: "Run benchmark" })).toBeDisabled();
  await expect(page.locator('[data-group="addons"]')).toContainText("arXiv");
  await expect(page.locator('[data-group="preferences"]')).toContainText("Obsidian viewer");
  const core = page.locator('details[data-group="core"]');
  await expect(core).not.toHaveAttribute("open", "");
  await expect(core.locator("summary")).toContainText("cannot be changed");

  // Turning an add-on off and on from its row.
  const row = page.locator('[data-group="addons"] li[data-plugin="rh.source-europepmc"]');
  await row.getByRole("button", { name: "Turn off" }).click();
  await expect(row.locator(".state")).toHaveText("disabled");
  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(row.locator(".state")).not.toHaveText("disabled");

  // A benchmark from the slot card (offline, no cached sample: it says why).
  const facets = slots.locator('[data-slot="facets"]');
  await facets.getByRole("button", { name: "Run benchmark" }).click();
  await expect(facets).toContainText("last: no result");
});

for (const scheme of ["light", "dark"] as const)
  test(`screenshot of the grouped Plugins tab (${scheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 1000 } });
    await page.goto("#/plugins");
    await expect(page.locator('[data-slot="embedder"]')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `plugins-grouped-${scheme}.png`), fullPage: true });
    await page.close();
  });
