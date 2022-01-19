import { Octokit } from "@octokit/rest"
import nock from "nock"

import {
  basePR,
  changedFilesApiPath,
  condition,
  configFileContentsApiPath,
  configFilePath,
  coworkers,
  githubApi,
  githubWebsite,
  requestedReviewersApiPath,
  reviewsApiPath,
  team,
  teamApiPath,
  userCoworker3,
} from "test/constants"
import Logger from "test/logger"

import { runChecks } from "src/core"

describe("Rules", function () {
  let logger: Logger
  let octokit: Octokit
  let logHistory: string[]
  let teamMembers: { id: number; login: string }[]

  beforeEach(function () {
    nock.disableNetConnect()
    logHistory = []
    logger = new Logger(logHistory)
    octokit = new Octokit()
  })

  for (const scenario of [
    "Approved",
    "Is missing approval",
    "Has no approval",
  ] as const) {
    const setup = function ({
      setupCoworkers,
      diff,
    }: { setupCoworkers?: string[]; diff?: string } = {}) {
      setupCoworkers ??= coworkers
      diff ??= condition

      nock(githubWebsite)
        .get(basePR.diff_url.slice(githubWebsite.length))
        .reply(200, diff)

      nock(githubApi)
        .get(reviewsApiPath)
        .reply(
          200,
          scenario === "Approved"
            ? setupCoworkers.map(function (coworker, id) {
                return { id, user: { id, login: coworker }, state: "APPROVED" }
              })
            : scenario === "Is missing approval"
            ? [
                {
                  id: 1,
                  user: { id: 1, login: coworkers[0] },
                  state: "APPROVED",
                },
              ]
            : [],
        )

      teamMembers = setupCoworkers.map(function (coworker, id) {
        return { id, login: coworker }
      })
      nock(githubApi).get(teamApiPath).reply(200, teamMembers)

      nock(githubApi)
        .get(changedFilesApiPath)
        .reply(200, [{ filename: condition }])
    }

    for (const checkType of ["diff", "changed_files"] as const) {
      it(`${scenario} on rule including only users for ${checkType}`, async function () {
        setup()

        nock(githubApi)
          .get(configFileContentsApiPath)
          .reply(200, {
            content: Buffer.from(
              `
              rules:
                - name: ${condition}
                  condition: ${condition}
                  check_type: ${checkType}
                  min_approvals: ${coworkers.length}
                  users:
                    - ${coworkers[0]}
                    - ${coworkers[1]}
              `,
            ).toString("base64"),
          })

        switch (scenario) {
          case "Has no approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, function (body) {
                expect(body).toMatchObject({
                  reviewers: coworkers,
                  team_reviewers: [],
                })
                return true
              })
              .reply(201)
            break
          }
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, function (body) {
                expect(body).toMatchObject({
                  reviewers: [coworkers[1]],
                  team_reviewers: [],
                })
                return true
              })
              .reply(201)
            break
          }
        }

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath,
            locksReviewTeam: team,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} on rule including only teams for ${checkType}`, async function () {
        setup()

        nock(githubApi)
          .get(configFileContentsApiPath)
          .reply(200, {
            content: Buffer.from(
              `
              rules:
                - name: ${condition}
                  condition: ${condition}
                  check_type: ${checkType}
                  min_approvals: ${coworkers.length}
                  teams:
                    - ${team}
              `,
            ).toString("base64"),
          })

        if (scenario !== "Approved") {
          nock(githubApi)
            .post(requestedReviewersApiPath, function (body) {
              expect(body).toMatchObject({
                reviewers: [],
                team_reviewers: [team],
              })
              return true
            })
            .reply(201)
        }

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath,
            locksReviewTeam: team,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} on rule including both teams and users for ${checkType}`, async function () {
        setup(
          scenario === "Is missing approval"
            ? { setupCoworkers: coworkers.concat(userCoworker3) }
            : undefined,
        )

        const userAskedIndividually = coworkers[1]

        nock(githubApi)
          .get(configFileContentsApiPath)
          .reply(200, {
            content: Buffer.from(
              `
              rules:
                - name: ${condition}
                  condition: ${condition}
                  check_type: ${checkType}
                  min_approvals: ${coworkers.length}
                  users:
                    - ${userAskedIndividually}
                  teams:
                    - ${team}
              `,
            ).toString("base64"),
          })

        if (scenario !== "Approved") {
          nock(githubApi)
            .post(requestedReviewersApiPath, function (body) {
              // This user will be asked individually even though they are
              // member of the team because they were specified individually in
              // the "users" configuration
              expect(
                teamMembers.find(({ login }) => login === userAskedIndividually)
                  ?.login,
              ).toBe(userAskedIndividually)
              expect(body).toMatchObject({
                reviewers: [userAskedIndividually],
                team_reviewers: [team],
              })
              return true
            })
            .reply(201)
        }

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath,
            locksReviewTeam: team,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} on rule not specifying users or teams`, async function () {
        setup(
          scenario === "Is missing approval"
            ? { setupCoworkers: coworkers.concat(userCoworker3) }
            : undefined,
        )

        nock(githubApi)
          .get(configFileContentsApiPath)
          .reply(200, {
            content: Buffer.from(
              `
              rules:
                - name: ${condition}
                  condition: ${condition}
                  check_type: ${checkType}
                  min_approvals: ${coworkers.length}
              `,
            ).toString("base64"),
          })

        if (scenario !== "Approved") {
          nock(githubApi)
            .post(requestedReviewersApiPath, function (body) {
              expect(body).toMatchObject({
                reviewers: coworkers,
                team_reviewers: [team],
              })
              return true
            })
            .reply(201)
        }

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath,
            locksReviewTeam: team,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })
    }

    for (const diffSign of ["+", "-"]) {
      it(`${scenario} when lock line is modified (${diffSign})`, async function () {
        setup({ diff: `${diffSign}🔒 deleting the lock line` })

        nock(githubApi).get(teamApiPath).reply(200, coworkers)

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, function (body) {
                expect(body).toMatchObject({
                  reviewers: [],
                  team_reviewers: [team],
                })
                return true
              })
              .reply(201)
            break
          }
        }

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath: "",
            locksReviewTeam: team,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} when line after lock is modified (${diffSign})`, async function () {
        setup({ diff: `🔒 lock line\n${diffSign} modified` })

        nock(githubApi).get(teamApiPath).reply(200, coworkers)

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, function (body) {
                expect(body).toMatchObject({
                  reviewers: [],
                  team_reviewers: [team],
                })
                return true
              })
              .reply(201)
            break
          }
        }

        expect(
          await runChecks(basePR, octokit, logger, {
            configFilePath: "",
            locksReviewTeam: team,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })
    }
  }

  afterEach(function () {
    nock.cleanAll()
    nock.enableNetConnect()
  })
})
