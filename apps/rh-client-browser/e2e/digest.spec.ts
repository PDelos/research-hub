// Spec daily-cycle: Weekly digest, Comments on the digest, What changed with undo, Cycle status (task 5.3).
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Checks the full profile (every tab in the bar, the advanced features); core.spec.ts covers the core profile.
test.skip(process.env.RH_PROFILE === "core", "a full-profile view");

const SHOTS = join(import.meta.dirname, "../screenshots");

test.describe.configure({ mode: "serial" });

test("the digest shows the week, the cycle status and the change with its undo", async ({ page }) => {
  await page.goto("#/digest");
  await expect(page.getByRole("heading", { name: "Weekly digest" })).toBeVisible();
  await expect(page.locator('[data-test="cycle-status"]')).toContainText("next sweep");
  for (const title of [
    "The week's cycle",
    "Your judgments",
    "Exploration picks",
    "Knowledge base",
    "Cost",
    "What changed",
  ])
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator('[data-change="configure rh.sweep: cardsPerSweep"]')).toBeVisible();
});

test("a comment is saved under its section", async ({ page }) => {
  await page.goto("#/digest");
  const section = page.locator('[data-section="judgments"]');
  await section.getByLabel("Comment on Your judgments").fill("more methods papers, fewer reviews");
  await section.getByRole("button", { name: "Comment" }).click();
  await expect(section.locator(".comments")).toContainText("more methods papers, fewer reviews");
});

test("undo from the digest reverses that change and says so", async ({ page }) => {
  await page.goto("#/digest");
  const change = page.locator('[data-change="configure rh.sweep: cardsPerSweep"]');
  await change.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone: configure rh.sweep: cardsPerSweep")).toBeVisible();
  await expect(change).toContainText("undone");
  await page.goto("#/plugins");
  await expect(page.locator(".plugins > .history")).toContainText("undo: configure rh.sweep: cardsPerSweep");
});

for (const scheme of ["light", "dark"] as const)
  test(`screenshots of the Digest tab (${scheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    await page.goto("#/digest");
    await expect(page.getByRole("heading", { name: "What changed" })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `digest-${scheme}.png`), fullPage: true });
    await page.goto("#/feed");
    await expect(page.locator('[data-test="cycle-status"]')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `feed-cycle-${scheme}.png`) });
    await page.close();
  });
