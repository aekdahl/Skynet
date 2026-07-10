import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

// ─── SPA smoke ─────────────────────────────────────────────────────────────
// The FIRST automated UI coverage for the web app. It is deliberately a smoke:
// it asserts the shell mounts, the primary nav is present, a couple of views
// render when navigated to, and — importantly — that nothing threw in the
// browser during load or navigation. It does NOT assert pixels, copy, or exact
// layout, so ordinary product changes won't make it flap.
//
// Selectors lean on role/accessible-name and visible text so they survive
// styling and DOM-structure churn.

const NAV = ["Home", "Inbox", "Audit", "Projects", "Fleet", "Settings"] as const;

// Nav buttons render an icon glyph before the label (e.g. "⌂ Home"), so the
// accessible name is "<glyph> <label>", not the bare label. Match the label as
// a trailing word — resilient to the decorative glyph and to spacing — instead
// of an exact-name match.
const navButton = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`\\b${label}$`) });

// A fresh in-memory workspace shows the first-run onboarding wizard (App gates
// on it when the workspace is empty). Seed the per-token "onboarded" marker
// before the app boots so nav is reachable. The dev token is `dev-cyberdyne`
// (see apps/web/src/lib/client.ts), so firstrun.ts reads
// `skynet.onboarded.dev-cyberdyne`.
async function seedOnboarded(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("skynet.onboarded.dev-cyberdyne", "1");
    } catch {
      /* ignore */
    }
  });
}

// Belt-and-braces: if onboarding still renders (e.g. the marker key changes),
// click its "Skip setup" affordance so the shell becomes reachable. No-op when
// onboarding isn't shown.
async function dismissOnboardingIfPresent(page: Page) {
  const skip = page.getByRole("button", { name: /skip setup|get started|skip/i });
  if (await skip.count()) {
    await skip.first().click().catch(() => {});
  }
}

// Collect anything that would indicate the app blew up in the browser. We treat
// console.error and uncaught page errors as failures; warnings/logs are ignored
// (they're noisy and not smoke-worthy).
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err: Error) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

async function navTo(page: Page, label: string) {
  await navButton(page, label).first().click();
}

test.describe("SPA smoke", () => {
  test("app shell loads with the primary nav", async ({ page }) => {
    const errors = collectErrors(page);
    await seedOnboarded(page);

    await page.goto("/");
    await dismissOnboardingIfPresent(page);

    // App shell mounted: the document title is set and the root has content.
    await expect(page).toHaveTitle(/Skynet/i);
    await expect(page.locator("#root")).not.toBeEmpty();

    // Primary navigation is present. Each item is a nav button labelled by text.
    for (const label of NAV) {
      await expect(navButton(page, label).first()).toBeVisible();
    }

    expect(errors, `Unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("navigating to Audit and Inbox renders without throwing", async ({ page }) => {
    const errors = collectErrors(page);
    await seedOnboarded(page);

    await page.goto("/");
    await dismissOnboardingIfPresent(page);

    // Wait for the shell to be interactive before navigating.
    await expect(navButton(page, "Audit").first()).toBeVisible();

    await navTo(page, "Audit");
    // The view swapped in — the shell (nav) is still mounted and the root has
    // content. We don't assert on view-specific copy so this stays resilient.
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(navButton(page, "Home").first()).toBeVisible();

    await navTo(page, "Inbox");
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(navButton(page, "Home").first()).toBeVisible();

    // Return Home to confirm round-trip navigation is stable.
    await navTo(page, "Home");
    await expect(page.locator("#root")).not.toBeEmpty();

    expect(errors, `Unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
