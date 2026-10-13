import { describe, it, expect } from "vitest";
import { findStaleQueueItems } from "../src/queue-stale.js";

const item = (queue_id: string, record_id: string, category: string, entity = "staff") =>
  ({ queue_id, record_id, category, entity });

const staff = [
  { staff_id: "a", active: true,  trade: "electrical", emergency_contact_name: "",  email: "a@x.au" },
  { staff_id: "b", active: false, trade: "",           emergency_contact_name: "",  email: "" },
  { staff_id: "c", active: true,  trade: "",           emergency_contact_name: "Z", email: "" },
  { staff_id: "d", active: true,  trade: "" },
];

describe("findStaleQueueItems", () => {
  it("flags filled, inactive and missing records", () => {
    const v = findStaleQueueItems(
      [item("1", "a", "trade"), item("2", "b", "trade"), item("3", "gone", "duplicate"), item("4", "c", "emergency_contact")],
      staff,
    );
    expect(v.map((x) => x.queue_id)).toEqual(["1", "2", "3", "4"]);
  });

  it("keeps items that are still open", () => {
    expect(findStaleQueueItems([item("1", "c", "trade"), item("2", "a", "emergency_contact")], staff)).toEqual([]);
  });

  it("does not treat an absent PII key as filled or blank", () => {
    expect(findStaleQueueItems([item("1", "d", "emergency_contact"), item("2", "d", "email")], staff)).toEqual([]);
  });

  it("ignores non-staff entities", () => {
    expect(findStaleQueueItems([item("1", "x", "duplicate", "contacts")], staff)).toEqual([]);
  });
});
