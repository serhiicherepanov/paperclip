import { describe, expect, it } from "vitest";
import { parseIssueTypeSlug } from "../services/issue-duplicate-slug-signal.js";

describe("parseIssueTypeSlug", () => {
  it("extracts the type prefix and slug from a scoped title", () => {
    expect(parseIssueTypeSlug("Implement: issue-create-duplicate-slug-signal — soft signal on create")).toEqual({
      typePrefix: "Implement",
      slug: "issue-create-duplicate-slug-signal",
    });
  });

  it("stops the slug at a trailing hyphen used as a dash separator", () => {
    expect(parseIssueTypeSlug("Implement: right-size-target-a - stand up the target stack")).toEqual({
      typePrefix: "Implement",
      slug: "right-size-target-a",
    });
  });

  it("accepts a multi-word type prefix", () => {
    expect(parseIssueTypeSlug("UI pass: ui-widget-order-parity")).toEqual({
      typePrefix: "UI pass",
      slug: "ui-widget-order-parity",
    });
  });

  it("returns null when there is no colon-delimited prefix", () => {
    expect(parseIssueTypeSlug("Fix the catalog listing order parity bug")).toBeNull();
  });

  it("returns null for a Cyrillic pseudo-slug", () => {
    expect(parseIssueTypeSlug("Implement: исправить-заказ — fix order parity")).toBeNull();
  });

  it("returns null for a single-segment slug", () => {
    expect(parseIssueTypeSlug("Board: catalog")).toBeNull();
  });

  it("returns null for an empty or missing title", () => {
    expect(parseIssueTypeSlug("")).toBeNull();
    expect(parseIssueTypeSlug(null)).toBeNull();
    expect(parseIssueTypeSlug(undefined)).toBeNull();
  });
});
