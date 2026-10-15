/**
 * Frozen acceptance for the web UI: what the harness enforces on every patch.
 * Expected values were recorded on the Python 2 build. Agents may not edit
 * these files (deny rule + scope hook), and the harness checks their hashes.
 *
 * These are deliberately NOT the hidden scoreboard: the hidden suite uses
 * other inputs and its expected outputs never leave the judge's machine.
 */
import { expect, test } from "@playwright/test";

test("search is accent-insensitive and matches line texts", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search").fill("physio");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".summary")).toHaveText("5 invoices, page 1 of 1");
  await expect(page.locator(".invoices tr").first()).toContainText("Spital Thun");
});

test("second page of all invoices, sorted by customer", async ({ page }) => {
  await page.goto("/?q=&page=2");
  await expect(page.locator(".summary")).toHaveText("24 invoices, page 2 of 3");
  await expect(page.locator(".invoices tr")).toHaveCount(10);
  await expect(page.locator(".invoices tr").first()).toContainText("Ölz & Partner");
  await expect(page.locator(".pages strong")).toHaveText("2");
});

test("invoice shows fractional hours and the early-payment discount", async ({ page }) => {
  await page.goto("/invoice/INV-2026-014");
  await expect(page.locator("h1")).toHaveText("INV-2026-014");
  await expect(page.locator(".lines td").nth(1)).toHaveText("13.5");
  await expect(page.locator(".totals")).toHaveText("Net CHF 1'945.89, VAT CHF 157.61, total CHF 2'103.50");
  await expect(page.locator(".skonto")).toHaveText("3% early-payment discount: CHF 63.11");
});

test("customer page lists tags and outstanding amounts", async ({ page }) => {
  await page.goto("/customer/C06");
  await expect(page.locator("h1")).toHaveText("Ölz & Partner");
  await expect(page.locator(".tags")).toHaveText("Région Zürich, Stammkunde");
  await expect(page.locator(".invoices li")).toHaveCount(4);
});

test("ledger download keeps the accounting format", async ({ request }) => {
  const res = await request.get("/ledger.csv");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("text/csv; charset=windows-1252");
  const body = await res.body();
  expect(body.subarray(0, 45).toString("latin1")).toBe("customer;account;invoice;date;net;total;vat\r\n");
  expect(body.includes(Buffer.from("M\xfcller Holzbau AG;1100;INV-2025-101", "latin1"))).toBe(true);
});
