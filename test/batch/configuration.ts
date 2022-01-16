import { Octokit } from "@octokit/rest"
import nock from "nock"

import {
  basePR,
  condition,
  configFileContentsApiPath,
  configFilePath,
  githubApi,
  githubWebsite,
  team,
} from "test/constants"
import Logger from "test/logger"

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
        }),
      ).toBe("failure")

      expect(logHistory).toMatchSnapshot()
    })
  }

  it(`Configuration is invalid if min_approvals is less than 1`, async function () {
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
      }),
    ).toBe("failure")

    expect(logHistory).toMatchSnapshot()
  })

  afterEach(function () {
    nock.cleanAll()
    nock.enableNetConnect()
  })
})
