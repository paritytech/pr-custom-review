import { OctokitResponse } from "@octokit/types"
import assert from "assert"
import YAML from "yaml"

import {
  actionReviewTeamFiles,
  commitStateFailure,
  commitStateSuccess,
  configFilePath,
  maxGithubApiFilesPerPage,
  maxGithubApiReviewsPerPage,
  maxGithubApiTeamMembersPerPage,
} from "./constants"
import { ActionData } from "./github/action/types"
import { CommitState } from "./github/types"
import {
  BaseRule,
  Context,
  MatchedRule,
  PR,
  RuleCriteria,
  RuleFailure,
  RuleKind,
  RuleSuccess,
  RuleUserInfo,
} from "./types"
import { configurationSchema } from "./validation"

type TeamsCache = Map<
  string /* Team slug */,
  string[] /* Usernames of team members */
>
const combineUsers = async (
  { octokit }: Context,
  pr: PR,
  presetUsers: string[],
  teams: string[],
  teamsCache: TeamsCache,
) => {
  const users: Map<string, RuleUserInfo> = new Map()

  for (const user of presetUsers) {
    if (pr.user.login != user) {
      users.set(user, { ...users.get(user), teams: null })
    }
  }

  for (const team of teams) {
    let teamMembers = teamsCache.get(team)

    if (teamMembers === undefined) {
      teamMembers = await octokit.paginate(
        octokit.rest.teams.listMembersInOrg,
        {
          org: pr.base.repo.owner.login,
          team_slug: team,
          per_page: maxGithubApiTeamMembersPerPage,
        },
        (response) => {
          return response.data.map(({ login }) => {
            return login
          })
        },
      )
      teamsCache.set(team, teamMembers)
    }

    for (const teamMember of teamMembers) {
      let userInfo = users.get(teamMember)
      if (userInfo === undefined) {
        userInfo = { teams: new Set([team]), teamsHistory: new Set([team]) }
        users.set(teamMember, userInfo)
      } else if (userInfo.teamsHistory === undefined) {
        userInfo.teamsHistory = new Set([team])
      } else {
        userInfo.teamsHistory.add(team)
      }
      if (
        pr.user.login != teamMember &&
        /*
          We do not want to register a team for this user if their approval is
          supposed to be requested individually
        */
        userInfo.teams !== null
      ) {
        userInfo.teams.add(team)
      }
    }
  }

  return users
}

