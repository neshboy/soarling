import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAlertmanagerPayload } from "./payload.js";
import { parseBindings } from "./bindings.js";
import { matchAlerts, findBindingForAlert } from "./matcher.js";

const BINDINGS_YAML = `
version: 1
bindings:
  - match:
      alertname: HighCPUUsage
      labels:
        severity: critical
    runbook: runbooks/high-cpu.yaml
  - match:
      alertname: HighCPUUsage
    runbook: runbooks/high-cpu-generic.yaml
  - match:
      alertname: DiskSpaceLow
    runbook: runbooks/disk-full.yaml
`;

function alertPayload(alerts: unknown[]): string {
  return JSON.stringify({
    version: "4",
    status: "firing",
    receiver: "x",
    alerts,
  });
}

describe("alert-to-runbook matching", () => {
  it("matches an alert against the most specific (first, in file order) binding whose labels are a subset match", () => {
    const payload = parseAlertmanagerPayload(
      alertPayload([{ status: "firing", labels: { alertname: "HighCPUUsage", severity: "critical", instance: "a" } }])
    );
    const bindings = parseBindings(BINDINGS_YAML);
    const [result] = matchAlerts(payload, bindings, "C:/fake/bindings.yaml");
    expect(result.binding?.runbook).toBe("runbooks/high-cpu.yaml");
    expect(result.runbookPath).toBe(resolve("C:/fake", "runbooks/high-cpu.yaml"));
  });

  it("falls through to a less specific binding when labels don't match the more specific one", () => {
    const payload = parseAlertmanagerPayload(
      alertPayload([{ status: "firing", labels: { alertname: "HighCPUUsage", severity: "warning" } }])
    );
    const bindings = parseBindings(BINDINGS_YAML);
    const [result] = matchAlerts(payload, bindings, "C:/fake/bindings.yaml");
    expect(result.binding?.runbook).toBe("runbooks/high-cpu-generic.yaml");
  });

  it("matches purely on alertname when a binding has no labels constraint", () => {
    const payload = parseAlertmanagerPayload(alertPayload([{ status: "firing", labels: { alertname: "DiskSpaceLow" } }]));
    const bindings = parseBindings(BINDINGS_YAML);
    const [result] = matchAlerts(payload, bindings, "C:/fake/bindings.yaml");
    expect(result.binding?.runbook).toBe("runbooks/disk-full.yaml");
  });

  it("returns null binding and null runbookPath for an alertname with no binding", () => {
    const payload = parseAlertmanagerPayload(alertPayload([{ status: "firing", labels: { alertname: "TotallyUnbound" } }]));
    const bindings = parseBindings(BINDINGS_YAML);
    const [result] = matchAlerts(payload, bindings, "C:/fake/bindings.yaml");
    expect(result.binding).toBeNull();
    expect(result.runbookPath).toBeNull();
  });

  it("resolves multiple alerts in one payload independently", () => {
    const payload = parseAlertmanagerPayload(
      alertPayload([
        { status: "firing", labels: { alertname: "DiskSpaceLow" } },
        { status: "firing", labels: { alertname: "TotallyUnbound" } },
      ])
    );
    const bindings = parseBindings(BINDINGS_YAML);
    const results = matchAlerts(payload, bindings, "C:/fake/bindings.yaml");
    expect(results).toHaveLength(2);
    expect(results[0].runbookPath).not.toBeNull();
    expect(results[1].runbookPath).toBeNull();
  });

  it("findBindingForAlert requires an exact match on every required label, not just alertname", () => {
    const bindings = parseBindings(BINDINGS_YAML).bindings;
    const alert = { status: "firing" as const, labels: { alertname: "HighCPUUsage", severity: "critical" }, annotations: {}, startsAt: "", endsAt: "", generatorURL: "" };
    expect(findBindingForAlert(alert, bindings)?.runbook).toBe("runbooks/high-cpu.yaml");

    const alertMissingLabel = { ...alert, labels: { alertname: "HighCPUUsage" } };
    expect(findBindingForAlert(alertMissingLabel, bindings)?.runbook).toBe("runbooks/high-cpu-generic.yaml");
  });
});
