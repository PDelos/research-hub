// Spec plugin-system: Declarative contributions (Tab follows the plugin), Extension points (Swap the viewer), Plugins
// view, Install and uninstall (task 4.3; 3.2 for the plugin's own tab), in a real browser against an offline hub.
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIXTURES = join(import.meta.dirname, "../../rh-server/tests/fixtures/plugins");
const SHOTS = join(import.meta.dirname, "../../../openspec/changes/v1-0-plugin-core/trial");

test.describe.configure({ mode: "serial" });

const tabs = (page: Page) => page.getByRole("tablist").getByRole("tab");
const openPlugin = async (page: Page, id: string) => {
  await page.goto("#/plugins");
  await page.locator(`tr[data-plugin="${id}"]`).click();
  await expect(page.locator(".plugin-details h3")).toContainText(id);
};

test("the tab bar comes from the plugins, and a plugin's own tab renders as a custom element", async ({ page }) => {
  await page.goto("#/feed");
  await expect(tabs(page)).toHaveText([
    "Feed",
    "Library",
    "Knowledge base",
    "Reading list",
    "Charter",
    "Runs",
    "Settings",
    "Plugins",
  ]);
  await tabs(page).filter({ hasText: "Reading list" }).click();
  await expect(page).toHaveURL(/#\/reading-list$/);
  // Inside the plugin's shadow root (Playwright locators pierce it).
  await expect(page.locator("acme-reading-list h2")).toHaveText("Reading list plugin");
  await expect(page.locator("acme-reading-list #status")).toHaveText(
    /No papers in the knowledge base yet|papers in the knowledge base/,
  );
});

test("disabling a plugin removes its tab within 2 seconds, and enabling brings it back", async ({ page }) => {
  await openPlugin(page, "acme.reading-list");
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(tabs(page).filter({ hasText: "Reading list" })).toHaveCount(0, { timeout: 2_000 });
  await expect(page.locator(".plugin-details .state")).toHaveText("disabled");
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(tabs(page).filter({ hasText: "Reading list" })).toHaveCount(1, { timeout: 2_000 });
});

test("required plugins cannot be disabled; an old link to a missing tab falls back to the first tab", async ({
  page,
}) => {
  await openPlugin(page, "rh.kb");
  await expect(page.getByText("The hub needs this plugin")).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable" })).toHaveCount(0);
  await page.goto("#/no-such-tab");
  await expect(page).toHaveURL(/#\/feed$/);
});

test("switching the knowledge-base viewer to Library and back", async ({ page }) => {
  await openPlugin(page, "rh.kb");
  const viewer = page.locator(".plugin-details .plugin-settings select");
  await viewer.selectOption("library");
  await page.locator(".plugin-details").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".plugin-details .plugin-settings")).toContainText("Saved.");
  await tabs(page).filter({ hasText: "Knowledge base" }).click();
  await expect(page.locator(".library")).toBeVisible();
  await expect(page.locator(".kb-tab")).toHaveCount(0);

  await openPlugin(page, "rh.kb");
  await page.locator(".plugin-details .plugin-settings select").selectOption("obsidian");
  await page.locator(".plugin-details").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".plugin-details .plugin-settings")).toContainText("Saved.");
  await tabs(page).filter({ hasText: "Knowledge base" }).click();
  await expect(page.locator(".kb-tab")).toBeVisible();
});

test("installing shows what the plugin asks for; approve, then uninstall", async ({ page }) => {
  await page.goto("#/plugins");
  await page.getByRole("button", { name: "Install a plugin" }).click();
  await page.getByLabel("Source").selectOption("folder");
  await page.getByLabel("Plugin location").fill(join(FIXTURES, "acme.sample"));
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator(".plan")).toContainText("Network: export.arxiv.org");
  await expect(page.locator(".plan")).toContainText("Chat tools: sample_echo");
  await expect(page.locator(".plan")).toContainText("papers.source: sample");
  await page.getByRole("button", { name: "Approve and install" }).click();
  await expect(page.locator('tr[data-plugin="acme.sample"] .state')).toHaveText("active");
  await expect(page.locator(".plugin-details .history")).toContainText("install acme.sample 0.1.0");

  await page.getByRole("button", { name: "Uninstall" }).click();
  await expect(page.locator('tr[data-plugin="acme.sample"]')).toHaveCount(0);
  await expect(page.locator(".plugins > .history")).toContainText("uninstall acme.sample");
});

test("an invalid plugin is refused with its problems", async ({ page }) => {
  await page.goto("#/plugins");
  await page.getByRole("button", { name: "Install a plugin" }).click();
  await page.getByLabel("Source").selectOption("folder");
  await page.getByLabel("Plugin location").fill(join(FIXTURES, "acme.unversioned"));
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator(".plugins > ul.error")).toContainText("engines.research-hub: required");
});

for (const scheme of ["light", "dark"] as const)
  test(`screenshots of the Plugins tab (${scheme})`, async ({ browser }) => {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 860 } });
    await openPlugin(page, "rh.kb");
    await page.screenshot({ path: join(SHOTS, `plugins-${scheme}.png`) });
    await page.goto("#/reading-list");
    await expect(page.locator("acme-reading-list h2")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `plugin-tab-${scheme}.png`) });
    await page.close();
  });
