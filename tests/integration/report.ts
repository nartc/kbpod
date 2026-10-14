import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { formatHealthFailure } from "../health-check.ts";

type Phase = "deploy" | "health" | "destroy";
type FailureCategory = "auth_or_state" | "state" | "unknown";

// Compare known tags, never serialize a tag, message, stack or nested cause.
const failureCategory = (cause: Cause.Cause<unknown>): FailureCategory => {
    try {
        const error: unknown = Cause.squash(cause);
        if (typeof error === "object" && error !== null && "_tag" in error) {
            const { _tag: tag } = error;
            if (tag === "AuthError") return "auth_or_state";
            if (tag === "StateStoreError") return "state";
        }
    } catch {
        // Even malformed error getters must not escape into the report.
    }
    return "unknown";
};

// A sink only observes. Its failure cannot mask an exit or prevent native teardown.
export function integrationReport(stage: string, append: (line: string) => void) {
    if (!/^it-(local|cloud)-[a-f0-9]{12}$/.test(stage)) {
        throw new Error("Invalid integration report stage.");
    }
    const write = (line: string) => {
        try {
            append(`${line}\n`);
        } catch {
            // CI separately requires a complete report; lifecycle work must continue.
        }
    };
    write(`stage=${stage}`);

    return {
        observe:
            (phase: Phase) =>
            <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
                Effect.sync(() => write(`phase=${phase}:started`)).pipe(
                    Effect.andThen(effect),
                    Effect.onExit((exit) =>
                        Effect.sync(() => {
                            if (Exit.isSuccess(exit)) {
                                write(`phase=${phase}:passed`);
                            } else if (Cause.hasInterruptsOnly(exit.cause)) {
                                write(`phase=${phase}:interrupted`);
                            } else {
                                write(`phase=${phase}:failed`);
                                write(`failure=${failureCategory(exit.cause)}`);
                            }
                        }),
                    ),
                ),
        healthFailure: (error: unknown) => Effect.sync(() => write(formatHealthFailure(error))),
        unsettled: () => Effect.sync(() => write("destroy=blocked_unsettled_deploy")),
    };
}

// One flag, not a runner: native hooks still own execution and finalization.
// False also covers native runtime initialization failing before deploy starts.
export function deploymentSettlement() {
    let settled = false;
    return {
        track: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
            effect.pipe(
                Effect.onExit(() =>
                    Effect.sync(() => {
                        settled = true;
                    }),
                ),
            ),
        cleanup: <A, E, R>(
            effect: Effect.Effect<A, E, R>,
            onUnsettled: Effect.Effect<void>,
        ): Effect.Effect<A, E | Error, R> =>
            Effect.suspend((): Effect.Effect<A, E | Error, R> =>
                settled
                    ? effect
                    : onUnsettled.pipe(
                          Effect.andThen(
                              Effect.fail(
                                  new Error("Integration deploy not settled; destroy not started."),
                              ),
                          ),
                      ),
            ),
    };
}
