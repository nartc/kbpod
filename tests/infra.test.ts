import { test } from "bun:test";
import { loadChildContext } from "./infra/files.ts";

// The ordinary discovery branch imports neither Alchemy nor the application stack.
if (process.env.KBPOD_INFRA_CHILD === undefined) {
    test.skip("native infrastructure lifecycle (explicit test:infra:local/live only)", () => {});
} else {
    try {
        const context = loadChildContext(); // Validate parent, nonce, stage, environment and source before import.
        if (context.run.recoveryFrom) throw new Error("invalid_infra_registration");
        const { register } = await import("./infra/native.ts");
        register(context);
    } catch {
        test("native infrastructure registration", () => {
            throw new Error("invalid_infra_registration");
        });
    }
}
