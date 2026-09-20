import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/skills/calibration-cert/index.ts",
    "src/skills/remedial-tender-qualify/index.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
  splitting: false,
});
