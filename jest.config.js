const path = require("path")

const conf = {
  rootDir: __dirname,
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: { "^(src|test)/(.*)": `${__dirname}/$1/$2` },
  testRegex: `^${__dirname}/test/batch/.*\.ts$`.split("/").join("\\/"),
  coverageReporters: process.env.CI ? ["text"] : ["text", "lcov", "html"],
  globals: {
    "ts-jest": { tsconfig: path.join(__dirname, "test", "tsconfig.json") },
  },
  snapshotResolver: path.join(__dirname, "test", "snapshotResolver.js"),
  coverageDirectory: "coverage",
  collectCoverageFrom: ["<rootDir>/src/{core,validation}.ts"],
  coveragePathIgnorePatterns: [
    path.join(__dirname, "(build|node_modules|dist|test)"),
  ]
}

module.exports = conf
