import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
    HealthCheckError,
    formatHealthFailure,
    requestHealth,
    waitForHealth,
} from "../health-check.ts";

const origin = "https://kbpod.test";
const secret = "fixture-secret-never-print";
const json = (body: string, status = 200) =>
    new Response(body, {
        status,
        headers: { "content-type": `application/json; private=${secret}` },
    });

test("one exact response proves health, with no redirect or extra request", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const result = await Effect.runPromise(
        waitForHealth(origin, async (url, init) => {
            expect(url.href).toBe(`${origin}/health`);
            expect(init.redirect).toBe("error");
            expect(init.headers).toBeUndefined();
            signal = init.signal ?? undefined;
            calls++;
            return json(' \n{ "status": "ok" }\n');
        }),
    );
    expect(result).toEqual({ status: "ok" });
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
});

test.each([
    [() => json(secret, 503), "reason=http_status status=503 contentType=json"],
    [
        () => new Response(secret, { status: 403, headers: { "content-type": "text/html" } }),
        "reason=http_status status=403 contentType=html",
    ],
    [
        () => new Response(null, { status: 302, headers: { location: `https://${secret}.test` } }),
        "reason=http_status status=302 contentType=missing",
    ],
    [
        () => new Response(secret, { headers: { "content-type": `application/${secret}` } }),
        "reason=content_type status=200 contentType=other",
    ],
    [() => json(`{${secret}`), "reason=invalid_json status=200 contentType=json"],
    [() => json(`{"status":"${secret}"}`), "reason=schema_mismatch status=200 contentType=json"],
    [
        () => json(`{"status":"ok","token":"${secret}"}`),
        "reason=unexpected_fields status=200 contentType=json",
    ],
    [() => json(`{"status":"ok"}${secret}`), "reason=invalid_json status=200 contentType=json"],
] as const)(
    "health diagnostics contain safe categories, not response values: %#",
    async (response, expected) => {
        const failure = await Effect.runPromise(
            Effect.flip(requestHealth(origin, async () => response())),
        );
        expect(formatHealthFailure(failure)).toBe(`Health verification failed: ${expected}`);
        expect(JSON.stringify(failure)).not.toContain(secret);
    },
);

test.each([
    [new DOMException(secret, "TimeoutError"), "timeout", "timeout"],
    [Object.assign(new Error(secret), { code: "ENOTFOUND" }), "transport", "dns"],
    [new Error(secret, { cause: { code: "CERT_HAS_EXPIRED" } }), "transport", "tls"],
    [Object.assign(new Error(secret), { code: "ECONNRESET" }), "transport", "connection"],
    [new Error(secret), "transport", "other"],
] as const)("transport errors omit raw causes: %#", async (error, reason, transport) => {
    const failure = await Effect.runPromise(
        Effect.flip(
            requestHealth(origin, async () => {
                throw error;
            }),
        ),
    );
    expect(formatHealthFailure(failure)).toBe(
        `Health verification failed: reason=${reason} transport=${transport}`,
    );
    expect(JSON.stringify(failure)).not.toContain(secret);
});

test("body failures retain safe status and timeout categories", async () => {
    const response = new Response(
        new ReadableStream({
            start(controller) {
                controller.error(new DOMException(secret, "TimeoutError"));
            },
        }),
        { headers: { "content-type": "application/json" } },
    );
    const failure = await Effect.runPromise(
        Effect.flip(requestHealth(origin, async () => response)),
    );
    expect(formatHealthFailure(failure)).toBe(
        "Health verification failed: reason=timeout status=200 contentType=json transport=timeout",
    );
});

test("interrupting a request aborts its transport", async () => {
    let signal: AbortSignal | undefined;
    await Effect.runPromise(
        requestHealth(origin, async (_url, init) => {
            signal = init.signal ?? undefined;
            return await new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
            });
        }).pipe(Effect.timeout("10 millis"), Effect.exit),
    );
    expect(signal?.aborted).toBe(true);
});

test.each([400, 401, 403, 429, 302])("terminal HTTP %s is not retried", async (status) => {
    let calls = 0;
    const failure = await Effect.runPromise(
        Effect.flip(
            waitForHealth(origin, async () => {
                calls++;
                return new Response(null, { status });
            }),
        ),
    );
    expect(failure.reason).toBe("http_status");
    expect(calls).toBe(1);
});

test("edge propagation retries end at the first exact response", async () => {
    let calls = 0;
    const responses = [
        new Response(null, { status: 404 }),
        new Response(null, { status: 503 }),
        new Response(secret, { headers: { "content-type": "text/html" } }),
        json('{"status":"ok"}'),
    ];
    expect(
        await Effect.runPromise(
            waitForHealth(origin, async () => {
                const response = responses[calls++];
                if (!response) throw new Error("Unexpected extra health request");
                return response;
            }),
        ),
    ).toEqual({ status: "ok" });
    expect(calls).toBe(4);
}, 10_000);

test("propagation failures stop after six attempts", async () => {
    let calls = 0;
    const failure = await Effect.runPromise(
        Effect.flip(
            waitForHealth(origin, async () => {
                calls++;
                return new Response(null, { status: 404 });
            }),
        ),
    );
    expect(failure.details.status).toBe(404);
    expect(calls).toBe(6);
}, 20_000);

test("unexpected errors and forged diagnostic fields cannot print arbitrary data", () => {
    expect(formatHealthFailure(new Error(secret))).toBe(
        "Health verification failed: reason=unexpected",
    );
    const forged = Object.assign(new HealthCheckError("http_status"), {
        details: { status: secret, contentType: secret, transport: secret },
        message: secret,
    });
    expect(formatHealthFailure(forged)).toBe("Health verification failed: reason=http_status");
});
