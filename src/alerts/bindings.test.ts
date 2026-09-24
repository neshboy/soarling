import { describe, expect, it } from "vitest";
import { parseBindings } from "./bindings.js";
import { AlertConfigError } from "./errors.js";

const VALID_BINDINGS = `
version: 1
bindings:
  - match:
      alertname: HighCPUUsage
      labels:
        severity: critical
    runbook: runbooks/high-cpu.yaml
  - match:
      alertname: DiskSpaceLow
    runbook: runbooks/disk-full.yaml
`;

describe("parseBindings - valid", () => {
  it("parses alertname+labels match rules and a bare alertname rule", () => {
    const config = parseBindings(VALID_BINDINGS);
    expect(config.bindings).toHaveLength(2);
    expect(config.bindings[0].match).toEqual({ alertname: "HighCPUUsage", labels: { severity: "critical" } });
    expect(config.bindings[1].match.labels).toBeUndefined();
  });
});

describe("parseBindings - invalid (distinct shapes)", () => {
  it("rejects malformed YAML", () => {
    try {
      parseBindings(":\n  - not: [valid");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AlertConfigError);
      expect((err as AlertConfigError).code).toBe("malformed-yaml");
    }
  });

  it("rejects an unsupported version", () => {
    const bad = "version: 2\nbindings:\n  - match: { alertname: A }\n    runbook: r.yaml\n";
    expect(() => parseBindings(bad)).toThrow(/only supports version 1/);
  });

  it("rejects a missing bindings list", () => {
    expect(() => parseBindings("version: 1\n")).toThrow(/non-empty "bindings" list/);
  });

  it("rejects a binding with no match.alertname", () => {
    const bad = "version: 1\nbindings:\n  - match: {}\n    runbook: r.yaml\n";
    expect(() => parseBindings(bad)).toThrow(/match\.alertname/);
  });

  it("rejects a binding with a non-string label value", () => {
    const bad = "version: 1\nbindings:\n  - match: { alertname: A, labels: { severity: 5 } }\n    runbook: r.yaml\n";
    expect(() => parseBindings(bad)).toThrow(/match\.labels\.severity/);
  });

  it("rejects a binding with no runbook path", () => {
    const bad = "version: 1\nbindings:\n  - match: { alertname: A }\n";
    expect(() => parseBindings(bad)).toThrow(/required non-empty "runbook" path/);
  });
});
