import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // 约定：以 `_` 开头的形参/变量表示「有意不使用」（如 textOn(_hex) 统一白色后不再读入参），
    // 交给规则忽略，避免用无意义的 void 语句压制告警
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // `.cjs` 就是 CommonJS 文件，`require()` 是它的正常写法 ⇒ 关闭该规则
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // 以下目录都属于「不进仓库的本地/过程产物」，不参与 lint —— 否则 `npm run lint`
    // 会被上千条无关告警淹没，失去「守门」的意义：
    //   `.verify/`   = 本地验证草稿（探测脚本大量使用 any）
    //   `.workbuddy/`= 研究过程文件（含接口逆向分析，已 gitignore）
    //   `data/`      = 采集产物
    //   `next-env.d.ts` = Next 自动生成（已 gitignore），其中的 triple-slash 是框架产物
    ignores: [
      "node_modules/**",
      ".next*/**", // .next 及一切 distDir 变体（如构建备用目录 .next-v213）——构建产物不参与 lint
      "out/**",
      "build/**",
      "backups/**",
      ".verify/**",
      ".workbuddy/**",
      "data/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
