# Unit and integration tests

There are **unit tests and one integration suite**. Local emulation and Cloudflare are targets of the same integration suite, not three suites or a required per-commit matrix. Bun is the runner; Alchemy owns provisioning and teardown. There is no custom test supervisor, smoke CLI or `scripts/` directory.

## Unit tests

```sh
bun test
# Equivalent package alias:
bun run test:unit
```

`bunfig.toml` sets the discovery root to `tests/unit`. These tests exercise the real Effect HttpApi Layer, exact health assertions, safe diagnostics, bounded readiness and small explicit configuration inputs. They do not import the stack or Alchemy runtime, read credentials or make network calls. No module mocks, loader interception or global patches are used.

## Integration: choose a target only when needed and authorized

Both targets create/delete a fresh application stage and may access remote shared state/auth. **Prior operator operation claims are consumed; neither manual command is authorized now.** Do not run a target just because the code changed. The separately approved automatic trusted-PR CI scope is described below.

After separate scoped authorization, the direct commands are:

```sh
DO_NOT_TRACK=1 KBPOD_TEST_TARGET=local bun test ./tests/integration/health.test.ts
# Or choose the cloud target of that SAME suite:
DO_NOT_TRACK=1 KBPOD_TEST_TARGET=cloud bun test ./tests/integration/health.test.ts
```

The package alias `KBPOD_TEST_TARGET=local bun run test:integration` (or `cloud`) sets DNT and invokes that same Bun command, not another runner. An isolated offline Bun1.4.2 sentinel prototype verified that bare discovery uses the unit root while the explicit file path selects integration.

The test file:

1. Requires an explicit target and DNT; rejects `ALCHEMY_TEST_DEV` rather than silently overriding the target.
2. Generates a fresh `it-<target>-<random>` stage inside the file. There is no caller-supplied stage, reuse, recovery selector, adoption or dev/prod default.
3. Creates `Test.make` with `Cloudflare.providers()`, `Cloudflare.state()`, profile `kbpod-dev`, and the chosen local-provider flag.
4. Registers native `beforeAll(deploy(Stack))`, a health assertion, and `afterAll` calling native destroy after deployment has settled, whether successfully or with failure. One in-memory flag refuses destroy if deployment has not settled. Bun hook timeouts are300 seconds for setup and180 seconds for teardown; the health test is75 seconds.
5. Validates the returned URL's basic target shape and calls the shared health helper directly.
6. Optionally appends bounded stage/phase diagnostics to an absolute `KBPOD_INTEGRATION_REPORT` path. Report-sink errors never change lifecycle results or prevent cleanup; CI independently requires complete evidence.

The health helper allows at most six GETs, each with a10-second request/body deadline and no redirects. Only404,500–599 or200 HTML trigger propagation retries, with0.5,1,2,3,3-second delays. The first200 JSON response matching the exact one-field shared schema succeeds; there is no extra success request. Failures retain fixed reason/status/media/transport categories, not raw response bodies or exception causes. Unit tests supply fetch functions directly.

## What a result means

A passing integration run means Bun completed the native hooks and the health assertion. **SDK teardown success is not an independent inventory/removal audit.** Unit tests do not emulate native scheduling or demonstrate cleanup after synthetic deployment failures.

The SDK owns authentication, provider operations and finalization. No application test code parses profile files, refreshes OAuth, checks account inventories, records operator claims or launches a supervised child. The old tests of those deleted mechanisms and of the deleted CLI are intentionally removed.

Native fallback closes host scopes/sidecars; it does not itself guarantee remote resource deletion. Hook timeouts, interruption, failed credentials or provider deletion errors can leave resources or processes. There is no universal deadline/cessation guarantee and no independent detached-process check. Stop and report the generated stage and safe failure category; investigate or clean up only under separately scoped authorization. Never sweep stages or delete shared infrastructure. Do not automatically retry the integration suite after a failure.

`DO_NOT_TRACK=1` plus supported scoped Effect log/tracer controls reduce telemetry. They are not a universal output sanitizer: native initialization/errors and sidecars can still emit output, and raw SDK files may remain under ignored `.alchemy/`. Never inspect, copy, attach or commit those raw logs. Native state auth can use an edge preview and update its named cache; local mode is not an offline boundary. Shared-state bootstrap/upgrade/repair needs separate approval.

## Automatic trusted-PR CI

Chau approved this recurring scope on2026-10-14. The workflow is implemented locally; **its first actual GitHub Actions/native cloud result is still unverified**. Publishing remains separately authorized. No operator cloud command follows from this approval.

### Required checks and trust

Require **both `Offline checks` and `Cloud integration`** in the repository ruleset. Offline runs frozen install, format, lint, all three typechecks and unit tests on the PR merge commit. Cloud runs only after offline succeeds. If offline fails, cloud is skipped; the required offline failure is what blocks merge. Chau configures the ruleset himself.

