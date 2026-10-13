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
  Lifecycle,
  readiness,
  requireThat,
  safeFailure,
  type HealthAttempt,
} from "./policy.ts";

export function register({ run, directory }: ReturnType<typeof loadChildContext>) {
  const lifecycle = new Lifecycle();
  const attempts: HealthAttempt[] = [];
  let cleanupObservations: unknown[] = [];
  let creation: unknown;
  let localPort: number | undefined;
  const persist = () =>
    writeJson(join(directory, "child.json"), {
      stage: run.stage,
      mode: run.mode,
      evidenceLimits,
      setupStarted: lifecycle.setupStarted,
      setupSettled: lifecycle.setupSettled,
      phases: lifecycle.phases,
      attempts,
      cleanupObservations,
      creation,
      localPort,
    });
  persist();
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    profile: "kbpod-dev",
    stage: run.stage,
    dev: run.mode === "local",
    adopt: false,
  });
  const stack = beforeAll(
    Effect.gen(function* () {
      lifecycle.beginSetup();
      persist();
      return yield* deploy(Stack).pipe(
        quietNative,
        Effect.timeout(budgets.deploy),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            lifecycle.settleSetup(
              Exit.isSuccess(exit),
              Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
            );
            persist();
          }),
        ),
        Effect.catchCause(() =>
          Effect.fail(new InfraFailure(lifecycle.phases.deploy.failure?.code ?? "native_failure")),
        ),
      );
    }),
    { timeout: budgets.deployHook },
  );

  afterAll(
    Effect.gen(function* () {
      try {
        lifecycle.cleanupAllowed();
      } catch (error) {
        lifecycle.phases.cleanup = { outcome: "not_attempted", failure: safeFailure(error) };
        persist();
        return yield* Effect.fail(new InfraFailure("provisioning_unsettled"));
      }
      lifecycle.phases.cleanup = { outcome: "running" };
      persist();
      yield* Effect.tryPromise({
        try: async (signal) => {
          const credentials = readCredentials(
            process.env.KBPOD_INFRA_ACCOUNT_ID ?? "",
            process.env.KBPOD_INFRA_STATE_ORIGIN ?? "",
          );
          requireThat(
            digest(credentials.accountId) === run.accountHash &&
              digest(credentials.origin) === run.stateOriginHash,
            "target_mismatch",
          );
          const metadata = new Metadata(
            credentials,
            6,
            AbortSignal.any([signal, AbortSignal.timeout(budgets.cleanupGuard)]),
            (observations) => {
              cleanupObservations = observations;
              persist();
            },
          );
          creation = await metadata.guardCleanup(run, lifecycle.phases.deploy.outcome === "passed");
          persist();
        },
        catch: (error) => new InfraFailure(safeFailure(error).code),
      });
      yield* destroy(Stack).pipe(quietNative, Effect.timeout(budgets.destroy));
    }).pipe(
      Effect.timeout(budgets.cleanup),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (lifecycle.phases.cleanup.outcome !== "not_attempted") {
            lifecycle.phases.cleanup = Exit.isSuccess(exit)
              ? { outcome: "passed" }
              : { outcome: "failed", failure: safeFailure(Cause.squash(exit.cause)) };
          }
          persist();
        }),
      ),
      Effect.catchCause(() =>
        Effect.fail(new InfraFailure(lifecycle.phases.cleanup.failure?.code ?? "cleanup_failed")),
      ),
    ),
    { timeout: budgets.cleanupHook },
  );

  test(
    "native health lifecycle",
    Effect.gen(function* () {
      lifecycle.phases.health = { outcome: "running" };
      persist();
      const { url } = yield* stack;
      requireThat(typeof url === "string", "target_mismatch");
      const target = new URL(url);
      requireThat(
        !target.username &&
          !target.password &&
          !target.search &&
          !target.hash &&
          target.pathname === "/",
        "target_mismatch",
      );
      if (run.mode === "local") {
        requireThat(
          target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname),
          "target_mismatch",
        );
        localPort = Number(target.port || "80");
        persist();
      } else {
        const state = new URL(process.env.KBPOD_INFRA_STATE_ORIGIN ?? "");
        requireThat(
          target.protocol === "https:" &&
            target.hostname.startsWith(`kbpod-server-${run.stage}-`) &&
            target.hostname.endsWith(`.${state.hostname.replace(/^alchemy-state-store\./, "")}`),
          "target_mismatch",
        );
      }
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          readiness(url, signal, {
            record: (attempt) => {
              attempts.push(attempt);
              persist();
            },
          }),
        catch: (error) => new InfraFailure(safeFailure(error).code),
      });
      if (!result.passed) return yield* Effect.fail(new InfraFailure("health_failure"));
    }).pipe(
      Effect.timeout(budgets.health),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          lifecycle.phases.health = Exit.isSuccess(exit)
            ? { outcome: "passed" }
            : { outcome: "failed", failure: safeFailure(Cause.squash(exit.cause)) };
          persist();
        }),
      ),
      Effect.catchCause(() =>
        Effect.fail(new InfraFailure(lifecycle.phases.health.failure?.code ?? "health_failure")),
      ),
    ),
    { timeout: budgets.healthHook },
  );
}