/*
  This function should only depend on its inputs so that it can be tested
  without inconveniences. If you need more external input then pass it as a
  function argument.
*/
export const runChecks = async ({ pr, ...ctx }: Context & { pr: PR }) => {
  const { octokit, logger } = ctx

  const configFileResponse = await octokit.rest.repos.getContent({
    owner: pr.base.repo.owner.login,
    repo: pr.base.repo.name,
    path: configFilePath,
  })
  if (!("content" in configFileResponse.data)) {
    logger.fatal(
      `Did not find "content" key in the response for ${configFilePath}`,
    )
    logger.info(configFileResponse.data)
    return commitStateFailure
  }

  const { content: configFileContentsEnconded } = configFileResponse.data
  if (typeof configFileContentsEnconded !== "string") {
    logger.fatal(
      `Content response for ${configFilePath} had unexpected type (expected string)`,
    )
    logger.info(configFileResponse.data)
    return commitStateFailure
  }

  const configFileContents = Buffer.from(
    configFileContentsEnconded,
    "base64",
  ).toString("utf-8")

  const configValidationResult = configurationSchema.validate(
    YAML.parse(configFileContents),
  )
  if (configValidationResult.error) {
    logger.fatal("Configuration file is invalid")
    logger.info(configValidationResult.error)
    return commitStateFailure
  }

  const {
    "locks-review-team": locksReviewTeam,
    "team-leads-team": teamLeadsTeam,
    "action-review-team": actionReviewTeam,
    rules,
    "prevent-review-request": preventReviewRequest,
  } = configValidationResult.value

  /*
    Set up a teams cache so that teams used multiple times don't have to be
    requested more than once
  */
  const teamsCache: TeamsCache = new Map()

  const diffResponse = (await octokit.rest.pulls.get({
    owner: pr.base.repo.owner.login,
    repo: pr.base.repo.name,
    pull_number: pr.number,
    mediaType: { format: "diff" },
  })) /* Octokit doesn't inform the right return type for mediaType: { format: "diff" } */ as unknown as OctokitResponse<string>
  const { data: diff } = diffResponse

  const matchedRules: MatchedRule[] = []
  let nextMatchedRuleId = -1

  // Built in condition to search files with changes to locked lines
  const lockExpression = /🔒[^\n]*\n[+|-]|(^|\n)[+|-][^\n]*🔒/
  if (lockExpression.test(diff)) {
    logger.info("Diff has changes to 🔒 lines or lines following 🔒")
    const users = await combineUsers(
      ctx,
      pr,
      [],
      [locksReviewTeam, teamLeadsTeam],
      teamsCache,
    )
    const subconditions = [
      {
        min_approvals: 1,
        teams: [locksReviewTeam],
        name: `Locks Reviewers Approvals (team ${locksReviewTeam})`,
      },
      {
        min_approvals: 1,
        teams: [teamLeadsTeam],
        name: `Team Leads Approvals (team ${teamLeadsTeam})`,
      },
    ]
    matchedRules.push({
      name: "Locks touched",
      kind: "AndDistinctRule",
      users,
      id: ++nextMatchedRuleId,
      min_approvals: subconditions.reduce((acc, { min_approvals }) => {
        return acc + min_approvals
      }, 0),
      subconditions,
    })
  }

  const changedFiles = new Set(
    (
      await octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner: pr.base.repo.owner.login,
          repo: pr.base.repo.name,
          pull_number: pr.number,
          per_page: maxGithubApiFilesPerPage,
        },
      )
    ).map(({ filename }) => {
      return filename
    }),
  )
  logger.info("Changed files", changedFiles)

  for (const actionReviewFile of actionReviewTeamFiles) {
    if (changedFiles.has(actionReviewFile)) {
      const users = await combineUsers(
        ctx,
        pr,
        [],
        [actionReviewTeam],
        teamsCache,
      )
      matchedRules.push({
        name: "Action files changed",
        min_approvals: 1,
        kind: "BasicRule",
        users,
        id: ++nextMatchedRuleId,
      })
      break
    }
  }

  const processComplexRule = async (
    id: MatchedRule["id"],
    name: string,
    kind: RuleKind,
    subconditions: RuleCriteria[],
  ) => {
    switch (kind) {
      case "AndDistinctRule": {
        const users = await combineUsers(
          ctx,
          pr,
          subconditions
            .map(({ users: subconditionUsers }) => {
              return subconditionUsers ?? []
            })
            .flat(),
          subconditions
            .map(({ teams }) => {
              return teams ?? []
            })
            .flat(),
          teamsCache,
        )
        matchedRules.push({
          name: name,
          users,
          kind,
          id,
          subconditions,
          min_approvals: subconditions.reduce((acc, { min_approvals }) => {
            return acc + min_approvals
          }, 0),
        })
        break
      }
      case "BasicRule":
      case "OrRule":
      case "AndRule": {
        let conditionIndex = -1
        for (const subcondition of subconditions) {
          const users = await combineUsers(
            ctx,
            pr,
            subcondition.users ?? [],
            subcondition.teams ?? [],
            teamsCache,
          )
          matchedRules.push({
            name: `${name}[${++conditionIndex}]`,
            min_approvals: subcondition.min_approvals,
            users,
            kind,
            id,
          })
        }
        break
      }
      default: {
        const exhaustivenessCheck: never = kind
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        const failureMessage = `Rule kind is not handled: ${exhaustivenessCheck}`
        logger.fatal(failureMessage)
        throw new Error(failureMessage)
      }
    }
  }

  for (const rule of rules) {
    const includeCondition = (() => {
      switch (typeof rule.condition) {
        case "string": {
          return new RegExp(rule.condition, "gm")
        }
        case "object": {
          assert(rule.condition)
          return new RegExp(
            "include" in rule.condition ? rule.condition.include : ".*",
            "gm",
          )
        }
        default: {
          throw new Error(
            `Unexpected type "${typeof rule.condition}" for rule "${
              rule.name
            }"`,
          )
        }
      }
    })()

    const excludeCondition =
      typeof rule.condition === "object" &&
      rule.condition !== null &&
      "exclude" in rule.condition
        ? new RegExp(rule.condition.exclude)
        : undefined

    let isMatched = false
    switch (rule.check_type) {
      case "changed_files": {
        changedFilesLoop: for (const file of changedFiles) {
          isMatched =
            includeCondition.test(file) && !excludeCondition?.test(file)
          if (isMatched) {
            logger.info(
              `Matched expression "${
                typeof rule.condition === "string"
                  ? rule.condition
                  : JSON.stringify(rule.condition)
              }" of rule "${rule.name}" for the file ${file}`,
            )
            break changedFilesLoop
          }
        }
        break
      }
      case "diff": {
        isMatched = includeCondition.test(diff) && !excludeCondition?.test(diff)
        if (isMatched) {
          logger.info(
            `Matched expression "${
              typeof rule.condition === "string"
                ? rule.condition
                : JSON.stringify(rule.condition)
            }" of rule "${rule.name}" on diff`,
          )
        }
        break
      }
      default: {
        const exhaustivenessCheck: never = rule.check_type
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        logger.fatal(`Check type is not handled: ${exhaustivenessCheck}`)
        return commitStateFailure
      }
    }
    if (!isMatched) {
      continue
    }

    if (/* BasicRule */ "min_approvals" in rule) {
      if (typeof rule.min_approvals !== "number") {
        logger.fatal(`Rule "${rule.name}" has invalid min_approvals`)
        logger.info(rule)
        return commitStateFailure
      }

      const users = await combineUsers(
        ctx,
        pr,
        rule.users ?? [],
        rule.teams ?? [],
        teamsCache,
      )

      matchedRules.push({
        name: rule.name,
        min_approvals: rule.min_approvals,
        users,
        kind: "BasicRule",
        id: ++nextMatchedRuleId,
      })
    } else if (/* AndRule */ "all" in rule) {
      await processComplexRule(
        ++nextMatchedRuleId,
        rule.name,
        "AndRule",
        rule.all,
      )
    } else if (/* OrRule */ "any" in rule) {
      await processComplexRule(
        ++nextMatchedRuleId,
        rule.name,
        "OrRule",
        rule.any,
      )
    } else if (/* AndDistinctRule */ "all_distinct" in rule) {
      await processComplexRule(
        ++nextMatchedRuleId,
        rule.name,
        "AndDistinctRule",
        rule.all_distinct,
      )
    } else {
      const unmatchedRule = rule as BaseRule
      throw new Error(
        `Rule "${unmatchedRule.name}" could not be matched to any known kind`,
      )
    }
  }

  if (matchedRules.length !== 0) {
    const reviews = await octokit.paginate(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        pull_number: pr.number,
        per_page: maxGithubApiReviewsPerPage,
      },
    )

    const latestReviews: Map<
      number,
      { id: number; user: string; isApproval: boolean }
    > = new Map()
    for (const review of reviews) {
      // https://docs.github.com/en/graphql/reference/enums#pullrequestreviewstate
      if (
        // Comments do not affect the approval's status
        review.state === "COMMENTED" ||
        // The user might've been deleted
        review.user === null ||
        review.user === undefined
      ) {
        continue
      }
      const prevReview = latestReviews.get(review.user.id)
      if (
        prevReview === undefined ||
        // The latest review is the one with the highest id
        prevReview.id < review.id
      ) {
        latestReviews.set(review.user.id, {
          id: review.id,
          user: review.user.login,
          isApproval: review.state === "APPROVED",
        })
      }
    }
    logger.info("latestReviews", latestReviews.values())

    const rulesOutcomes: Map<MatchedRule["id"], (RuleSuccess | RuleFailure)[]> =
      new Map()

    let highestMinApprovalsRule: MatchedRule | null = null
    for (const rule of matchedRules) {
      const outcomes = rulesOutcomes.get(rule.id) ?? []

      if (rule.users.size !== 0) {
        const approvedBy: Set<string> = new Set()

        for (const review of latestReviews.values()) {
          if (rule.users.has(review.user) && review.isApproval) {
            approvedBy.add(review.user)
          }
        }

        if (rule.kind === "AndDistinctRule") {
          const ruleApprovedBy: Set<string> = new Set()
          const usersPendingApprovals: Set<string> = new Set()

          subconditionsLoop: for (const subcondition of rule.subconditions) {
            for (const user of subcondition.users ?? []) {
              if (approvedBy.has(user)) {
                ruleApprovedBy.add(user)
                if (ruleApprovedBy.size === rule.min_approvals) {
                  usersPendingApprovals.clear()
                  break subconditionsLoop
                }
              } else {
                usersPendingApprovals.add(user)
              }
            }

            for (const team of subcondition.teams ?? []) {
              for (const [user, userInfo] of rule.users) {
                if (userInfo?.teamsHistory?.has(team)) {
                  if (approvedBy.has(user)) {
                    ruleApprovedBy.add(user)
                    if (ruleApprovedBy.size === rule.min_approvals) {
                      usersPendingApprovals.clear()
                      break subconditionsLoop
                    }
                  } else {
                    usersPendingApprovals.add(user)
                  }
                }
              }
            }
          }

          if (usersPendingApprovals.size === 0) {
            outcomes.push(new RuleSuccess(rule))
          } else {
            const usersToAskForReview: Map<string, RuleUserInfo> = new Map(
              Array.from(rule.users.entries()).filter(([username]) => {
                return usersPendingApprovals.has(username)
              }),
            )
            const problem = `Rule "${rule.name}" needs in total ${
              rule.min_approvals
            } DISTINCT approvals, but ${
              ruleApprovedBy.size
            } were given. Users whose approvals counted towards one criterion are excluded from other criteria. For example: even if a user belongs multiple teams, their approval will only count towards one of them; or even if a user is referenced in multiple subconditions, their approval will only count towards one subcondition. The following users have not approved yet: ${Array.from(
              usersToAskForReview.entries(),
            )
              .map(([username, { teams }]) => {
                return `${username}${
                  teams
                    ? ` (team${teams.size === 1 ? "" : "s"}: ${Array.from(
                        teams,
                      ).join(", ")})`
                    : ""
                }`
              })
              .join(", ")}.`
            outcomes.push(new RuleFailure(rule, problem, usersToAskForReview))
          }
        } else if (approvedBy.size < rule.min_approvals) {
          const usersToAskForReview: Map<string, RuleUserInfo> = new Map(
            Array.from(rule.users.entries()).filter(([username]) => {
              return !approvedBy.has(username)
            }),
          )
          const problem = `Rule "${rule.name}" needs at least ${
            rule.min_approvals
          } approvals, but ${
            approvedBy.size
          } were matched. The following users have not approved yet: ${Array.from(
            usersToAskForReview.entries(),
          )
            .map(([username, { teams }]) => {
              return `${username}${
                teams
                  ? ` (team${teams.size === 1 ? "" : "s"}: ${Array.from(
                      teams,
                    ).join(", ")})`
                  : ""
              }`
            })
            .join(", ")}.`
          outcomes.push(new RuleFailure(rule, problem, usersToAskForReview))
        } else {
          outcomes.push(new RuleSuccess(rule))
        }

        rulesOutcomes.set(rule.id, outcomes)
      } else if (
        highestMinApprovalsRule === null ||
        highestMinApprovalsRule.min_approvals < rule.min_approvals
      ) {
        highestMinApprovalsRule = rule
      }
    }

    const problems: string[] = []
    const usersToAskForReview: Map<string, RuleUserInfo> = new Map()

    toNextOutcomes: for (const outcomes of rulesOutcomes.values()) {
      const pendingUsersToAskForReview: Map<string, RuleUserInfo> = new Map()
      const pendingProblems: string[] = []
      for (const outcome of outcomes) {
        if (outcome instanceof RuleSuccess) {
          switch (outcome.rule.kind) {
            case "BasicRule":
            case "OrRule": {
              continue toNextOutcomes
            }
            case "AndRule":
            case "AndDistinctRule": {
              // Those rules require the outcomes of other rules to be decided
              break
            }
          }
        } else if (outcome instanceof RuleFailure) {
          pendingProblems.push(outcome.problem)
          for (const [username, userInfo] of outcome.usersToAskForReview) {
            const prevUser = pendingUsersToAskForReview.get(username)
            if (
              prevUser === undefined ||
              /*
                If the team is null, this user was not asked as part of a team,
                but individually. They should always be registered with "team:
                null" that case to be sure the review will be requested
                individually, even if they were previously registered as part
                of a team.
              */
              userInfo.teams === null
            ) {
              pendingUsersToAskForReview.set(username, {
                teams: userInfo.teams,
              })
            } else if (prevUser.teams) {
              for (const team of userInfo.teams) {
                prevUser.teams.add(team)
              }
            } else {
              prevUser.teams = userInfo.teams
            }
          }
        } else {
          logger.fatal("Unable to process unexpected rule outcome")
          logger.info(outcome)
          return commitStateFailure
        }
      }
      for (const pendingProblem of pendingProblems) {
        problems.push(pendingProblem)
      }
      for (const [username, userInfo] of pendingUsersToAskForReview) {
        const prevUser = usersToAskForReview.get(username)
        if (
          prevUser === undefined ||
          /*
            If the team is null, this user was not asked as part of a team, but
            individually. They should always be registered with "team: null" in
            that case to be sure the review will be requested individually,
            even if they were previously registered as part of a team.
          */
          userInfo.teams === null
        ) {
          usersToAskForReview.set(username, { teams: userInfo.teams })
        } else if (prevUser.teams) {
          for (const team of userInfo.teams) {
            prevUser.teams.add(team)
          }
        } else {
          prevUser.teams = userInfo.teams
        }
      }
    }

    if (usersToAskForReview.size !== 0) {
      logger.info("usersToAskForReview", usersToAskForReview)
      const teams: Set<string> = new Set()
      const users: Set<string> = new Set()
      for (const [user, userInfo] of usersToAskForReview) {
        if (userInfo.teams === null) {
          if (!preventReviewRequest?.users?.includes(user)) {
            users.add(user)
          }
        } else {
          for (const team of userInfo.teams) {
            if (!preventReviewRequest?.teams?.includes(team)) {
              teams.add(team)
            }
          }
        }
      }
      if (users.size || teams.size) {
        await octokit.request(
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
          {
            owner: pr.base.repo.owner.login,
            repo: pr.base.repo.name,
            pull_number: pr.number,
            reviewers: Array.from(users),
            team_reviewers: Array.from(teams),
          },
        )
      }
    }

    if (highestMinApprovalsRule !== null) {
      let approvalCount = 0
      for (const review of latestReviews.values()) {
        if (review.isApproval) {
          approvalCount++
        }
      }
      if (approvalCount < highestMinApprovalsRule.min_approvals) {
        problems.push(
          `Rule ${highestMinApprovalsRule.name} requires at least ${highestMinApprovalsRule.min_approvals} approvals, but only ${approvalCount} were given`,
        )
      }
    }

    if (problems.length !== 0) {
      logger.fatal("The following problems were found:")
      for (const problem of problems) {
        logger.info(problem)
      }
      logger.info("")
      return commitStateFailure
    }
  }

  return commitStateSuccess
}

