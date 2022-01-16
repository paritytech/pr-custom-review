const path = require("path")

const conf = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^src/(.*)": `${__dirname}/src/$1`,
    "^test/(.*)": `${__dirname}/test/$1`,
  },
  roots: ["<rootDir>/test/batch"],
  testRegex: "\\.ts$",
  coverageReporters: process.env.CI ? ["text"] : ["text", "lcov"],
  globals: {
    "ts-jest": { tsconfig: path.join(__dirname, "test", "tsconfig.json") },
  },
}

module.exports = conf
