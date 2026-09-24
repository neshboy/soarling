# SOARling

A lightweight runbook-as-code engine for incident response.

## The problem

When an alert fires at 3am, the diagnostic steps for it usually live in one
of three places: a wiki page nobody has opened since it was written, a
Slack thread from the last incident, or the memory of whoever wrote the
alert rule (who is asleep). The on-call engineer spends the first ten
minutes of the incident re-deriving a procedure someone already wrote down
once. Meanwhile, a new generation of "AI SRE" tooling promises to fix this
by having an assistant look at the alert and just run the fix - which
trades "runbooks nobody reads" for "an LLM executing shell commands against
production during an active incident with no one in the loop." That is not
an acceptable trade.

SOARling takes the middle path:

- Runbooks are **versioned, executable, YAML-defined playbooks** checked
  into version control next to the alert rules they belong to, not prose in
  a wiki.
- Runbooks are **bound to alert-rule identifiers**, so when a specific
  alert fires, `soarling match` resolves the exact runbook for it - no
  hunting.
- An optional AI layer may *suggest* what to run next, but SOARling's
  executor enforces, in code, that **no `shell` step ever runs without an
  explicit human confirmation immediately beforehand.** Suggestion is not
  execution, and the boundary between them is not a documentation
  convention - it's the one thing this project is not allowed to get wrong.

## Install / quick start

```bash
npm install
npm run build
npm link   # or: node dist/cli.js ...
```

Validate a runbook:

```bash
soarling validate examples/runbooks/high-cpu.yaml
```

Run it interactively (every `shell` step pauses for a `y/N` confirmation):

```bash
soarling run examples/runbooks/high-cpu.yaml
```

Resolve which runbook a real Alertmanager webhook payload maps to:

```bash
soarling match examples/alertmanager-payload.json --bindings examples/bindings.yaml
```

Run non-interactively (for scripts/CI/tests) by naming exactly which step
numbers you're pre-authorizing - there is no "confirm everything" flag:

```bash
soarling run examples/runbooks/high-cpu.yaml \
  --non-interactive \
  --yes-to-step 1 --yes-to-step 3 \
  --answer decide-mitigation=monitor-only
```

## The runbook YAML schema

A runbook is a YAML document with this shape (schema version `1`):

```yaml
id: high-cpu-usage       # required, kebab-case, unique to this runbook
version: 1                # required, integer; SOARling currently supports 1
name: "High CPU Usage"    # required, human-readable title
description: "..."          # optional

steps:                       # required, non-empty, ordered list
  - id: check-load            # required, kebab-case, unique within this runbook
    type: shell                 # required: shell | check | manual | decision
    description: "..."            # optional
    command: "uptime"              # required for type: shell - a real shell command
    cwd: "/"                        # optional working directory
    timeoutMs: 5000                  # optional, default 30000
    next: some-step-id                # optional; default is the next step in the list; "end" stops the run

  - id: load-is-high
    type: check
    against: check-load        # required: id of an EARLIER step whose captured output to inspect
    field: stdout                # optional: stdout | stderr | exitCode (default stdout)
    operator: contains             # required: equals | contains | notContains | matches | exitCodeEquals | exitCodeNotEquals
    value: "load average"           # required (string, except numeric for the exitCode operators)
    onTrue: notify-oncall             # optional target if the condition is true (default: next step)
    onFalse: end                       # optional target if the condition is false (default: next step)

  - id: notify-oncall
    type: manual
    instructions: "Page the secondary on-call before proceeding."   # required, no command is ever run

  - id: decide-mitigation
    type: decision
    prompt: "Restart the service?"    # required
    options:                            # required, non-empty
      - label: "yes"
        next: restart-service              # required per option: a step id, or "end"
      - label: "no"
        next: end

  - id: restart-service
    type: shell
    command: "systemctl restart nginx"
```

Rejected runbooks fail with a specific, readable error (never a raw YAML
parser exception or a swallowed `undefined`): malformed YAML, a missing or
invalid `version`, an invalid step `type`, a `check` step referencing a step
that doesn't exist or comes *later* in the file, a `decision` option with no
`next`, duplicate step ids, and so on. Run `soarling validate` to see this
for any runbook before shipping it.

Execution order is the list order, unless a step's `next` (or a `check`'s
`onTrue`/`onFalse`, or a chosen decision option's `next`) points elsewhere.
`end` stops the run.

## Alert binding

