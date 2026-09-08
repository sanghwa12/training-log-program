// npm run dev   → 개발용 볼트의 플러그인 폴더에 main.js를 쓰고 파일 변경을 감시한다.
// npm run build → 저장소 루트에 production main.js를 쓴다(GitHub Release 자산용).
import esbuild from "esbuild";
import { copyFileSync } from "node:fs";

const prod = process.argv[2] === "production";
const DEV_DIR = process.env.TLOG_VAULT_PLUGIN ?? "tlog-vault/.obsidian/plugins/tlog"; // 프로젝트 안의 개발용 볼트
const outfile = prod ? "main.js" : `${DEV_DIR}/main.js`;

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "browser",
  target: "es2018",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  logLevel: "info",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  copyFileSync("manifest.json", `${DEV_DIR}/manifest.json`);
  copyFileSync("styles.css", `${DEV_DIR}/styles.css`);
  await ctx.watch();
}
