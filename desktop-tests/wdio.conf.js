import { resolve } from "node:path";

export const config = {
  runner: "local",
  specs: ["./smoke.spec.js"],
  maxInstances: 1,
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "info",
  mochaOpts: { timeout: 120000 },
  capabilities: [
    {
      "tauri:options": { application: resolve("src-tauri/target/debug/sigma") },
    },
  ],
  services: [
    [
      "tauri",
      {
        driverProvider: "embedded",
        embeddedPort: Number(process.env.SIGMA_DESKTOP_DRIVER_PORT),
        appBinaryPath: resolve("src-tauri/target/debug/sigma"),
      },
    ],
  ],
};