The cloud job first rejects forks, non-human PR authors and bot original/triggering actors. A trusted PR has its head in this repository, a `User` author, and no actor ending in `[bot]`. Rejection is a failed step before checkout, not a green skipped cloud check. A maintainer can review and promote vetted changes to a same-repository human PR. Labels and rerunning a fork do not expose the token.

Repository writers already have access to repository secrets through workflow edits. The trust gate is not a sandbox against writers. Actions use full upstream commit pins and checkout does not retain Git credentials. There is no `pull_request_target`, privileged follow-on workflow, artifact handoff, cache, path filter or draft bypass.

### Authentication and state boundary

The native step alone receives `CLOUDFLARE_API_TOKEN`; its Account ID is intentionally in YAML. Missing token fails without printing it. Proposed permissions are account-scoped Workers Scripts Edit and Secrets Store Read. Their sufficiency is **not proven** by secret presence or installed source. A first-run permission denial requires diagnosis and approval, not silent permission expansion.

Each job uses a fresh hosted runner; the cloud job uses a new `ALCHEMY_HOME` under the runner temp directory. Paths are initialized through step-level `env` and `GITHUB_ENV`; `runner` is not valid in job-level `env`. Before native SDK import, an existence-only guard rejects pre-existing or symlinked project `.alchemy`, Alchemy home or report paths. Nothing restores or reads local profile contents.

In beta81, environment credentials override the named profile. Existing-state auth lists Secrets Store metadata and uploads a temporary preview to retrieve the existing state secret. CI does not write the state-auth cache. No local bootstrap state means the automatic-resume branch has nothing to resume. With `CI=true` and `updateStateStore:false`, missing/outdated shared state fails; native noninteractive prompts reject the remaining confirmation path. This is a pinned-source/trusted-code boundary, not a token-level prohibition on shared mutations. Do not bootstrap, upgrade, repair or delete shared state to make CI pass.

### Safe evidence and failure handling

Native stdout/stderr goes to `/dev/null` from process launch. The workflow never reads raw SDK logs. The test writes a separate small report containing only generated stage, fixed phase/outcome/failure categories and the existing safe health diagnostic. The evidence step reads at most8193 bytes and rejects missing, oversized, non-ASCII, unterminated, malformed or symlinked reports without printing offending content. Only a valid closed-grammar report enters the job summary.

A green cloud check requires native exit0 and the exact ordered deploy/health/destroy started/passed markers. Safe but incomplete failure reports remain visible and red. `auth_or_state` covers the SDK's shared AuthError tag; it is not a precise permissions diagnosis. Unknown errors are not expanded. The report is optional for separately authorized manual runs and contains no Worker URL, secret, response body, arbitrary error tag/message or stack.

Bun's hook timeout does not wire interruption into Alchemy's promise. The unsettled-deploy guard prevents deliberately starting native destroy while that deployment has not settled. Settled failure still invokes destroy. A missing deploy-start marker can also mean runtime initialization failed before deploy began, or reporting failed; it is not proof that no remote activity occurred. There is no new runner, deadline controller or cleanup process.

Cloud jobs serialize through one global concurrency group with automatic cancellation disabled. New pending runs may replace older pending runs before they start. The20-minute job timeout, manual cancellation or runner loss can still kill work before teardown. GitHub can send SIGTERM7.5 seconds after SIGINT and kill2.5 seconds later. The always-run evidence step may itself never run after runner loss. Native teardown success is **not independent removal evidence**.

On failure or suspected leakage, use only the safe stage/phase evidence, stop intentional reruns and request separately scoped investigation/cleanup. No automatic suite retry, second destroy, inventory sweep or raw-log inspection is included. Later PR events remain automatic; this workflow is not a persistent incident circuit breaker. No local/cloud matrix is required.

### Verification limits

Bun1.4.2 YAML parsing, actual gate/validator shell fixtures, real Effect observer/guard tests and the offline checks pass. Unit tests use explicit inputs and sinks, never replace SDK modules or globals. They do not prove GitHub context evaluation, Bun native hook scheduling, token permissions, actual provisioning or cleanup. Independent source review caught and corrected invalid job-level runner context before publication. Record the first authorized real CI run's merge SHA, run/check link and safe stage/results before calling CI operational; do not inherit historical native success.

## Historical evidence is separate

The older bounded supervisor and exact-stage incident recovery are retained in Git history, not reusable project code. Their original ignored receipts remain unchanged under `.hub/` and `.alchemy/health-tests/`.

Actual recovery `47b423e95ecb`, replacement local `609d2ed5da29` and live `065d144b6679` passed at **`fbfd9cefd1a137bf50f5a55253d13f844c5985cb`**, including then-authorized independent removal/inventory checks. Original local `22bfea207d84` remains a failed run. All claims are consumed.

Neither the later formatted commit `976e0f5` nor this simplified runner inherits that exact runtime proof. **The current native integration suite has not been executed.** Current CI validation is offline/unit/typecheck and independent source review only. That review does not retroactively change the original NOT READY review or D-7/D-8 qualifications. See the dated record in `docs/progress.md`.
