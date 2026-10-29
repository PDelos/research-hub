// Spec engineer: Ideas and assessment (v1-8 task 3.1), offline: the engineer's model calls are the faux rules.
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "../screenshots");

test("ideas are researched and assessed; Ask the engineer turns a suggestion into an idea; Reject ends it", async ({
  page,
}) => {
  await page.goto("#/upgrades");
  const engineer = page.locator('[data-test="engineer"]');
  await page.getByLabel("An idea for the engineer").fill("Make the interface purple");
  await page.getByRole("button", { name: "Propose" }).click();
  await expect(engineer.locator("li", { hasText: "Make the interface purple" })).toContainText(
    "cannot build this yet",
    {
      timeout: 15_000,
    },
  );

  await page.locator('[data-test="suggestions"]').getByRole("button", { name: "Ask the engineer" }).first().click();
  const asked = engineer.locator("li", { hasText: "Add bioRxiv API" });
  await expect(asked).toContainText("waiting for you", { timeout: 15_000 });
  await expect(asked).toContainText("paper source");
  await expect(asked.getByRole("button", { name: "Build" })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "engineer-light.png"), fullPage: true });
  await asked.getByRole("button", { name: "Reject" }).click();
  await expect(asked).toContainText("rejected");
});
