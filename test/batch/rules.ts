/* eslint-disable @typescript-eslint/switch-exhaustiveness-check */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { Octokit } from "@octokit/rest";
import nock from "nock";
import {
  basePR,
  changedFilesApiPath,
  condition,
  configFileContentsApiPath,
  coworkers,
  defaultTeamsNames,
  githubApi,
  org,
  prApiPath,
  requestedReviewersApiPath,
  reviewsApiPath,
  team,
  team2,
  team3,
  user,
  userCoworker3,
} from "test/constants";
import { TestLogger } from "test/logger";
import YAML from "yaml";

import { actionReviewTeamFiles, maxGithubApiTeamMembersPerPage } from "src/constants";
import { runChecks } from "src/core";
import { GitHubApi } from "src/github/api";
import { Configuration, Rule } from "src/types";

describe("Rules", () => {
  let logger: TestLogger;
  let octokit: Octokit;
  let logHistory: string[];
  let teamMembers: Map<string, string[]>;

  beforeEach(() => {
    nock.disableNetConnect();
    logHistory = [];
    logger = new TestLogger(logHistory);
    octokit = new Octokit();
    teamMembers = new Map();
  });

  const setup = (options: {
    users?: string[];
    diff?: string;
    teams?: { name: string; members: string[] }[];
    changedFiles?: string[];
    scenario: "Approved" | "Is missing approval" | "Has no approval";
    preventReviewRequest?: Configuration["prevent-review-request"];
    rules?: Configuration["rules"];
  }) => {
    const { scenario, preventReviewRequest } = options;
    let { users, diff, teams, rules, changedFiles } = options;

    users ??= coworkers;
    diff ??= condition;
    teams ??= [{ name: team, members: users }];
    changedFiles ??= [condition];
    rules ??= [];

    nock(githubApi)
      .get(reviewsApiPath)
      .reply(
        200,
        scenario === "Approved"
          ? users.map((login, id) => {
              return { id, user: { id, login }, state: "APPROVED" };
            })
          : scenario === "Is missing approval"
          ? [{ id: 1, user: { id: 1, login: coworkers[0] }, state: "APPROVED" }]
          : [],
      );

    for (const { name, members } of teams) {
      teamMembers.set(name, members);
      nock(githubApi)
        .get(`/orgs/${org}/teams/${name}/members?per_page=${maxGithubApiTeamMembersPerPage}`)
        .reply(
          200,
          members.map((login, id) => {
            return { id, login };
          }),
        );
    }

    nock(githubApi)
      .get(changedFilesApiPath)
      .reply(
        200,
        changedFiles.map((filename) => {
          return { filename };
        }),
      );

    nock(githubApi).get(prApiPath).matchHeader("accept", "application/vnd.github.v3.diff").reply(200, diff);

    nock(githubApi)
      .get(configFileContentsApiPath)
      .reply(200, {
        content: Buffer.from(
          YAML.stringify({ ...defaultTeamsNames, rules, "prevent-review-request": preventReviewRequest }),
        ).toString("base64"),
      });
  };

  for (const scenario of ["Approved", "Is missing approval", "Has no approval"] as const) {
    for (const checkType of ["diff", "changed_files"] as const) {
      it(`${scenario} on rule including only users for ${checkType}`, async () => {
        setup({
          scenario,
          rules: [
            {
              name: condition,
              condition,
              check_type: checkType,
              min_approvals: coworkers.length,
              users: [coworkers[0], coworkers[1]],
            },
          ],
        });

        switch (scenario) {
          case "Has no approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, (body) => {
                expect(body).toMatchObject({ reviewers: coworkers, team_reviewers: [] });
                return true;
              })
              .reply(201);
            break;
          }
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, (body) => {
                expect(body).toMatchObject({ reviewers: [coworkers[1]], team_reviewers: [] });
                return true;
              })
              .reply(201);
            break;
          }
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });

      it(`${scenario} on rule including only teams for ${checkType}`, async () => {
        setup({
          scenario,
          rules: [
            { name: condition, condition, check_type: checkType, min_approvals: coworkers.length, teams: [team] },
          ],
        });

        if (scenario !== "Approved") {
          nock(githubApi)
            .post(requestedReviewersApiPath, (body) => {
              expect(body).toMatchObject({ reviewers: [], team_reviewers: [team] });
              return true;
            })
            .reply(201);
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });

      it(`${scenario} on rule including both teams and users for ${checkType}`, async () => {
        const userAskedIndividually = coworkers[1];

        setup({
          scenario,
          rules: [
            {
              name: condition,
              condition,
              check_type: checkType,
              min_approvals: coworkers.length,
              users: [userAskedIndividually],
              teams: [team],
            },
          ],
          ...(scenario === "Is missing approval" ? { users: coworkers.concat(userCoworker3) } : {}),
        });

        if (scenario !== "Approved") {
          nock(githubApi)
            .post(requestedReviewersApiPath, (body) => {
              /*
                This user will be asked individually even though they are
                member of the team because they were specified individually in
                the "users" configuration
              */
              expect(teamMembers.get(team)!.find((member) => member === userAskedIndividually)).toBe(
                userAskedIndividually,
              );
              expect(body).toMatchObject({ reviewers: [userAskedIndividually], team_reviewers: [team] });
              return true;
            })
            .reply(201);
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });

      it(`${scenario} on rule not specifying users or teams`, async () => {
        setup({
          scenario,
          rules: [{ name: condition, condition, check_type: checkType, min_approvals: coworkers.length }],
          ...(scenario === "Is missing approval" ? { users: coworkers.concat(userCoworker3) } : {}),
        });

        if (scenario !== "Approved") {
          nock(githubApi)
            .post(requestedReviewersApiPath, (body) => {
              expect(body).toMatchObject({ reviewers: coworkers, team_reviewers: [team] });
              return true;
            })
            .reply(201);
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });

      for (const [ruleKind, ruleField] of [
        ["AndRule", "all"],
        ["AndDistinctRule", "all_distinct"],
        ["OrRule", "any"],
      ] as const) {
        it(`Rule kind ${ruleKind}: ${scenario} specifying only users for ${checkType}`, async () => {
          setup({
            scenario,
            rules: [
              {
                name: condition,
                condition,
                check_type: checkType,
                [ruleField]: [
                  { min_approvals: 1, users: [coworkers[0]] },
                  { min_approvals: 1, users: [coworkers[1]] },
                ],
              } as Rule,
            ],
          });

          let expected: "success" | "failure";
          switch (ruleKind) {
            case "AndDistinctRule":
            case "AndRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, (body) => {
                    expect(body).toMatchObject({
                      reviewers: scenario === "Has no approval" ? coworkers : [coworkers[1]],
                      team_reviewers: [],
                    });
                    return true;
                  })
                  .reply(201);
              }
              expected = scenario === "Approved" ? "success" : "failure";
              break;
            }
            case "OrRule": {
              if (scenario === "Has no approval") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, (body) => {
                    expect(body).toMatchObject({ reviewers: coworkers, team_reviewers: [] });
                    return true;
                  })
                  .reply(201);
              }
              expected = scenario === "Has no approval" ? "failure" : "success";
              break;
            }
            default: {
              const exhaustivenessCheck: never = ruleKind;
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new Error(`Unhandled rule kind ${exhaustivenessCheck}`);
            }
          }

          const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
          expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(expected);

          expect(logHistory).toMatchSnapshot();
        });

        it(`Rule kind ${ruleKind}: ${scenario} specifying only teams for ${checkType}`, async () => {
          setup({
            scenario,
            teams: [
              { name: team, members: scenario === "Has no approval" ? [coworkers[1]] : [coworkers[0]] },
              { name: team2, members: [coworkers[1]] },
            ],
            rules: [
              {
                name: condition,
                condition,
                check_type: checkType,
                [ruleField]: [
                  { min_approvals: 1, teams: [team] },
                  { min_approvals: 1, teams: [team2] },
                ],
              } as Rule,
            ],
          });

          let expectedCheckOutcome: "success" | "failure";
          switch (ruleKind) {
            case "AndDistinctRule":
            case "AndRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, (body) => {
                    expect(body).toMatchObject({
                      reviewers: [],
                      team_reviewers: scenario === "Is missing approval" ? [team2] : [team, team2],
                    });
                    return true;
                  })
                  .reply(201);
              }
              expectedCheckOutcome = scenario === "Approved" ? "success" : "failure";
              break;
            }
            case "OrRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, (body) => {
                    expect(body).toMatchObject({
                      reviewers: [],
                      team_reviewers: scenario === "Is missing approval" ? [team2] : [team, team2],
                    });
                    return true;
                  })
                  .reply(201);
              }
              expectedCheckOutcome = scenario === "Has no approval" ? "failure" : "success";
              break;
            }
            default: {
              const exhaustivenessCheck: never = ruleKind;
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new Error(`Unhandled rule kind ${exhaustivenessCheck}`);
            }
          }

          const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
          expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
            expectedCheckOutcome,
          );

          expect(logHistory).toMatchSnapshot();
        });

        it(`Rule kind ${ruleKind}: ${scenario} specifying both teams and users for ${checkType}`, async () => {
          setup({
            scenario,
            users: coworkers.concat(userCoworker3),
            teams: [
              { name: team, members: scenario === "Has no approval" ? [coworkers[1]] : [coworkers[0]] },
              { name: team2, members: [coworkers[1]] },
            ],
            rules: [
              {
                name: condition,
                condition,
                check_type: checkType,
                [ruleField]: [
                  { min_approvals: 1, teams: [team] },
                  { min_approvals: 1, teams: [team2] },
                  { min_approvals: 1, users: [userCoworker3] },
                ],
              } as Rule,
            ],
          });

          let expectedCheckOutcome: "success" | "failure";
          switch (ruleKind) {
            case "AndDistinctRule":
            case "AndRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, (body) => {
                    expect(body).toMatchObject({
                      reviewers: [userCoworker3],
                      team_reviewers: scenario === "Is missing approval" ? [team2] : [team, team2],
                    });
                    return true;
                  })
                  .reply(201);
              }
              expectedCheckOutcome = scenario === "Approved" ? "success" : "failure";
              break;
            }
            case "OrRule": {
              if (scenario !== "Approved") {
                nock(githubApi)
                  .post(requestedReviewersApiPath, (body) => {
                    expect(body).toMatchObject({
                      reviewers: [userCoworker3],
                      team_reviewers: scenario === "Is missing approval" ? [team2] : [team, team2],
                    });
                    return true;
                  })
                  .reply(201);
              }
              expectedCheckOutcome = scenario === "Has no approval" ? "failure" : "success";
              break;
            }
            default: {
              const exhaustivenessCheck: never = ruleKind;
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new Error(`Unhandled rule kind ${exhaustivenessCheck}`);
            }
          }

          const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
          expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
            expectedCheckOutcome,
          );

          expect(logHistory).toMatchSnapshot();
        });
      }

      for (const [description, rule] of [
        ["condition: include", { name: "Condition include", condition: { include: condition } }],
        ["condition: exclude", { name: "Condition exclude", condition: { exclude: condition } }],
        [
          "condition: include & exclude",
          { name: "Condition include & exclude", condition: { include: condition, exclude: condition } },
        ],
      ] as const) {
        it(`${scenario} with ${description} for ${checkType}`, async () => {
          setup({ scenario, rules: [{ ...rule, min_approvals: 2, check_type: checkType }] });

          switch (scenario) {
            case "Has no approval":
            case "Is missing approval": {
              nock(githubApi)
                .post(requestedReviewersApiPath, (body) => {
                  expect(body).toMatchObject({ reviewers: [coworkers[1]] });
                  return true;
                })
                .reply(201);
              break;
            }
          }

          const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
          expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
            scenario === "Approved" ||
              description === "condition: exclude" ||
              description === "condition: include & exclude"
              ? "success"
              : "failure",
          );

          expect(logHistory).toMatchSnapshot();
        });
      }
    }

    for (const diffSign of ["+", "-"]) {
      it(`${scenario} when lock line is modified (${diffSign})`, async () => {
        setup({
          scenario,
          diff: `${diffSign}🔒 deleting the lock line`,
          teams: [
            { name: team, members: [coworkers[0]] },
            { name: team2, members: [coworkers[1]] },
          ],
        });

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, (body) => {
                expect(body).toMatchObject({
                  reviewers: [],
                  team_reviewers: scenario === "Has no approval" ? [team, team2] : [team2],
                });
                return true;
              })
              .reply(201);
            break;
          }
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });

      it(`${scenario} when line after lock is modified (${diffSign})`, async () => {
        setup({
          scenario,
          diff: `🔒 lock line\n${diffSign} modified`,
          teams: [
            { name: team, members: [coworkers[0]] },
            { name: team2, members: [coworkers[1]] },
          ],
        });

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, (body) => {
                expect(body).toMatchObject({
                  reviewers: [],
                  team_reviewers: scenario === "Has no approval" ? [team, team2] : [team2],
                });
                return true;
              })
              .reply(201);
            break;
          }
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });
    }

    for (const actionReviewFile of actionReviewTeamFiles) {
      it(`${scenario} when ${actionReviewFile} is changed`, async () => {
        setup({ scenario, changedFiles: [actionReviewFile], teams: [{ name: team3, members: [coworkers[1]] }] });

        switch (scenario) {
          case "Has no approval":
          case "Is missing approval": {
            nock(githubApi)
              .post(requestedReviewersApiPath, (body) => {
                expect(body).toMatchObject({ reviewers: [], team_reviewers: [team3] });
                return true;
              })
              .reply(201);
            break;
          }
        }

        const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
          scenario === "Approved" ? "success" : "failure",
        );

        expect(logHistory).toMatchSnapshot();
      });
    }

    it(`${scenario} for AndDistinctRule when user belongs to multiple teams`, async () => {
      setup({
        scenario,
        rules: [
          {
            name: condition,
            condition: condition,
            check_type: "diff",
            all_distinct: [
              { min_approvals: 1, teams: [team] },
              { min_approvals: 1, teams: [team2] },
            ],
          },
        ],
        teams: [
          { name: team, members: [coworkers[0]] },
          { name: team2, members: [coworkers[0], coworkers[1]] },
        ],
      });

      switch (scenario) {
        case "Has no approval":
        case "Is missing approval": {
          nock(githubApi)
            .post(requestedReviewersApiPath, (body) => {
              expect(body).toMatchObject({
                reviewers: [],
                team_reviewers: scenario === "Has no approval" ? [team, team2] : [team2],
              });
              return true;
            })
            .reply(201);
          break;
        }
      }

      const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
      expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe(
        scenario === "Approved" ? "success" : "failure",
      );

      expect(logHistory).toMatchSnapshot();
    });
  }

  for (const variant of ["user", "team"]) {
    it(`Reviews are not requested if prevent_review_requests is set for ${variant}`, async () => {
      setup({
        scenario: "Has no approval",
        changedFiles: actionReviewTeamFiles,
        teams: [{ name: defaultTeamsNames["action-review-team"], members: coworkers }],
        preventReviewRequest: { users: coworkers, teams: Object.values(defaultTeamsNames) },
      });

      const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
      expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe("failure");

      expect(logHistory).toMatchSnapshot();
    });
  }

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("Counts author as an approved review", async () => {
    setup({
      scenario: "Approved",
      changedFiles: ["readme.md"],
      rules: [
        {
          name: "File changed",
          condition: ".*",
          check_type: "changed_files",
          ["all"]: [{ min_approvals: 1, users: [user] }],
        } as Rule,
      ],
    });

    const api = new GitHubApi(basePR, { logger, finishProcessReviews: null, octokit });
    expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null }, api)).toBe("success");
  });
});
