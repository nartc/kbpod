import * as Schema from "effect/Schema";
import { runSmoke } from "../../scripts/smoke.ts";

export const Mode = Schema.Literals(["local", "live"]);
export type Mode = typeof Mode.Type;
export const budgets = {
    deploy: 300_000,
    deployHook: 330_000,
    health: 75_000,
    healthHook: 90_000,
    destroy: 180_000,
    cleanupGuard: 30_000,
    cleanup: 210_000,
    cleanupHook: 240_000,
    preflight: 60_000,
    verification: 30_000,
    execution: 900_000,
    overall: 960_000,
    metadataRequest: 10_000,
    metadataCount: 16,
    healthCount: 6,
} as const;
export const retryDelays = [500, 1_000, 2_000, 3_000, 3_000] as const;
export const generatedNames = [
    "ALCHEMY_PHASE",
    "ALCHEMY_WORKER_NAME",
    "ALCHEMY_STACK_NAME",
    "ALCHEMY_STAGE",
    "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
] as const;
export const Codes = Schema.Literals([
    "invalid_configuration",
    "target_mismatch",
    "stage_collision",
    "inventory_changed",
    "metadata_http",
    "metadata_shape",
    "metadata_budget",
    "metadata_transport",
    "unexpected_resource",
    "unexpected_binding",
    "auth_failure",
    "state_failure",
    "native_failure",
    "timeout",
    "provisioning_unsettled",
    "health_failure",
    "cleanup_failed",
    "verification_failed",
    "process_failed",
    "output_limit",
]);
export type Code = typeof Codes.Type;
export const MetadataField = Schema.Literals([
    "response",
    "envelope",
    "envelope.success",
    "shared_version",
    "account",
    "workers",
    "worker",
    "worker.id",
    "workers.result_info",
    "workers.total_count",
    "stages",
    "resources",
    "replaced",
    "resource",
    "resource.bindings",
    "resource.props",
    "resource.attr",
    "resource.attr.durableObjectNamespaces",
    "settings",
]);
export type MetadataField = typeof MetadataField.Type;
export const ObservedShape = Schema.Literals([
    "missing",
    "null",
    "array",
    "object",
    "string",
    "number",
    "boolean",
    "other",
    "invalid_json",
    "oversized",
]);
export const ShapeDetail = Schema.Struct({ field: MetadataField, shape: ObservedShape });
export type ShapeDetail = typeof ShapeDetail.Type;
export const observedShape = (value: unknown): typeof ObservedShape.Type => {
    if (value === undefined) return "missing";
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    switch (typeof value) {
        case "object":
            return "object";
        case "string":
            return "string";
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        default:
            return "other";
    }
};
export function requireShape(value: unknown, field: MetadataField, valid: boolean): asserts valid {
    if (!valid)
        throw new InfraFailure("metadata_shape", undefined, { field, shape: observedShape(value) });
}
export function decodeField<A>(
    decode: (value: unknown) => A,
    value: unknown,
    field: MetadataField,
): A {
    try {
        return decode(value);
    } catch {
        throw new InfraFailure("metadata_shape", undefined, { field, shape: observedShape(value) });
    }
}
export class InfraFailure extends Error {
    constructor(
        readonly code: Code,
        readonly status?: number,
        readonly detail?: ShapeDetail,
    ) {
        super(code);
        this.name = "InfraFailure";
    }
}
export function requireThat(value: unknown, code: Code = "invalid_configuration"): asserts value {
    if (!value) throw new InfraFailure(code);
}
export const safeFailure = (
    error: unknown,
): { code: Code; status?: number; detail?: ShapeDetail } => {
    if (error instanceof InfraFailure)
        return {
            code: Schema.is(Codes)(error.code) ? error.code : "native_failure",
            ...(error.code === "metadata_shape" && Schema.is(ShapeDetail)(error.detail)
                ? { detail: { field: error.detail.field, shape: error.detail.shape } }
                : {}),
            ...(Number.isInteger(error.status) &&
            (error.status ?? 0) >= 100 &&
            (error.status ?? 0) <= 599
                ? { status: error.status as number }
                : {}),
        };
    if (typeof error === "object" && error !== null && "_tag" in error) {
        switch (error._tag) {
            case "TimeoutError":
                return { code: "timeout" };
            case "AuthError":
            case "NeedsReauth":
                return { code: "auth_failure" };
            case "StateStoreError":
                return { code: "state_failure" };
        }
    }
    return { code: "native_failure" };
};
// Reconstruct only fixed safe fields; preserve diagnostics across Effect.tryPromise.
export function normalizeFailure(error: unknown) {
    const failure = safeFailure(error);
    return new InfraFailure(failure.code, failure.status, failure.detail);
}
export function stageFor(mode: Mode, id: string): string {
    requireThat(Schema.is(Mode)(mode) && /^[a-f0-9]{12}$/.test(id));
    return `e2e-${mode}-${id}`;
}
export function validateEnvironment(env: Record<string, string | undefined>) {
    requireThat(
        !Object.keys(env).some(
            (key) =>
                env[key] !== undefined &&
                (key.startsWith("ALCHEMY_") || key.startsWith("CLOUDFLARE_")),
        ),
    );
}
const Binding = Schema.Struct({ name: Schema.String, type: Schema.String });
export function validateBindings(input: unknown, ownedCreatingPlaceholder = false) {
    let bindings: readonly (typeof Binding.Type)[];
    try {
        bindings = Schema.decodeUnknownSync(Schema.Array(Binding))(input);
    } catch {
        throw new InfraFailure("unexpected_binding");
    }
    if (ownedCreatingPlaceholder && bindings.length === 0) {
        return {
            generatedPlainText: 0,
            custom: 0,
            secrets: 0,
            dataReferences: 0,
            placeholder: true,
        };
    }
    requireThat(
        bindings.length === generatedNames.length &&
            new Set(bindings.map((b) => b.name)).size === generatedNames.length &&
            bindings.every(
                (b) => b.type === "plain_text" && generatedNames.some((n) => n === b.name),
            ),
        "unexpected_binding",
    );
    return { generatedPlainText: bindings.length, custom: 0, secrets: 0, dataReferences: 0 };
}
export interface HealthAttempt {
    attempt: number;
    status?: number;
    media?: "json" | "html" | "other";
    passed: boolean;
    diagnostic?: string;
}
export interface HealthResult {
    passed: boolean;
    attempts: HealthAttempt[];
}
type FetchHealth = NonNullable<Parameters<typeof runSmoke>[1]>;
export async function readiness(
    url: string,
    signal: AbortSignal,
    options: {
        fetch?: FetchHealth;
        sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
        record?: (attempt: HealthAttempt) => void;
    } = {},
): Promise<HealthResult> {
    const attempts: HealthAttempt[] = [];
    const sleep =
        options.sleep ??
        ((ms, abort) =>
            new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new InfraFailure("timeout"));
                };
                const timer = setTimeout(() => {
                    abort.removeEventListener("abort", onAbort);
                    resolve();
                }, ms);
                if (abort.aborted) onAbort();
                else abort.addEventListener("abort", onAbort, { once: true });
            }));
    for (let index = 0; index < budgets.healthCount; index++) {
        if (signal.aborted) throw new InfraFailure("timeout");
        let response: Response | undefined;
        const observation: HealthAttempt = { attempt: index + 1, passed: false };
        const result = await runSmoke([url], async (target, init) => {
            response = await (options.fetch ?? fetch)(target, {
                ...init,
                signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
            });
            observation.status = response.status;
            const media = response.headers
                .get("content-type")
                ?.split(";", 1)[0]
                ?.trim()
                .toLowerCase();
            observation.media =
                media === "application/json" ? "json" : media === "text/html" ? "html" : "other";
            return response;
        });
        observation.passed = result.exitCode === 0;
        // runSmoke reconstructs failures from fixed categories; never parse or echo raw exceptions.
        if (!observation.passed) observation.diagnostic = result.message;
        attempts.push(observation);
        options.record?.(observation);
        // The successful response itself proved the contract; no separate final GET.
        if (response?.body && !response.bodyUsed)
            await response.body.cancel().catch(() => undefined);
        if (observation.passed) return { passed: true, attempts };
        const status = observation.status;
        const retryable =
            status === 404 ||
            (status !== undefined && status >= 500 && status <= 599) ||
            (status === 200 && observation.media === "html");
        if (!retryable || index === budgets.healthCount - 1) return { passed: false, attempts };
        await sleep(retryDelays[index] ?? 0, signal);
    }
    return { passed: false, attempts };
}

export type Outcome = "not_started" | "running" | "passed" | "failed" | "not_attempted";
export interface PhaseResult {
    outcome: Outcome;
    failure?: ReturnType<typeof safeFailure>;
}
export class Lifecycle {
    setupStarted = false;
    setupSettled = false;
    readonly phases: Record<"deploy" | "health" | "cleanup", PhaseResult> = {
        deploy: { outcome: "not_started" },
        health: { outcome: "not_started" },
        cleanup: { outcome: "not_started" },
    };

    beginSetup() {
        this.setupStarted = true;
        this.phases.deploy = { outcome: "running" };
    }

    settleSetup(passed: boolean, error?: unknown) {
        this.setupSettled = true;
        this.phases.deploy = passed
            ? { outcome: "passed" }
            : { outcome: "failed", failure: safeFailure(error) };
    }

    cleanupAllowed() {
        if (!this.setupStarted || !this.setupSettled)
            throw new InfraFailure("provisioning_unsettled");
    }
}
