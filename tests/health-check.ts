import { Health } from "@kbpod/api";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

const reasons = [
    "timeout",
    "transport",
    "http_status",
    "content_type",
    "invalid_json",
    "schema_mismatch",
    "unexpected_fields",
    "unexpected",
] as const;
const mediaCategories = ["json", "html", "text", "other", "missing"] as const;
const transportCategories = ["timeout", "dns", "tls", "connection", "other"] as const;
type HealthFailureReason = (typeof reasons)[number];
type MediaCategory = (typeof mediaCategories)[number];
type TransportCategory = (typeof transportCategories)[number];
type FailureDetails = {
    readonly status?: number;
    readonly contentType?: MediaCategory;
    readonly transport?: TransportCategory;
};

export class HealthCheckError extends Error {
    readonly _tag = "HealthCheckError";
    constructor(
        readonly reason: HealthFailureReason,
        readonly details: FailureDetails = {},
    ) {
        super(reason);
    }
}

export const classifyContentType = (value: string | null): MediaCategory => {
    const media = value?.split(";")[0]?.trim().toLowerCase();
    if (!media) return "missing";
    if (media === "application/json") return "json";
    if (media === "text/html") return "html";
    return media.startsWith("text/") ? "text" : "other";
};

export const classifyTransportError = (error: unknown): TransportCategory => {
    if (typeof error !== "object" || error === null) return "other";
    const failure = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
    if (failure.name === "TimeoutError" || failure.name === "AbortError") return "timeout";
    const code = typeof failure.code === "string" ? failure.code : failure.cause?.code;
    if (typeof code !== "string") return "other";
    if (["ENOTFOUND", "EAI_AGAIN", "DNS_RESOLUTION_FAILED"].includes(code)) return "dns";
    if (
        [
            "CERT_HAS_EXPIRED",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "SELF_SIGNED_CERT_IN_CHAIN",
            "DEPTH_ZERO_SELF_SIGNED_CERT",
            "ERR_TLS_CERT_ALTNAME_INVALID",
            "UNABLE_TO_GET_ISSUER_CERT",
            "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        ].includes(code)
    )
        return "tls";
    if (
        [
            "ECONNREFUSED",
            "ECONNRESET",
            "ENETUNREACH",
            "EHOSTUNREACH",
            "ConnectionRefused",
            "ConnectionClosed",
        ].includes(code)
    )
        return "connection";
    return "other";
};

// Reconstruct from allowlisted primitives. Never print Error.message/cause or raw input/response.
export const formatHealthFailure = (error: unknown): string => {
    const prefix = "Health verification failed: reason=";
    try {
        if (!(error instanceof HealthCheckError) || !reasons.includes(error.reason)) {
            return `${prefix}unexpected`;
        }
        const fields = [`${prefix}${error.reason}`];
        const { status, contentType, transport } = error.details;
        if (
            typeof status === "number" &&
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599
        ) {
            fields.push(`status=${status}`);
        }
        if (contentType !== undefined && mediaCategories.includes(contentType)) {
            fields.push(`contentType=${contentType}`);
        }
        if (transport !== undefined && transportCategories.includes(transport)) {
            fields.push(`transport=${transport}`);
        }
        return fields.join(" ");
    } catch {
        // Malformed error objects/getters must not escape to a runtime's raw exception printer.
        return `${prefix}unexpected`;
    }
};

// Shared by unit tests and the integration suite. No cloud imports.
export const checkHealthResponse = (response: Response) =>
    Effect.gen(function* () {
        const details = {
            status: response.status,
            contentType: classifyContentType(response.headers.get("content-type")),
        };
        if (response.status !== 200) {
            return yield* Effect.fail(new HealthCheckError("http_status", details));
        }
        if (details.contentType !== "json") {
            return yield* Effect.fail(new HealthCheckError("content_type", details));
        }

        const body: unknown = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (error) => {
                const transport = classifyTransportError(error);
                return transport === "other"
                    ? new HealthCheckError("invalid_json", details)
                    : new HealthCheckError(transport === "timeout" ? "timeout" : "transport", {
                          ...details,
                          transport,
                      });
            },
        });
        const health = yield* Schema.decodeUnknownEffect(Health)(body).pipe(
            Effect.mapError(() => new HealthCheckError("schema_mismatch", details)),
        );
        // Schema decoding can discard excess properties; assert the raw object too.
        if (body === null || typeof body !== "object" || Object.keys(body).length !== 1) {
            return yield* Effect.fail(new HealthCheckError("unexpected_fields", details));
        }
        return health;
    });

type FetchHealth = (url: URL, init: RequestInit) => Promise<Response>;

// Cancellation covers both the request and its body; errors retain only safe categories.
export const requestHealth = (url: string, fetchResponse: FetchHealth = fetch) =>
    Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (controller) =>
            Effect.tryPromise({
                try: () =>
                    fetchResponse(new URL("/health", url), {
                        signal: controller.signal,
                        redirect: "error",
                    }),
                catch: (error) => {
                    const transport = classifyTransportError(error);
                    return new HealthCheckError(transport === "timeout" ? "timeout" : "transport", {
                        transport,
                    });
                },
            }).pipe(Effect.flatMap(checkHealthResponse)),
        (controller) => Effect.sync(() => controller.abort()),
    ).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(new HealthCheckError("timeout"))),
        Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            return Effect.fail(
                error instanceof HealthCheckError ? error : new HealthCheckError("unexpected"),
            );
        }),
    );

export const healthNotReady = (error: HealthCheckError) =>
    (error.reason === "http_status" &&
        (error.details.status === 404 ||
            (error.details.status !== undefined &&
                error.details.status >= 500 &&
                error.details.status <= 599))) ||
    (error.reason === "content_type" &&
        error.details.status === 200 &&
        error.details.contentType === "html");

// One successful response proves the contract. At most six GETs, only for edge propagation.
export const waitForHealth = (url: string, fetchResponse: FetchHealth = fetch) =>
    requestHealth(url, fetchResponse).pipe(
        Effect.retry({
            while: healthNotReady,
            times: 5,
            schedule: Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("3 seconds"),
            ]),
        }),
    );
