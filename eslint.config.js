import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist", "worker-configuration.d.ts"] },
	{
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
		},
		plugins: {
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
		},
		rules: {
			...reactHooks.configs.recommended.rules,
			"react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
			// A leading underscore marks a parameter kept for its signature.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		// Development scripts speak to the API over untyped JSON and stand in for
		// clients that are typed elsewhere. Restating those shapes here would only
		// create a second definition to keep in sync.
		files: ["scripts/**/*.ts"],
		rules: { "@typescript-eslint/no-explicit-any": "off" },
	},
	{
		// The entry point mounts the app and exports nothing, by design.
		files: ["src/react-app/main.tsx"],
		rules: { "react-refresh/only-export-components": "off" },
	},
);
