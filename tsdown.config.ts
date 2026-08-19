import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/client/index.tsx"],
  outDir: "client",
  format: ["cjs"],
  platform: "browser",
  deps: {
    neverBundle: [
      "react",
      "react/jsx-runtime",
      "react-dom",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-web-react",
      "@deepseek-ai/cordis"
    ]
  },
  // Emit to a temp file so the normalize script can wrap the body in the
  // ModuleLoader envelope and write the final client/client.js with no ESM.
  outExtensions: () => ({ js: ".tmp.js" }),
  sourcemap: false
});
