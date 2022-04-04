import { OctokitResponse } from "@octokit/types"
import assert from "assert"
import YAML from "yaml"

import {
  actionReviewTeamFiles,
  commitStateFailure,
  commitStateSuccess,
  configFilePath,
  maxGithubApiFilesPerPage,
  maxGithubApiTeamMembersPerPage,
} from "./constants"
import { LoggerInterface } from "./logger"
import {
  BaseRule,
  MatchedRule,
  Octokit,
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
const combineUsers = async function (
  pr: PR,
  octokit: Octokit,
  presetUsers: string[],
  teams: string[],
  teamsCache: TeamsCache,
) {
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
        function (response) {
          return response.data.map(function ({ login }) {
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
        // We do not want to register a team for this user if their approval is
        // supposed to be requested individually
        userInfo.teams !== null
      ) {
        userInfo.teams.add(team)
      }
    }
  }

  return users
}

// This function should only depend on its inputs so that it can be tested
// without inconveniences. If you need more external input then pass it as a
// function argument.
export const runChecks = async function (
  pr: PR,
  octokit: Octokit,
  logger: LoggerInterface,
) {
  const configFileResponse = await octokit.rest.repos.getContent({
    owner: pr.base.repo.owner.login,
    repo: pr.base.repo.name,
    path: configFilePath,
  })
  if (!("content" in configFileResponse.data)) {
    logger.failure(
      `Did not find "content" key in the response for ${configFilePath}`,
    )
    logger.log(configFileResponse.data)
    return commitStateFailure
  }

  const { content: configFileContentsEnconded } = configFileResponse.data
  if (typeof configFileContentsEnconded !== "string") {
    logger.failure(
      `Content response for ${configFilePath} had unexpected type (expected string)`,
    )
    logger.log(configFileResponse.data)
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
    logger.failure("Configuration file is invalid")
    logger.log(configValidationResult.error)
    return commitStateFailure
  }

  const {
    "locks-review-team": locksReviewTeam,
    "team-leads-team": teamLeadsTeam,
    "action-review-team": actionReviewTeam,
    rules,
    "prevent-review-request": preventReviewRequest,
  } = configValidationResult.value

  // Set up a teams cache so that teams used multiple times don't have to be
  // requested more than once
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
    logger.log("Diff has changes to 🔒 lines or lines following 🔒")
    const users = await combineUsers(
      pr,
      octokit,
      [],
      [locksReviewTeam, teamLeadsTeam],
      teamsCache,
    )
    const subConditions = [
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
      min_approvals: subConditions
        .map(({ min_approvals }) => min_approvals)
        .reduce((acc, val) => acc + val, 0),
      subConditions,
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
    ).map(function ({ filename }) {
      return filename
    }),
  )
  logger.log("Changed files", changedFiles)

  for (const actionReviewFile of actionReviewTeamFiles) {
    if (changedFiles.has(actionReviewFile)) {
      const users = await combineUsers(
        pr,
        octokit,
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

  const processComplexRule = async function (
    id: MatchedRule["id"],
    name: string,
    kind: RuleKind,
    subConditions: RuleCriteria[],
  ) {
    switch (kind) {
      case "AndDistinctRule": {
        const users = await combineUsers(
          pr,
          octokit,
          subConditions.map(({ users }) => users ?? []).flat(),
          subConditions.map(({ teams }) => teams ?? []).flat(),
          teamsCache,
        )
        matchedRules.push({
          name: name,
          users,
          kind,
          id,
          subConditions,
          min_approvals: subConditions
            .map(({ min_approvals }) => min_approvals)
            .reduce((acc, val) => acc + val, 0),
        })
        break
      }
      case "BasicRule":
      case "OrRule":
      case "AndRule": {
        let conditionIndex = -1
        for (const subCondition of subConditions) {
          const users = await combineUsers(
            pr,
            octokit,
            subCondition.users ?? [],
            subCondition.teams ?? [],
            teamsCache,
          )
          matchedRules.push({
            name: `${name}[${++conditionIndex}]`,
            min_approvals: subCondition.min_approvals,
            users,
            kind,
            id,
          })
        }
        break
      }
      default: {
        const exhaustivenessCheck: never = kind
        const failureMessage = `Rule kind is not handled: ${exhaustivenessCheck}`
        logger.failure(failureMessage)
        throw new Error(failureMessage)
      }
    }
  }

  for (const rule of rules) {
    const includeCondition = (function () {
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
            logger.log(
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
          logger.log(
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
        logger.failure(`Check type is not handled: ${exhaustivenessCheck}`)
        return commitStateFailure
      }
    }
    if (!isMatched) {
      continue
    }

    if (/* BasicRule */ "min_approvals" in rule) {
      if (typeof rule.min_approvals !== "number") {
        logger.failure(`Rule "${rule.name}" has invalid min_approvals`)
        logger.log(rule)
        return commitStateFailure
      }

      const users = await combineUsers(
        pr,
        octokit,
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
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pull_number: pr.number,
    })
    const { data: reviews } = reviewsResponse

    const latestReviews: Map<
      number,
      { id: number; user: string; isApproval: boolean }
    > = new Map()
    for (const review of reviews) {
      if (review.user === null || review.user === undefined) {
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
    logger.log("latestReviews", latestReviews.values())

    const rulesOutcomes: Map<
      MatchedRule["id"],
      Array<RuleSuccess | RuleFailure>
    > = new Map()

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
          const subconditionsUsersToAskForReview: Set<string> = new Set()

          const failedSubconditions: Array<number | string> = []
          toNextSubcondition: for (
            let i = 0;
            i < rule.subConditions.length;
            i++
          ) {
            const pendingUsersToAskForReview: Set<string> = new Set()

            const subCondition = rule.subConditions[i]
            let approvalCount = 0
            for (const user of subCondition.users ?? []) {
              pendingUsersToAskForReview.add(user)
              if (approvedBy.has(user) && !ruleApprovedBy.has(user)) {
                ruleApprovedBy.add(user)
                approvalCount++
                if (approvalCount === subCondition.min_approvals) {
                  continue toNextSubcondition
                }
              }
            }
            for (const team of subCondition.teams ?? []) {
              for (const [user, userInfo] of rule.users) {
                if (userInfo?.teamsHistory?.has(team)) {
                  pendingUsersToAskForReview.add(user)
                  if (approvedBy.has(user) && !ruleApprovedBy.has(user)) {
                    ruleApprovedBy.add(user)
                    approvalCount++
                    if (approvalCount === subCondition.min_approvals) {
                      continue toNextSubcondition
                    }
                  }
                }
              }
            }
            for (const user of pendingUsersToAskForReview) {
              subconditionsUsersToAskForReview.add(user)
            }
            failedSubconditions.push(
              typeof subCondition.name === "string"
                ? `"${subCondition.name}"`
                : `at index ${i}`,
            )
          }

          if (failedSubconditions.length) {
            const usersToAskForReview: Map<string, RuleUserInfo> = new Map(
              Array.from(rule.users.entries()).filter(function ([username]) {
                return !approvedBy.has(username)
              }),
            )
            const problem = `Rule "${rule.name}" needs in total ${
              rule.min_approvals
            } DISTINCT approvals, meaning users whose approvals counted towards one criterion are excluded from other criteria. For example: even if a user belongs multiple teams, their approval will only count towards one of them; or even if a user is referenced in multiple subconditions, their approval will only count towards one subcondition. Subcondition${
              failedSubconditions.length > 1 ? "s" : ""
            } ${failedSubconditions.join(
              " and ",
            )} failed. The following users have not approved yet: ${Array.from(
              usersToAskForReview.entries(),
            )
              .filter(function ([username]) {
                return subconditionsUsersToAskForReview.has(username)
              })
              .map(function ([username, { teams }]) {
                return `${username}${teams ? ` (team${teams.size === 1 ? "" : "s"}: ${Array.from(teams).join(", ")})` : ""}`
              })
              .join(", ")}.`
            outcomes.push(new RuleFailure(rule, problem, usersToAskForReview))
          } else {
            outcomes.push(new RuleSuccess(rule))
          }
        } else if (approvedBy.size < rule.min_approvals) {
          const usersToAskForReview: Map<string, RuleUserInfo> = new Map(
            Array.from(rule.users.entries()).filter(function ([username]) {
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
            .map(function ([username, { teams }]) {
              return `${username}${teams ? ` (team${teams.size === 1 ? "" : "s"}: ${Array.from(teams).join(", ")})` : ""}`
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
          }
        } else if (outcome instanceof RuleFailure) {
          pendingProblems.push(outcome.problem)
          for (const [username, userInfo] of outcome.usersToAskForReview) {
            const prevUser = pendingUsersToAskForReview.get(username)
            if (
              prevUser === undefined ||
              // If the team is null, this user was not asked as part of a team,
              // but individually. They should always be registered with "team:
              // null" that case to be sure the review will be requested
              // individually, even if they were previously registered as part
              // of a team.
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
          logger.failure("Unable to process unexpected rule outcome")
          logger.log(outcome)
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
          // If the team is null, this user was not asked as part of a team, but
          // individually. They should always be registered with "team: null" in
          // that case to be sure the review will be requested individually,
          // even if they were previously registered as part of a team.
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
      logger.log("usersToAskForReview", usersToAskForReview)
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
      logger.failure("The following problems were found:")
      for (const problem of problems) {
        logger.log(problem)
      }
      logger.log("")
      return commitStateFailure
    }
  }

  return commitStateSuccess
}
