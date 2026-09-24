import { dirname, isAbsolute, resolve } from "node:path";
import type { AlertmanagerAlert, AlertmanagerPayload, AlertMatchResult, BindingRule, BindingsConfig } from "./types.js";

/**
 * True if every key/value pair in `required` is present and equal in
 * `actual`. An empty/absent `required` set matches everything (the binding
 * only cares about alertname in that case).
 */
function labelsMatch(actual: Record<string, string>, required: Record<string, string> | undefined): boolean {
  if (!required) return true;
  return Object.entries(required).every(([key, value]) => actual[key] === value);
}

/** Finds the first binding rule (in file order) whose match criteria are satisfied by this alert. */
export function findBindingForAlert(alert: AlertmanagerAlert, bindings: readonly BindingRule[]): BindingRule | null {
  for (const binding of bindings) {
    if (alert.labels.alertname !== binding.match.alertname) continue;
    if (!labelsMatch(alert.labels, binding.match.labels)) continue;
    return binding;
  }
  return null;
}

/**
 * Resolves every alert in a payload to a runbook path (or null if no
 * binding matches), given the bindings file's own path so relative
 * `runbook:` paths in the bindings file resolve the same way regardless of
 * the caller's current working directory.
 */
export function matchAlerts(payload: AlertmanagerPayload, bindingsConfig: BindingsConfig, bindingsFilePath: string): AlertMatchResult[] {
  const baseDir = dirname(resolve(bindingsFilePath));
  return payload.alerts.map((alert) => {
    const binding = findBindingForAlert(alert, bindingsConfig.bindings);
    if (!binding) return { alert, binding: null, runbookPath: null };
    const runbookPath = isAbsolute(binding.runbook) ? binding.runbook : resolve(baseDir, binding.runbook);
    return { alert, binding, runbookPath };
  });
}
