import { Octokit } from "@octokit/rest"
import nock from "nock"
import YAML from "yaml"

import {
  basePR,
  condition,
  configFileContentsApiPath,
  configFilePath,
  githubApi,
  githubWebsite,
  rulesExamples,
  team,
  team2,
} from "test/constants"
import Logger from "test/logger"

import {
  rulesConfigurations,
  variableNameToActionInputName,
} from "src/constants"
import { runChecks } from "src/core"

describe("Configuration", function () {
  let logger: Logger
  let octokit: Octokit
  let logHistory: string[]

  beforeEach(function () {
    nock.disableNetConnect()
    logHistory = []
    logger = new Logger(logHistory)
    octokit = new Octokit()
    nock(githubWebsite)
      .get(basePR.diff_url.slice(githubWebsite.length))
      .reply(200, condition)
  })

  for (const [missingField, value] of [
    ["name", condition],
    ["condition", condition],
    ["check_type", "diff"],
    ["min_approvals", 1],
  ]) {
    it(`Configuration is invalid if ${missingField} is missing`, async function () {
      nock(githubApi)
        .get(configFileContentsApiPath)
        .reply(200, {
          content: Buffer.from(
            `
            rules:
              - ${missingField === "name" ? "" : `name: ${value}`}
                ${missingField === "condition" ? "" : `condition: ${value}`}
                ${missingField === "check_type" ? "" : `check_type: ${value}`}
                ${
                  missingField === "min_approvals"
                    ? ""
                    : `min_approvals: ${value}`
                }
            `,
          ).toString("base64"),
        })

      expect(
        await runChecks(basePR, octokit, logger, {
          configFilePath,
          locksReviewTeam: team,
          teamLeadsTeam: team2,
        }),
      ).toBe("failure")

      expect(logHistory).toMatchSnapshot()
    })
  }

  it("Configuration is invalid if min_approvals is less than 1", async function () {
    nock(githubApi)
      .get(configFileContentsApiPath)
      .reply(200, {
        content: Buffer.from(
          `
          rules:
            - name: ${condition}
              condition: ${condition}
              check_type: diff
              min_approvals: 0
          `,
        ).toString("base64"),
      })

    expect(
      await runChecks(basePR, octokit, logger, {
        configFilePath,
        locksReviewTeam: team,
        teamLeadsTeam: team2,
      }),
    ).toBe("failure")

    expect(logHistory).toMatchSnapshot()
  })

  for (const name in variableNameToActionInputName) {
    it(`Configuration is invalid if ${name} is empty or missing`, async function () {
      expect(
        await runChecks(basePR, octokit, logger, {
          configFilePath,
          locksReviewTeam: team,
          teamLeadsTeam: team2,
          [name]: "",
        }),
      ).toBe("failure")

      expect(logHistory).toMatchSnapshot()
    })
  }

  for (const { kind, invalidFields } of Object.values(rulesConfigurations)) {
    const goodRule = rulesExamples[kind]

    for (const invalidField of invalidFields) {
      const invalidFieldValidValue = (function () {
        switch (invalidField) {
          case "all":
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

        nock(githubApi)
          .get(configFileContentsApiPath)
          .reply(200, {
            content: Buffer.from(YAML.stringify({ rules: [badRule] })).toString(
              "base64",
            ),
          })

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath,
            locksReviewTeam: team,
            teamLeadsTeam: team2,
          }),
        ).toBe("failure")

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
        nock(githubApi)
          .get(configFileContentsApiPath)
          .reply(200, {
            content: Buffer.from(
              YAML.stringify({
                rules: [
                  {
                    ...exampleRule,
                    ...("min_approvals" in exampleRule
                      ? { min_approvals: invalidValue }
                      : "all" in exampleRule
                      ? { all: [{ min_approvals: invalidValue }] }
                      : "any" in exampleRule
                      ? { any: [{ min_approvals: invalidValue }] }
                      : {}),
                  },
                ],
              }),
            ).toString("base64"),
          })

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath,
            locksReviewTeam: team,
            teamLeadsTeam: team2,
          }),
        ).toBe("failure")

        expect(logHistory).toMatchSnapshot()
      })
    }
  }

  afterEach(function () {
    nock.cleanAll()
    nock.enableNetConnect()
  })
})
