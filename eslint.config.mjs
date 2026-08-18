// @ts-check
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";

/**
 * HeroUI v3 guard rails.
 *
 * v3 is a breaking rewrite of v2/NextUI. The two mistakes a model or an
 * engineer working from v2 memory makes are (a) `onClick` on a HeroUI
 * component — v3 is React Aria, the handler is `onPress` and `onClick` is
 * silently dropped, and (b) importing `@heroui/system` / `@heroui/theme`,
 * which do not exist in v3. Both are build-breaking errors here, not warnings.
 */

const HEROUI_PACKAGE = "@heroui/react";

/** Packages that only ever existed in HeroUI v2 / NextUI. */
const V2_ONLY_PACKAGES = [
  "@heroui/system",
  "@heroui/theme",
  "@nextui-org/react",
  "@nextui-org/system",
  "@nextui-org/theme",
];

/** Exports that only ever existed in v2, even when imported from @heroui/react. */
const V2_ONLY_EXPORTS = new Set(["HeroUIProvider", "NextUIProvider"]);

function isV2Package(source) {
  return V2_ONLY_PACKAGES.some((p) => source === p || source.startsWith(`${p}/`));
}

/** Resolve <Card.Header> to its root identifier `Card`. */
function rootName(nameNode) {
  let node = nameNode;
  while (node && node.type === "JSXMemberExpression") node = node.object;
  return node && node.type === "JSXIdentifier" ? node.name : null;
}

/** @type {import("eslint").Rule.RuleModule} */
const noHeroUIOnClick = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow onClick on HeroUI components. HeroUI v3 is built on React Aria: use onPress.",
    },
    schema: [],
    messages: {
      onClick:
        "`onClick` on <{{name}}> is a HeroUI v2 pattern. HeroUI v3 is React Aria — use `onPress` " +
        "(pointer, keyboard and touch), otherwise the handler silently never fires.",
    },
  },
  create(context) {
    /** Local names bound to a HeroUI import in this module. */
    const heroUINames = new Set();

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        if (source !== HEROUI_PACKAGE && !source.startsWith(`${HEROUI_PACKAGE}/`)) return;
        for (const spec of node.specifiers) {
          heroUINames.add(spec.local.name);
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "onClick") return;
        const element = node.parent;
        if (!element || element.type !== "JSXOpeningElement") return;
        const name = rootName(element.name);
        if (!name || !heroUINames.has(name)) return;
        context.report({ node, messageId: "onClick", data: { name } });
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noHeroUIV2Imports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow HeroUI v2-only packages and exports (@heroui/system, @heroui/theme, HeroUIProvider).",
    },
    schema: [],
    messages: {
      v2Package:
        "`{{source}}` is a HeroUI v2 package and does not exist in v3. Use `@heroui/react` for " +
        "components and `@heroui/styles` for the stylesheet.",
      v2Export:
        "`{{name}}` is a HeroUI v2 API. HeroUI v3 has no provider — delete the wrapper entirely.",
    },
  },
  create(context) {
    function checkSource(node, source) {
      if (typeof source !== "string") return;
      if (isV2Package(source)) {
        context.report({ node, messageId: "v2Package", data: { source } });
      }
    }

    return {
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.imported.type === "Identifier") {
            if (V2_ONLY_EXPORTS.has(spec.imported.name)) {
              context.report({
                node: spec,
                messageId: "v2Export",
                data: { name: spec.imported.name },
              });
            }
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) checkSource(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") checkSource(node, node.source.value);
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0] &&
          node.arguments[0].type === "Literal"
        ) {
          checkSource(node, node.arguments[0].value);
        }
      },
    };
  },
};

const heroui = {
  rules: {
    "no-onclick": noHeroUIOnClick,
    "no-v2-imports": noHeroUIV2Imports,
  },
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      // Owned by other agents — not this scaffold's business.
      "packages/**",
      "tools/**",
      "supabase/**",
      "tests/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [tseslint.configs.recommended],
    plugins: { heroui, "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "heroui/no-onclick": "error",
      "heroui/no-v2-imports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["*.mjs", "lib/scripts/**/*.mjs", "*.config.{js,mjs,ts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
