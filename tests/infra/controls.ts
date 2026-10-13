import * as Effect from "effect/Effect";
import * as References from "effect/References";

// Supported SDK controls, not a global log/filesystem/network interceptor.
export function nativeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...env, DO_NOT_TRACK: "1" };
}
export const quietNative = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
        Effect.provideService(References.MinimumLogLevel, "None"),
        Effect.withTracerEnabled(false),
    );
export const evidenceLimits = {
    sdkTelemetry: "disabled_via_DO_NOT_TRACK",
    sdkLocalLogs: "may_remain_ignored_not_inspected",
    nativeStateAuthPreview: "permitted_same_account_existing_secret",
    previewExpiry: "not_attested",
    detachedDescendants: "not_independently_attested",
} as const;
