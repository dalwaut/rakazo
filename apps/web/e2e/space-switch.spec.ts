import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("opening a bot in another space switches in place, without a page reload", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `space-switch-${stamp}@rakazo.test`, "password12", "Space Switcher");
  await completeOnboarding(page);
  const otherSpace = await page.request.post("/rpc/spaces/create", {
    data: { json: { name: "Second space" } },
  });
  const { json: space } = (await otherSpace.json()) as { json: { id: string } };
  const created = await page.request.post("/rpc/bots/create", {
    headers: { "x-rakazo-space-id": space.id },
    data: {
      json: {
        name: "Scout",
        title: "",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      },
    },
  });
  expect(created.ok()).toBe(true);
  const { json: scout } = (await created.json()) as { json: { id: string } };
  await page.reload();
  await expect(page.getByRole("button", { name: /Scout/ }).first()).toBeVisible();

  // A reload would drop this marker; an in-place switch keeps it.
  await page.evaluate(() => {
    (window as unknown as { spaceSwitchMarker?: boolean }).spaceSwitchMarker = true;
  });
  await page.getByRole("button", { name: /Scout/ }).first().click();
  await page.waitForURL(`**/app/${scout.id}`);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { spaceSwitchMarker?: boolean }).spaceSwitchMarker,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.localStorage.getItem("rakazo:space-id"))).toBe(space.id);
  await captureScreenshot(page, testInfo, "space-switch-in-place");
});