export const getFinishProcessReviews = (
  { octokit, logger }: Omit<Context, "finishProcessReviews">,
  { jobName, detailsUrl, pr, runId, actionRepository }: ActionData,
) => {
  return async (state: CommitState) => {
    // Fallback URL in case we are not able to detect the current job
    if (state === "failure" && jobName !== undefined) {
      /*
        Fetch the jobs so that we'll be able to detect this step and provide a
        more accurate logging location
      */
      const {
        data: { jobs },
      } = await octokit.rest.actions.listJobsForWorkflowRun({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        run_id: runId,
      })
      for (const job of jobs) {
        if (job.name === jobName) {
          let stepNumber: number | undefined = undefined
          if (actionRepository !== undefined) {
            const actionRepositoryMatch = actionRepository.match(/[^/]*$/)
            if (actionRepositoryMatch === null) {
              logger.warn(
                `Action repository name could not be extracted from ${actionRepository}`,
              )
            } else {
              const actionStep = job.steps?.find(({ name }) => {
                return name === actionRepositoryMatch[0]
              })
              if (actionStep === undefined) {
                logger.warn(
                  `Failed to find ${actionRepositoryMatch[0]} in the job's steps`,
                  job.steps,
                )
              } else {
                stepNumber = actionStep.number
              }
            }
          }
          detailsUrl = `${job.html_url as string}${
            stepNumber
              ? `#step:${stepNumber}:${logger.relevantStartingLine}`
              : ""
          }`
          break
        }
      }
    }

    await octokit.rest.repos.createCommitStatus({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      sha: pr.head.sha,
      state,
      context: "Check reviews",
      target_url: detailsUrl,
      description: "Please visit Details for more information",
    })

    logger.info(`Final state: ${state}`)
  }
}

export const processReviews = async (ctx: Context, { pr }: ActionData) => {
  const { finishProcessReviews, logger } = ctx
  return runChecks({ ...ctx, pr })
    .then((state) => {
      if (finishProcessReviews) {
        return finishProcessReviews(state)
      }
    })
    .catch((error) => {
      logger.fatal(error)
      if (finishProcessReviews) {
        return finishProcessReviews("failure")
      }
    })
}
