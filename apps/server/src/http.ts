import { KbpodApi } from "@kbpod/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServer from "effect/http/HttpServer";

export const HealthLive = HttpApiBuilder.group(KbpodApi, "health", (handlers) =>
    handlers.handle("get", () => Effect.succeed({ status: "ok" as const })),
);

// JSON-only API: the no-op filesystem in layerServices deliberately cannot serve files.
export const ApiLive = HttpApiBuilder.layer(KbpodApi).pipe(
    Layer.provide(HealthLive),
    Layer.provide(HttpServer.layerServices),
);
