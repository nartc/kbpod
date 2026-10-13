# Native health lifecycle tests

`bun test` is offline. It skips infrastructure discovery without importing Alchemy/the stack. The opt-in commands use beta81's native `Test.make`, `beforeAll(deploy(Stack))` and `afterAll(destroy(Stack))`; they are not shell wrappers around CLI deployment. `scripts/infra.ts` only supervises the native test process, enforces the whole-run deadline and verifies metadata after exit.

## Run only with scoped approval

These commands create and delete infrastructure/state. Their presence is not standing permission to run them. D-6, amended by approved D-7, permits at most one local run followed by one live run after successful local health, owned-resource cleanup and removal verification under the evidence limits below. Any later use needs its own authority. Do not recreate `dev`, use `prod`, or reuse another run's stage.

Supply the approved account ID and existing shared-state origin through **private process environment**, not committed configuration or command output:

- `KBPOD_INFRA_APPROVED_COMMIT`: the approved tested snapshot's full SHA (review findings and later parent-verified changes are recorded separately). The checkout must match and be clean before any profile refresh or cloud request.
- `KBPOD_INFRA_ACCOUNT_ID`: expected account, compared with both `kbpod-dev` profile/cache and the account API.
- `KBPOD_INFRA_STATE_ORIGIN`: expected existing HTTPS state Worker origin, compared with the private cache.
- For live only, `KBPOD_INFRA_LOCAL_RUN`: the prior successful local run's 12-hex ID. Its commit, account, origin and executable source hashes must match.

```sh
bun run test:infra:local
# Only after its health + cleanup + removal verification pass:
bun run test:infra:live
```

Use a private environment-setting launcher rather than putting credentials in these commands. Tokens are read only from the existing named profile/cache, never accepted from ambient Cloudflare variables. Reject `ALCHEMY_*`/`CLOUDFLARE_*` overrides and dotenv files (except `.env.example`); in particular `ALCHEMY_TEST_DEV="0"` is not a safe boolean override. The child validates its parent PID, nonce, fresh stage, source hashes and environment before importing Alchemy.

Each invocation exclusively reserves `.alchemy/health-tests/<12hex>/`, then checks that `kbpod/e2e-local-<12hex>` or `kbpod/e2e-live-<12hex>` is absent. There is no adoption. Only the existing health `Server` is allowed. Five generated `plain_text` runtime metadata bindings are expected—not extra infrastructure: `ALCHEMY_PHASE`, `ALCHEMY_WORKER_NAME`, `ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`, `ALCHEMY_CLOUDFLARE_ACCOUNT_ID`. Custom, secret or data-resource bindings fail the cleanup ownership guard. An empty binding array is allowed only for a failed-setup `creating` placeholder after the same resource/account/stage/immutable-tag ownership checks; completed deployment still requires all five.

## Bounds and failure behavior

- Preflight: 60 seconds, six metadata GETs. Necessary own OAuth refresh is allowed once; the remaining credential lifetime must cover the run. beta81's registration-only Cloudflare auth layer is not publicly exported, so the helper uses its pinned installed declaration/source without building providers/state or falling back to browser login.
- Deploy: one native invocation, 300-second Effect deadline inside a 330-second Bun hook.
- Health: at most six GETs, 10 seconds each including body, no redirects. Retry only404,500–599, or200 HTML; delays are0.5,1,2,3,3 seconds. Total75 seconds inside a90-second Bun test. All other failures stop readiness immediately. The first exact200 JSON/shared-schema/one-field pass is the assertion—no extra final request. The ordinary smoke CLI remains one-shot.
- Cleanup: registered before execution, including after a settled setup failure/partial creation or failed assertion. Ownership guard30 seconds, then one native destroy180 seconds, within210 seconds total and a240-second Bun hook. If provisioning remains unsettled, **do not race it with destroy**. An error is a failed run, never an invitation to retry or sweep stages.
- Explicit metadata across preflight, cleanup guard and postchecks is capped at16 GETs per mode, each10 seconds without redirects/retries/pages. Native provider polling and approved state-auth recovery are separate and remain bounded by the operation deadlines; their exact per-mode request counts are not independently measured.
- Whole execution:15 minutes, then owned-process-group SIGINT/20 seconds, SIGTERM/5 seconds, SIGKILL if necessary/5 seconds to reap. Final read-only verification gets up to30 seconds within a16-minute overall budget. Captured stdout/stderr is drained and discarded, not copied into reports or receipts. This operational supervisor envelope does not guarantee that every detached process or in-flight remote request has ceased.

