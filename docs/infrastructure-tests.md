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

Both targets create/delete a fresh application stage and may access remote shared state/auth. **All prior operation claims are consumed; neither command is authorized now.** Do not run a target just because the code changed.

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
4. Registers `beforeAll(deploy(Stack))`, a health assertion, and `afterAll(destroy(Stack))`. Bun hook timeouts are300 seconds for setup and180 seconds for teardown; the health test is75 seconds.
5. Validates the returned URL's basic target shape and calls the shared health helper directly.

The health helper allows at most six GETs, each with a10-second request/body deadline and no redirects. Only404,500–599 or200 HTML trigger propagation retries, with0.5,1,2,3,3-second delays. The first200 JSON response matching the exact one-field shared schema succeeds; there is no extra success request. Failures retain fixed reason/status/media/transport categories, not raw response bodies or exception causes. Unit tests supply fetch functions directly.

## What a result means

A passing integration run means Bun completed the native hooks and the health assertion. **SDK teardown success is not an independent inventory/removal audit.** Unit tests do not emulate native scheduling or demonstrate cleanup after synthetic deployment failures.

The SDK owns authentication, provider operations and finalization. No application test code parses profile files, refreshes OAuth, checks account inventories, records operator claims or launches a supervised child. The old tests of those deleted mechanisms and of the deleted CLI are intentionally removed.

Native fallback closes host scopes/sidecars; it does not itself guarantee remote resource deletion. Hook timeouts, interruption, failed credentials or provider deletion errors can leave resources or processes. There is no universal deadline/cessation guarantee and no independent detached-process check. Stop and report the generated stage and safe failure category; investigate or clean up only under separately scoped authorization. Never sweep stages or delete shared infrastructure. Do not automatically retry the integration suite after a failure.

`DO_NOT_TRACK=1` plus supported scoped Effect log/tracer controls reduce telemetry. They are not a universal output sanitizer: native initialization/errors and sidecars can still emit output, and raw SDK files may remain under ignored `.alchemy/`. Never inspect, copy, attach or commit those raw logs. Native state auth can use an edge preview and update its named cache; local mode is not an offline boundary. Shared-state bootstrap/upgrade/repair needs separate approval.

## Historical evidence is separate

The older bounded supervisor and exact-stage incident recovery are retained in Git history, not reusable project code. Their original ignored receipts remain unchanged under `.hub/` and `.alchemy/health-tests/`.

Actual recovery `47b423e95ecb`, replacement local `609d2ed5da29` and live `065d144b6679` passed at **`fbfd9cefd1a137bf50f5a55253d13f844c5985cb`**, including then-authorized independent removal/inventory checks. Original local `22bfea207d84` remains a failed run. All claims are consumed.

Neither the later formatted commit `976e0f5` nor this simplified runner inherits that exact runtime proof. **The simplified integration suite has not been executed.** Current validation is offline/unit/typecheck only; no new independent review was authorized. Original NOT READY review and D-7/D-8 qualifications remain historical, not a new clean review. See the dated record in `docs/progress.md`.
