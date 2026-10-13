import { describe, expect, test } from "bun:test";
import { Health } from "@kbpod/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import { HealthCheckError, checkHealthResponse } from "../../../tests/health-check.ts";
import { ApiLive } from "../src/http.ts";

describe("health API", () => {
    test("the real HttpApi handler responds with the exact shared contract", async () => {
        const app = HttpRouter.toWebHandler(ApiLive, { disableLogger: true });
        try {
            const response = await app.handler(new Request("http://kbpod.test/health"));
            expect(await Effect.runPromise(checkHealthResponse(response))).toEqual({
                status: "ok",
            });
        } finally {
            await app.dispose();
        }
    });

    test("unknown paths return 404 rather than health success", async () => {
        const app = HttpRouter.toWebHandler(ApiLive, { disableLogger: true });
        try {
            const response = await app.handler(new Request("http://kbpod.test/missing"));
            expect(response.status).toBe(404);
        } finally {
            await app.dispose();
        }
    });

    test("the Effect schema decoder rejects an invalid status", async () => {
        await expect(
            Effect.runPromise(Schema.decodeUnknownEffect(Health)({ status: "not-ok" })),
        ).rejects.toBeDefined();
    });

    test.each([
        ["non-200", () => Response.json({ status: "ok" }, { status: 503 })],
        [
            "wrong media type",
            () => new Response('{"status":"ok"}', { headers: { "content-type": "text/plain" } }),
        ],
        [
            "malformed JSON",
            () => new Response("{", { headers: { "content-type": "application/json" } }),
        ],
        ["invalid status", () => Response.json({ status: "not-ok" })],
        ["extra fields", () => Response.json({ status: "ok", secret: "not-a-real-secret" })],
        ["missing status", () => Response.json({})],
    ])("the shared smoke assertions reject %s", async (_label, response) => {
        await expect(Effect.runPromise(checkHealthResponse(response()))).rejects.toBeInstanceOf(
            HealthCheckError,
        );
    });
});