SOARling matches the real webhook JSON payload shape that Prometheus
Alertmanager POSTs to a `webhook_config` receiver (`version`, `status`,
`receiver`, `groupLabels`, `commonLabels`, and an `alerts[]` array of
`{status, labels, annotations, startsAt, endsAt, generatorURL,
fingerprint}` - see the [Alertmanager
docs](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config)).
A separate bindings file maps `{alertname, labels}` match criteria to a
runbook path:

```yaml
version: 1
bindings:
  - match:
      alertname: HighCPUUsage
      labels:
        severity: critical
    runbook: runbooks/high-cpu.yaml   # resolved relative to this file

  - match:
      alertname: DiskSpaceLow
    runbook: runbooks/disk-full.yaml
```

`soarling match <payload.json> --bindings <bindings.yaml>` reports, per
alert in the payload, either the resolved runbook path or `NO MATCH`. The
first binding (in file order) whose `alertname` and every listed label
matches wins; put more specific label-qualified bindings first.

## The human-confirmation safety model

This is the actual point of the project, so it's enforced in code, not just
explained here:

- `runShellCommand` (`src/executor/shell.ts`) is the **only** function in
  SOARling allowed to spawn a process.
- It is called from **exactly one place**: the confirmed branch of
  `executeShellStep` in `src/executor/run-runbook.ts`. That function calls
  the caller-supplied `confirmShellStep(step, stepNumber)` first, and only
  proceeds if it resolves to `true`. There is no default, no timeout that
  falls back to "yes," and no "confirm all" flag - the interactive CLI
  prompt defaults an empty/EOF answer to "no," and the scripted
  `--yes-to-step <n>` path only pre-authorizes the *exact* step numbers
  named.
- `check`, `manual`, and `decision` steps never touch a shell. `check`
  reads output SOARling already captured from an earlier, confirmed `shell`
  step; `manual` only prints an instruction; `decision` only asks the human
  to pick a labeled option.
- This is proven by an adversarial test
  (`src/executor/confirmation-gate.test.ts`), not just asserted: it runs a
  real shell step whose command writes a real file to a real temp
  directory, denies confirmation, and asserts the file was never created -
  i.e. the process was never spawned. A companion test spies on
  `runShellCommand` and asserts it was never even called. A positive
  control (confirmation granted) proves the harness isn't just always
  skipping. As a self-check while building this project, the gate in
  `executeShellStep` was deliberately broken (made to run unconditionally)
  and confirmed that this test suite fails loudly when that happens.
- An AI-assistant layer, if one is wired up in front of `soarling run`, sits
  entirely outside this boundary: it may only ever populate what gets shown
  to the human at a `confirmShellStep` prompt (e.g. "here's a plausible next
  command based on this runbook and the last check's output") - it has no
  code path that reaches `runShellCommand` on its own. SOARling ships no
  such layer today; this describes the contract any future one must honor.

## CLI reference

```
soarling validate <runbook.yaml>
soarling match <alertmanager-payload.json> [--bindings <bindings.yaml>]
soarling run <runbook.yaml> [--non-interactive] [--yes-to-step <n>]... [--answer <stepId>=<label>]...
```

## Limitations

- Single-host, single-process execution: `shell` steps run wherever the
  `soarling` CLI itself runs. There is no built-in remote-execution,
  fleet-targeting, or privilege-broker layer - wrap `soarling run` in your
  own SSH/exec tooling if you need that, and keep the confirmation prompt on
  the human's own terminal.
- No runbook-execution audit log/persistence yet; a run's output goes to
  stdout only. Pipe it somewhere durable if you need a record.
- No cycle detection: a runbook whose `next`/`onTrue`/`onFalse`/decision
  targets form a loop will run forever. This is deliberate (retry loops are
  a legitimate pattern), but there's no step-count safety valve yet.
- Alert matching supports only exact label equality, not label regexes or
  Alertmanager's own routing-tree semantics; it complements Alertmanager's
  routing, it doesn't replace it.
- No AI-suggestion layer is implemented in this repository. The safety
  contract above is enforced structurally (there is exactly one call site
  for `runShellCommand`) so that if one is added later, it cannot bypass the
  confirmation gate without a deliberate, reviewable code change to
  `run-runbook.ts` itself.
- Windows shell steps run via `cmd.exe` (through `child_process.spawn` with
  `shell: true`); commands that rely on POSIX-only shell syntax will not be
  portable across platforms unless authored that way deliberately.

## License

MIT - see [LICENSE](./LICENSE).
