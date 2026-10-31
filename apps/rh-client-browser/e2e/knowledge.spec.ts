// Spec knowledge-loop: Approve, reject, undo (v1-5 task 3.2).
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Checks the full profile (every tab in the bar, the advanced features); core.spec.ts covers the core profile.
test.skip(process.env.RH_PROFILE === "core", "a full-profile view");

const SHOTS = join(import.meta.dirname, "../screenshots");

for (const scheme of ["light", "dark"] as const)
  test(`screenshot of the digest's charter proposals (${scheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 860 } });
    await page.goto("#/digest");
    const section = page.locator('[data-section="charter"]');
    await expect(section).toContainText("Do protein language models transfer to RNA?");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `knowledge-${scheme}.png`) });
    await page.close();
  });

test("a proposal is approved from the digest into a new charter version, undone from the Charter tab, and one is rejected", async ({
  page,
}) => {
  await page.goto("#/digest");
  const section = page.locator('[data-section="charter"]');
  const add = section.locator('[data-proposal="add-question"]');
  await expect(add).toContainText("promise 80%");
  await expect(add).toContainText("same method, different problem");
  await add.getByRole("button", { name: "Approve" }).click();
  await expect(add).toContainText("approved");
  await expect(add).toContainText("charter v2");

  const oos = section.locator('[data-proposal="add-out-of-scope"]');
  await oos.getByRole("button", { name: "Reject" }).click();
  await oos.getByLabel("Why not (optional)").fill("I want them");
  await oos.getByRole("button", { name: "Reject" }).click();
  await expect(oos).toContainText("Your reason: I want them");

  await page.goto("#/charter");
  await expect(page.locator(".questions-list")).toContainText("Q4 Do protein language models transfer to RNA?");
  const proposals = page.locator('[data-test="charter-proposals"]');
  await proposals.locator('[data-proposal="add-question"]').getByRole("button", { name: "Undo" }).click();
  await expect(proposals.locator('[data-proposal="add-question"]')).toContainText("undone");
  await expect(page.locator(".questions-list")).not.toContainText("transfer to RNA");
  const finders = page.locator('[data-test="finders"]');
  await expect(finders).toContainText("Same method, different problem");
  await expect(finders.locator("tr", { hasText: "Same method, different problem" })).toContainText("1");
});
