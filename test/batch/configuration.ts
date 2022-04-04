import { Octokit } from "@octokit/rest"
import nock from "nock"
import YAML from "yaml"

import {
  basePR,
  changedFilesApiPath,
  condition,
  configFileContentsApiPath,
  githubApi,
  defaultTeamsNames,
  prApiPath,
  rulesExamples,
} from "test/constants"
import Logger from "test/logger"

import { rulesConfigurations } from "src/constants"
import { runChecks } from "src/core"

const setup = function ({ rules }: { rules?: Array<Record<string, unknown>> }) {
  nock(githubApi)
    .get(configFileContentsApiPath)
    .reply(200, {
      content: Buffer.from(
        YAML.stringify({ ...defaultTeamsNames, rules }),
      ).toString("base64"),
    })
}

describe("Configuration", function () {
  let logger: Logger
  let octokit: Octokit
  let logHistory: string[]

  beforeEach(function () {
    nock.disableNetConnect()
    logHistory = []
    logger = new Logger(logHistory)
    octokit = new Octokit()
    nock(githubApi)
      .get(prApiPath)
      .matchHeader("accept", "application/vnd.github.v3.diff")
      .reply(200, condition)
    nock(githubApi)
      .get(changedFilesApiPath)
      .reply(200, [{ filename: condition }])
  })

  for (const { kind, invalidFields } of Object.values(rulesConfigurations)) {
    const goodRule = rulesExamples[kind]

    for (const invalidField of invalidFields) {
      const invalidFieldValidValue = (function () {
        switch (invalidField) {
          case "all":
          case "all_distinct":
          case "teams":
          case "users":
          case "any": {
            return []
          }
          case "min_approvals": {
            return 1
          }
          default: {
            const exhaustivenessCheck: never = invalidField
            throw new Error(
              `invalidField is not handled: ${exhaustivenessCheck}`,
            )
          }
        }
      })()

      it(`Rule kind ${kind} does not allow invalid field ${invalidField}`, async function () {
        const badRule = { ...goodRule, [invalidField]: invalidFieldValidValue }

        setup({ rules: [badRule] })

        expect(await runChecks(basePR, octokit, logger)).toBe("failure")

        expect(logHistory).toMatchSnapshot()
      })
    }
  }

  for (const [kind, exampleRule] of Object.entries(rulesExamples)) {
    for (const [invalidValue, description] of [
      [0, "less than 1"],
      [null, "null"],
    ]) {
      it(`min_approvals is invalid for ${kind} if it is ${description}`, async function () {
        setup({
          rules: [
            {
              ...exampleRule,
              ...("min_approvals" in exampleRule
                ? { min_approvals: invalidValue }
                : "all" in exampleRule
                ? { all: [{ min_approvals: invalidValue }] }
                : "any" in exampleRule
                ? { any: [{ min_approvals: invalidValue }] }
                : "all_distinct" in exampleRule
                ? { all_distinct: [{ min_approvals: invalidValue }] }
                : {}),
            },
          ],
        })

        expect(await runChecks(basePR, octokit, logger)).toBe("failure")

        expect(logHistory).toMatchSnapshot()
      })
    }
  }

  afterEach(function () {
    nock.cleanAll()
    nock.enableNetConnect()
  })
})
