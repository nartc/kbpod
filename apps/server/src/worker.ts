import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { ApiLive } from "./http.ts";

export default Cloudflare.Worker(
  "Server",
  { main: import.meta.url },
  Effect.gen(function* () {
    return { fetch: yield* HttpRouter.toHttpEffect(ApiLive) };
  }),
);
