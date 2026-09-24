/**
 * Types for alert-to-runbook binding.
 *
 * SOARling matches against the real webhook JSON payload shape that
 * Prometheus Alertmanager POSTs to a `webhook_config` receiver, documented
 * at https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
 * (the shape is stable and versioned via the top-level "version" field).
 */

export type AlertStatus = "firing" | "resolved";

export interface AlertmanagerAlert {
  status: AlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
  fingerprint?: string;
}

export interface AlertmanagerPayload {
  version: string;
  groupKey: string;
  status: AlertStatus;
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL: string;
  alerts: AlertmanagerAlert[];
}

/**
 * One entry in a bindings file: matches alerts by `alertname` and,
 * optionally, an exact-match subset of labels, and points at a runbook
 * file (a path, resolved relative to the bindings file's own directory).
 */
export interface BindingRule {
  match: {
    alertname: string;
    labels?: Record<string, string>;
  };
  runbook: string;
}

export interface BindingsConfig {
  version: 1;
  bindings: BindingRule[];
}

export interface AlertMatchResult {
  alert: AlertmanagerAlert;
  binding: BindingRule | null;
  /** Absolute path to the matched runbook file, resolved against the bindings file location. */
  runbookPath: string | null;
}
