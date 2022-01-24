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
  org,
  requestedReviewersApiPath,
  reviewsApiPath,
  team,
  team2,
  userCoworker3,
} from "test/constants"
import Logger from "test/logger"

import { runChecks } from "src/core"

describe("Rules", function () {
  let logger: Logger
  let octokit: Octokit
  let logHistory: string[]
  let teamMembers: Map<string, string[]>

  beforeEach(function () {
    nock.disableNetConnect()
    logHistory = []
    logger = new Logger(logHistory)
    octokit = new Octokit()
    teamMembers = new Map()
  })

  for (const scenario of [
    "Approved",
    "Is missing approval",
    "Has no approval",
  ] as const) {
    const setup = function ({
      users,
      diff,
      teams,
    }: {
      users?: string[]
      diff?: string
      teams?: { name: string; members: string[] }[]
    } = {}) {
      users ??= coworkers
      diff ??= condition
      teams ??= [{ name: team, members: users }]

      nock(githubWebsite)
        .get(basePR.diff_url.slice(githubWebsite.length))
        .reply(200, diff)

      nock(githubApi)
        .get(reviewsApiPath)
        .reply(
          200,
          scenario === "Approved"
            ? users.map(function (login, id) {
                return { id, user: { id, login }, state: "APPROVED" }
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

      for (const { name, members } of teams) {
        teamMembers.set(name, members)
        nock(githubApi)
          .get(`/orgs/${org}/teams/${name}/members`)
          .reply(
            200,
            members.map(function (login, id) {
              return { id, login }
            }),
          )
      }

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
            teamLeadsTeam: team2,
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
            teamLeadsTeam: team2,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} on rule including both teams and users for ${checkType}`, async function () {
        setup(
          scenario === "Is missing approval"
            ? { users: coworkers.concat(userCoworker3) }
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
                teamMembers
                  .get(team)!
                  .find((member) => member === userAskedIndividually),
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
            teamLeadsTeam: team2,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} on rule not specifying users or teams`, async function () {
        setup(
          scenario === "Is missing approval"
            ? { users: coworkers.concat(userCoworker3) }
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
            teamLeadsTeam: team2,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      for (const [ruleKind, ruleField] of [
        ["AndRule", "all"],
        ["OrRule", "any"],
      ]) {
        it(`Rule kind ${ruleKind}: ${scenario} specifying only users for ${checkType}`, async function () {
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
                    ${ruleField}:
                      - min_approvals: 1
                        users:
                          - ${coworkers[0]}
                      - min_approvals: 1
                        users:
                          - ${coworkers[1]}
                `,
              ).toString("base64"),
            })

          let expected: "success" | "failure"
          switch (ruleKind) {
            case "AndRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, function (body) {
                    expect(body).toMatchObject({
                      reviewers:
                        scenario === "Has no approval"
                          ? coworkers
                          : [coworkers[1]],
                      team_reviewers: [],
                    })
                    return true
                  })
                  .reply(201)
              }
              expected = scenario === "Approved" ? "success" : "failure"
              break
            }
            case "OrRule": {
              if (scenario === "Has no approval") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, function (body) {
                    expect(body).toMatchObject({
                      reviewers: coworkers,
                      team_reviewers: [],
                    })
                    return true
                  })
                  .reply(201)
              }
              expected = scenario === "Has no approval" ? "failure" : "success"
              break
            }
            default: {
              throw new Error(`Unhandled rule kind ${ruleKind}`)
            }
          }

          expect(
            await runChecks(basePR, octokit, logger, {
              configFilePath,
              locksReviewTeam: team,
              teamLeadsTeam: team2,
            }),
          ).toBe(expected)

          expect(logHistory).toMatchSnapshot()
        })

        it(`Rule kind ${ruleKind}: ${scenario} specifying only teams for ${checkType}`, async function () {
          const team1 = "team1"
          const team2 = "team2"

          setup({
            teams: [
              {
                name: team1,
                members:
                  scenario === "Has no approval"
                    ? [coworkers[1]]
                    : [coworkers[0]],
              },
              { name: team2, members: [coworkers[1]] },
            ],
          })

          nock(githubApi)
            .get(configFileContentsApiPath)
            .reply(200, {
              content: Buffer.from(
                `
                rules:
                  - name: ${condition}
                    condition: ${condition}
                    check_type: ${checkType}
                    ${ruleField}:
                      - min_approvals: 1
                        teams:
                          - ${team1}
                      - min_approvals: 1
                        teams:
                          - ${team2}
                `,
              ).toString("base64"),
            })

          let expectedCheckOutcome: "success" | "failure"
          switch (ruleKind) {
            case "AndRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, function (body) {
                    expect(body).toMatchObject({
                      reviewers: [],
                      team_reviewers:
                        scenario === "Is missing approval" ? [team2] : [team1],
                    })
                    return true
                  })
                  .reply(201)
              }
              expectedCheckOutcome =
                scenario === "Approved" ? "success" : "failure"
              break
            }
            case "OrRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, function (body) {
                    expect(body).toMatchObject({
                      reviewers: [],
                      team_reviewers:
                        scenario === "Is missing approval" ? [team2] : [team1],
                    })
                    return true
                  })
                  .reply(201)
              }
              expectedCheckOutcome =
                scenario === "Has no approval" ? "failure" : "success"
              break
            }
            default: {
              throw new Error(`Unhandled rule kind ${ruleKind}`)
            }
          }

          expect(
            await runChecks(basePR, octokit, logger, {
              configFilePath,
              locksReviewTeam: team,
              teamLeadsTeam: team2,
            }),
          ).toBe(expectedCheckOutcome)

          expect(logHistory).toMatchSnapshot()
        })

        it(`Rule kind ${ruleKind}: ${scenario} specifying both teams and users for ${checkType}`, async function () {
          const team1 = "team1"
          const team2 = "team2"

          setup({
            users: coworkers.concat(userCoworker3),
            teams: [
              {
                name: team1,
                members:
                  scenario === "Has no approval"
                    ? [coworkers[1]]
                    : [coworkers[0]],
              },
              { name: team2, members: [coworkers[1]] },
            ],
          })

          nock(githubApi)
            .get(configFileContentsApiPath)
            .reply(200, {
              content: Buffer.from(
                `
                rules:
                  - name: ${condition}
                    condition: ${condition}
                    check_type: ${checkType}
                    ${ruleField}:
                      - min_approvals: 1
                        teams:
                          - ${team1}
                      - min_approvals: 1
                        teams:
                          - ${team2}
                      - min_approvals: 1
                        users:
                          - ${userCoworker3}
                `,
              ).toString("base64"),
            })

          let expectedCheckOutcome: "success" | "failure"
          switch (ruleKind) {
            case "AndRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, function (body) {
                    expect(body).toMatchObject({
                      reviewers: [userCoworker3],
                      team_reviewers:
                        scenario === "Is missing approval" ? [team2] : [team1],
                    })
                    return true
                  })
                  .reply(201)
              }
              expectedCheckOutcome =
                scenario === "Approved" ? "success" : "failure"
              break
            }
            case "OrRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, function (body) {
                    expect(body).toMatchObject({
                      reviewers: [userCoworker3],
                      team_reviewers:
                        scenario === "Is missing approval" ? [team2] : [team1],
                    })
                    return true
                  })
                  .reply(201)
              }
              expectedCheckOutcome =
                scenario === "Has no approval" ? "failure" : "success"
              break
            }
            default: {
              throw new Error(`Unhandled rule kind ${ruleKind}`)
            }
          }

          expect(
            await runChecks(basePR, octokit, logger, {
              configFilePath,
              locksReviewTeam: team,
              teamLeadsTeam: team2,
            }),
          ).toBe(expectedCheckOutcome)

          expect(logHistory).toMatchSnapshot()
        })
      }
    }

    for (const diffSign of ["+", "-"]) {
      it(`${scenario} when lock line is modified (${diffSign})`, async function () {
        setup({
          diff: `${diffSign}🔒 deleting the lock line`,
          teams: [
            { name: team, members: [coworkers[0]] },
            { name: team2, members: [coworkers[1]] },
          ],
        })

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, function (body) {
                expect(body).toMatchObject({
                  reviewers: [],
                  team_reviewers:
                    scenario === "Has no approval" ? [team, team2] : [team2],
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
            teamLeadsTeam: team2,
          }),
        ).toBe(scenario === "Approved" ? "success" : "failure")

        expect(logHistory).toMatchSnapshot()
      })

      it(`${scenario} when line after lock is modified (${diffSign})`, async function () {
        setup({
          diff: `🔒 lock line\n${diffSign} modified`,
          teams: [
            { name: team, members: [coworkers[0]] },
            { name: team2, members: [coworkers[1]] },
          ],
        })

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, function (body) {
                expect(body).toMatchObject({
                  reviewers: [],
                  team_reviewers:
                    scenario === "Has no approval" ? [team, team2] : [team2],
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
            teamLeadsTeam: team2,
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
