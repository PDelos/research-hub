// Spec full-text: Full-text API (v1-6 task 3.1): the Library shows a paper's full text and its source.
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const SHOTS = join(import.meta.dirname, "../screenshots");

test("the Library shows a paper's full text with its source and sections", async ({ page }) => {
  await page.goto("#/library");
  await page.getByText("RNA-FM: an RNA foundation model").click();
  const section = page.locator('[data-test="fulltext"]');
  await expect(section).toContainText("From arXiv HTML · 2 sections");
  await section.getByText("Methods").click();
  await expect(section).toContainText("We pretrain on 23 million sequences.");
  await expect(section.getByRole("button", { name: "Get again" })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "fulltext-light.png") });
});
