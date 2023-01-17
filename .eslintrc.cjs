const { getConfiguration, getTypescriptOverride } = require("opstooling-js-style/src/eslint/configuration");

const tsConfParams = { rootDir: __dirname };

const conf = getConfiguration({ typescript: tsConfParams });

const tsConfOverride = getTypescriptOverride(tsConfParams);

module.exports = {
  ...conf,
  overrides: [
    ...conf.overrides,
    // SonarJS.
    {
      ...tsConfOverride,
      files: "{*,**,**/*}.{ts,tsx}",
      rules: {
        ...tsConfOverride.rules,
        "sonarjs/no-all-duplicated-branches": "error",
        "sonarjs/no-element-overwrite": "error",
        "sonarjs/no-empty-collection": "error",
        "sonarjs/no-extra-arguments": "error",
        "sonarjs/no-identical-conditions": "error",
        "sonarjs/no-identical-expressions": "error",
        "sonarjs/no-ignored-return": "error",
        "sonarjs/no-use-of-empty-return-value": "error",
        "sonarjs/no-collapsible-if": "error",
        "sonarjs/non-existent-operator": "error",
        "sonarjs/no-collection-size-mischeck": "error",
        "sonarjs/no-duplicate-string": "error",
        "sonarjs/no-gratuitous-expressions": "error",
        "sonarjs/no-duplicated-branches": "error",
        "sonarjs/no-redundant-boolean": "error",
        "sonarjs/no-redundant-jump": "error",
        "sonarjs/no-unused-collection": "error",
        "sonarjs/prefer-immediate-return": "error",
      },
    },
    // Temporary disabled rules.
    {
      ...tsConfOverride,
      files: "{*,**,**/*}.{ts,tsx}",
      rules: {
        ...tsConfOverride.rules,
        "@typescript-eslint/explicit-module-boundary-types": "off",
        "@typescript-eslint/no-explicit-any": "off"
      },
    },
  ],
};