Effect timeout requests interruption; it cannot guarantee that remote requests or uninterruptible finalizers have stopped. The native adapter's fallback closes host scope/sidecar, **not cloud resources**. SIGKILL, machine loss, lost credentials or failed deletion can leave resources. Preserve the owned stage and safe outcomes for a separately authorized recovery; never run a broad cleanup command.

## Supported native behavior (D-7)

Before SDK auth initialization and in the native child environment, `DO_NOT_TRACK=1` disables Alchemy's default OTLP logs/metrics/traces exporters. Wrapped deploy/destroy and explicit OAuth-refresh effects also use supported `References.MinimumLogLevel = "None"` and `Effect.withTracerEnabled(false)`. These scoped controls do not promise universal silence during runtime-layer initialization or in sidecars. No global hooks, preloads, request/filesystem/spawn interception or SDK patches are used.

Native Stack evaluation may still append ordinary logs under ignored `.alchemy/`. **Do not inspect, copy, attach or commit those raw logs.** Safe harness reports are not proof that every SDK log is redacted or protected by an OS sandbox. The state-auth preview helper logs a full non-200 response body and includes a prefix in its error; its inspected success path does not log the returned secret.

If cached state authentication fails after preflight, native recovery may create an edge-preview session, optionally exchange its token, and upload preview code on the existing `alchemy-state-store` route in the same approved account. It reads fixed existing secret `AlchemyStateStoreToken` through one temporary `SECRET` binding and may update the named profile's credential cache. The SDK selects the first returned Secrets Store; this is not an independent store audit. Its helper permits up to15 retries after the first attempt, within native phase deadlines. Exact preview expiry and explicit preview deletion are not attested. This does not authorize live shared-state publication, bootstrap, upgrade, repair, secret rotation or teardown. Keep version/bootstrap-residue preflight, default `updateStateStore=false` and noninteractive prompts.

The native adapter closes host scope after destroy and has fallback sidecar closure; the sidecar has its own process group, a native kill finalizer and parent-disconnect shutdown. Some closure errors are ignored. The supervisor proves only its **observed test group** and known health listener are absent; detached descendants remain **not independently attested**, even on a passing run. Any observed survivor, timeout, unsafe ownership or failed cleanup/removal still fails and prevents the live run. There is no sweep authority.

## Evidence

Ignored run artifacts contain:
- `run.json`: exclusively reserved stage/mode, target/nonce digests, source hashes and unrelated-inventory baselines; no credentials.
- `child.json`: separate deploy/health/cleanup outcomes, bounded health observations and source-validated creation/ownership evidence. Failures use safe categories or the existing smoke formatter, never raw exception/body/header/binding values.
- `receipt.json`: native process exit, `observedTestGroupStopped`, local listener check and final stage/Worker-removal metadata. `evidenceLimits` explicitly records the SDK-log, preview-expiry and detached-descendant limitations; a returned adapter path is not universal host-cleanup proof. A health pass alone is not overall success; cleanup/verification failure makes the command nonzero.

Passing postchecks prove that the owned stage is absent with zero resources, its live Worker is absent (none was created for local mode), unrelated Worker/stage-name inventories match, and shared state Worker/version7 remains functional. Shared DOs, Secrets Store and keys are not individually inventoried; this is not an exhaustive shared-data audit.

Offline tests exercise guards, request budgets, safe diagnostics and our native-hook boundary with injected operations, including setup/assertion/cleanup failure and unsettled provisioning. These fixtures are not cloud verification. Actual local/live outcomes and tested commit identity belong in `docs/progress.md` after the authorized runs.
