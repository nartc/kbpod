import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

export const Health = Schema.Struct({ status: Schema.Literal("ok") });

export const HealthGroup = HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("get", "/health", { success: Health }),
);

export const KbpodApi = HttpApi.make("KbpodApi").add(HealthGroup);
