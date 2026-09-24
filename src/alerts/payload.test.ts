import { describe, expect, it } from "vitest";
import { parseAlertmanagerPayload } from "./payload.js";
import { AlertConfigError } from "./errors.js";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "4",
    groupKey: "{}:{alertname=\"HighCPUUsage\"}",
    status: "firing",
    receiver: "soarling-webhook",
    groupLabels: { alertname: "HighCPUUsage" },
    commonLabels: { alertname: "HighCPUUsage", severity: "critical" },
    commonAnnotations: {},
    externalURL: "http://alertmanager.internal:9093",
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCPUUsage", severity: "critical", instance: "web-03:9100" },
        annotations: { summary: "high cpu" },
        startsAt: "2026-09-24T18:02:00Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://prometheus.internal:9090/graph",
        fingerprint: "abc123",
      },
    ],
    ...overrides,
  });
}

describe("parseAlertmanagerPayload - valid payloads", () => {
  it("parses a real Alertmanager webhook payload shape", () => {
    const parsed = parseAlertmanagerPayload(payload());
    expect(parsed.status).toBe("firing");
    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alerts[0].labels.alertname).toBe("HighCPUUsage");
    expect(parsed.alerts[0].labels.severity).toBe("critical");
  });

  it("defaults optional string-map fields to empty objects when absent", () => {
    const minimal = JSON.stringify({
      version: "4",
      status: "firing",
      receiver: "x",
      alerts: [{ status: "firing", labels: { alertname: "A" } }],
    });
    const parsed = parseAlertmanagerPayload(minimal);
    expect(parsed.groupLabels).toEqual({});
    expect(parsed.commonAnnotations).toEqual({});
    expect(parsed.alerts[0].annotations).toEqual({});
  });
});

describe("parseAlertmanagerPayload - invalid payloads (distinct shapes)", () => {
  it("rejects malformed JSON", () => {
    try {
      parseAlertmanagerPayload("{not json");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AlertConfigError);
      expect((err as AlertConfigError).code).toBe("malformed-json");
    }
  });

  it("rejects a top-level array", () => {
    expect(() => parseAlertmanagerPayload("[]")).toThrow(/must be a JSON object/);
  });

  it("rejects a missing version field", () => {
    const bad = JSON.stringify({ status: "firing", receiver: "x", alerts: [{ status: "firing", labels: { alertname: "A" } }] });
    expect(() => parseAlertmanagerPayload(bad)).toThrow(/required string "version"/);
  });

  it("rejects an invalid top-level status", () => {
    const bad = payload({ status: "exploding" });
    expect(() => parseAlertmanagerPayload(bad)).toThrow(/invalid top-level "status"/);
  });

  it("rejects an empty alerts list", () => {
    const bad = payload({ alerts: [] });
    expect(() => parseAlertmanagerPayload(bad)).toThrow(/non-empty "alerts" list/);
  });

  it("rejects an alert missing labels.alertname", () => {
    const bad = payload({ alerts: [{ status: "firing", labels: { severity: "critical" } }] });
    expect(() => parseAlertmanagerPayload(bad)).toThrow(/labels\.alertname/);
  });

  it("rejects an alert whose labels value is not a string", () => {
    const bad = payload({ alerts: [{ status: "firing", labels: { alertname: "A", count: 5 } }] });
    expect(() => parseAlertmanagerPayload(bad)).toThrow(/must be a string/);
  });
});
