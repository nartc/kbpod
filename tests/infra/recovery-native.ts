import * as Test from "alchemy/Test/Bun";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { join } from "node:path";
import Stack from "../../alchemy.run.ts";
import { evidenceLimits, quietNative } from "./controls.ts";
import { digest, type loadChildContext, writeJson } from "./files.ts";
import { Metadata, readCredentials } from "./metadata.ts";
import {
  budgets,
  InfraFailure,
  normalizeFailure,
  requireThat,
  safeFailure,
  type PhaseResult,
} from "./policy.ts";

// One D8 cleanup-only native lifecycle. No deploy or health implementation is imported/called here.
export function registerRecovery({ run, directory }: ReturnType<typeof loadChildContext>) {
  requireThat(
    run.recoveryFrom === "22bfea207d84" &&
      run.mode === "local" &&
      run.stage === "e2e-local-22bfea207d84",
    "target_mismatch",
  );
  const phases: Record<"inspection" | "deploy" | "health" | "cleanup", PhaseResult> = {
    inspection: { outcome: "not_started" },
    deploy: { outcome: "not_attempted" },
    health: { outcome: "not_attempted" },
    cleanup: { outcome: "not_started" },
  };
  let inspectionObservations: unknown[] = [];
  let cleanupObservations: unknown[] = [];
  let inspection: Awaited<ReturnType<Metadata["inspectRecovery"]>> | undefined;
  let destroyCalls = 0;
  const persist = () =>
    writeJson(join(directory, "child.json"), {
      stage: run.stage,
      mode: run.mode,
      recoveryFrom: run.recoveryFrom,
      phases,
      inspectionObservations,
      cleanupObservations,
      inspection,
      destroyCalls,
      attempts: [],
      localPort: 1337,
      evidenceLimits,
    });
  const credentials = () => {
    const value = readCredentials(
      process.env.KBPOD_INFRA_ACCOUNT_ID ?? "",
      process.env.KBPOD_INFRA_STATE_ORIGIN ?? "",
    );
    requireThat(
      digest(value.accountId) === run.accountHash && digest(value.origin) === run.stateOriginHash,
      "target_mismatch",
    );
    return value;
  };
  const { beforeAll, afterAll, test, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    profile: "kbpod-dev",
    stage: run.stage,
    dev: true,
    adopt: false,
  });
  persist();
  const gate = beforeAll(
    Effect.tryPromise({
      try: async (signal) => {
        phases.inspection = { outcome: "running" };
        persist();
        requireThat(
          run.inspectionDeadline !== undefined && run.inspectionDeadline > Date.now(),
          "timeout",
        );
        const metadata = new Metadata(
          credentials(),
          7,
          AbortSignal.any([signal, AbortSignal.timeout(run.inspectionDeadline - Date.now())]),
          (rows) => {
            inspectionObservations = rows;
            persist();
          },
        );
        inspection = await metadata.inspectRecovery(run);
        return inspection;
      },
      catch: normalizeFailure,
    }).pipe(
      Effect.timeout(budgets.preflight),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          phases.inspection = Exit.isSuccess(exit)
            ? { outcome: "passed" }
            : { outcome: "failed", failure: safeFailure(Cause.squash(exit.cause)) };
          persist();
        }),
      ),
    ),
    { timeout: budgets.preflight + 10_000 },
  );
  test(
    "authorized exact-stage cleanup-only gate",
    Effect.gen(function* () {
      yield* gate;
      requireThat(
        phases.inspection.outcome === "passed" && inspection !== undefined,
        "unexpected_resource",
      );
    }),
  );
  afterAll(
    Effect.gen(function* () {
      if (phases.inspection.outcome !== "passed" || inspection === undefined) {
        phases.cleanup = { outcome: "not_attempted" };
        persist();
        return yield* Effect.fail(new InfraFailure("cleanup_failed"));
      }
      phases.cleanup = { outcome: "running" };
      persist();
      if (!inspection.absent) {
        yield* Effect.tryPromise({
          try: async (signal) => {
            const metadata = new Metadata(
              credentials(),
              3,
              AbortSignal.any([signal, AbortSignal.timeout(budgets.cleanupGuard)]),
              (rows) => {
                cleanupObservations = rows;
                persist();
              },
            );
            const ownership = await metadata.guardCleanup(run, true);
            requireThat(
              ownership.created === true && ownership.local === true,
              "unexpected_resource",
            );
          },
          catch: normalizeFailure,
        });
        requireThat(destroyCalls === 0);
        destroyCalls++;
        persist();
        yield* destroy(Stack).pipe(quietNative, Effect.timeout(budgets.destroy));
      }
    }).pipe(
      Effect.timeout(budgets.cleanup),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (phases.cleanup.outcome !== "not_attempted")
            phases.cleanup = Exit.isSuccess(exit)
              ? { outcome: "passed" }
              : { outcome: "failed", failure: safeFailure(Cause.squash(exit.cause)) };
          persist();
        }),
      ),
      Effect.catchCause((cause) => Effect.fail(normalizeFailure(Cause.squash(cause)))),
    ),
    { timeout: budgets.cleanupHook },
  );
}
