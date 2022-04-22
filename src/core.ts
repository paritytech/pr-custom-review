import { OctokitResponse } from "@octokit/types"
import assert from "assert"
import Permutator from "iterative-permutation"
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

const displayUserWithTeams = (
  user: string,
  teams: Set<string> | undefined | null,
) => {
  return `${user}${
    teams
      ? ` (team${teams.size === 1 ? "" : "s"}: ${Array.from(teams).join(", ")})`
      : ""
  }`
}

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
          const approvalGroups = rule.subconditions.map((subcondition) => {
            const subconditionApprovedBy: Set<string> = new Set()

            for (const user of subcondition.users ?? []) {
              if (approvedBy.has(user)) {
                subconditionApprovedBy.add(user)
              }
            }

            for (const team of subcondition.teams ?? []) {
              for (const [user, userInfo] of rule.users) {
                if (userInfo?.teamsHistory?.has(team) && approvedBy.has(user)) {
                  subconditionApprovedBy.add(user)
                }
              }
            }

            return { subcondition, subconditionApprovedBy }
          })

          /*
            Test every possible combination of every subcondition for each
            approval group on each subcondition. This is needed when it would
            be more favorable to use an approval for a different subcondition
            other than the one it could be first matched for that approval.
            Consider the following scenario:
              - Ana has teams: Team2, Team1
              - Bob has teams: Team2
              - Ana and Bob have both approved
            And suppose that we need 1 distinct approval for Team1 and another
            for Team2. It might be the case that Ana's approval for Team2 is
            registered first, which would make Bob's approval useless for a
            suboptimal outcome.
            The most favorable combination to clear the requirement is:
              - Ana's approval is allocated to Team1
              - Bob's approval is allocated to Team2
            The case we want to avoid is:
              - Ana's approval is allocated to Team2
              - Bob's approval is useless because it can only be allocated to
                Team1, which was already approved by Ana in this scenario
            It is possible to avoid the bad case by brute-forcing every
            available permutation of approvals' orders and picking the best one
            found, with bailouts for when the overall target approval count is
            reached.
          */
          type CombinationApprovedBy = Map<
            /* subcondition Index */ number,
            /* users which approved the subcondition */ Set<string>
          >
          let bestApproversArrangement: CombinationApprovedBy = new Map()

          for (let i = 0; i < approvalGroups.length; i++) {
            subconditionCombinationsLoop: for (const userStartingCombination of approvalGroups[
              i
            ].subconditionApprovedBy) {
              /*
                The combinations are tried by alternating which user starts the
                combination on each pass.

                Take for instance the following subconditions:
                - Subcondition 0 approvers: A
                - Subcondition 1 approvers: B

                The whole iteration would work as follows:
                1: Iterate through all approvers of Subcondition 0
                  1.1: A starts the combination
                    1.1.1: Iterate through all approvers of Subcondition 0
                      - A
                    1.2.1: Iterate through all approvers of Subcondition 1
                      - B
                2. Iterate through all approvers of Subcondition 1
                  2.1: B starts the combination
                    2.1.1: Iterate through all approvers of Subcondition 0
                      - A
                    2.1.2: Iterate through all approvers of Subcondition 1
                      - B

                Stop conditions are in place for stopping and skipping the
                iterations as soon as the clearance requirements for a given
                scope are fulfilled, thus the algorithm does not actually have
                to go through every combination every time, only in the worst
                case.
              */
              const combinationApprovers: CombinationApprovedBy = new Map([
                [i, new Set([userStartingCombination])],
              ])

              /*
                The least bad combination is the first one tried, since at least
                it has one approval
              */
              if (bestApproversArrangement.size === 0) {
                bestApproversArrangement = combinationApprovers
              }

              subconditionsLoop: for (
                let j = 0;
                j < approvalGroups.length;
                j++
              ) {
                const { subcondition, subconditionApprovedBy } =
                  approvalGroups[j]

                /*
                  Check if the subcondition's min_approvals target has already
                  been fulfilled by the initialization of combinationApprovedBy
                */
                if (j === i) {
                  const approversCount = combinationApprovers.get(j)?.size
                  assert(
                    approversCount,
                    "approversCount should be >=0 because combinationApprovers was initialized",
                  )
                  if (approversCount === subcondition.min_approvals) {
                    continue
                  }
                }

                let approvalCountAtStartOfPermutation = 0
                for (const approvers of combinationApprovers.values()) {
                  approvalCountAtStartOfPermutation += approvers.size
                }

                const subconditionApproversPermutator = new Permutator(
                  /*
                     Permutator mutates the input array, therefore make sure to
                     *not* pass an array reference to it
                  */
                  Array.from(subconditionApprovedBy),
                )
                while (subconditionApproversPermutator.hasNext()) {
                  const usersPermutation =
                    subconditionApproversPermutator.next()

                  /*
                    Initialize a new Set here so that the effects of this
                    permutation doesn't affect combinationApprovers until it is
                    the right time to commit the results
                  */
                  const subconditionApprovers = new Set(
                    combinationApprovers.get(j)?.values(),
                  )

                  usersPermutationLoop: for (const user of usersPermutation) {
                    for (const approvers of combinationApprovers.values()) {
                      if (approvers.has(user)) {
                        continue usersPermutationLoop
                      }
                    }

                    if (subconditionApprovers.has(user)) {
                      continue usersPermutationLoop
                    }

                    subconditionApprovers.add(user)

                    /*
                      We only want to commit subconditionApprovers to
                      combinationApprovers if the current approval count is
                      higher than the current best one
                    */
                    if (
                      subconditionApprovers.size <
                      (combinationApprovers.get(j)?.size ?? 0)
                    ) {
                      continue
                    }

                    combinationApprovers.set(j, subconditionApprovers)

                    let approvalCountNow = 0
                    for (const users of combinationApprovers.values()) {
                      approvalCountNow += users.size
                    }
                    if (approvalCountNow === rule.min_approvals) {
                      /*
                        Bail out when combination which fulfills all
                        subconditions is found
                      */
                      bestApproversArrangement = combinationApprovers
                      break subconditionCombinationsLoop
                    }

                    let approvalCountOfBestCombination = 0
                    for (const approvers of bestApproversArrangement.values()) {
                      approvalCountOfBestCombination += approvers.size
                    }
                    if (approvalCountNow > approvalCountOfBestCombination) {
                      bestApproversArrangement = combinationApprovers
                    }

                    if (
                      approvalCountNow - approvalCountAtStartOfPermutation ===
                      subcondition.min_approvals
                    ) {
                      continue subconditionsLoop
                    }
                  }
                }
              }
            }
          }

          let approvalCountOfBestApproversArrangement = 0
          for (const approvers of bestApproversArrangement.values()) {
            approvalCountOfBestApproversArrangement += approvers.size
          }
          assert(
            approvalCountOfBestApproversArrangement <= rule.min_approvals,
            "Subconditions should not accumulate more approvals than necessary",
          )

          // It's only meaningful to log this if some approval was had
          if (approvalCountOfBestApproversArrangement > 0) {
            logger.log({
              ruleName: rule.name,
              approvalCountOfBestCombination:
                approvalCountOfBestApproversArrangement,
              combinationApprovedByMostPeopleOverall: new Map(
                Array.from(bestApproversArrangement).map(
                  ([subconditionIndex, approvers]) => {
                    return [
                      rule.subconditions[subconditionIndex].name ??
                        `${rule.name}[${subconditionIndex}]`,
                      approvers,
                    ]
                  },
                ),
              ),
            })
          }

          if (approvalCountOfBestApproversArrangement === rule.min_approvals) {
            for (const [
              subconditionIndex,
              approvers,
            ] of bestApproversArrangement) {
              const subcondition = rule.subconditions[subconditionIndex]
              assert(
                approvers.size === subcondition.min_approvals,
                `Subcondition "${
                  subcondition.name ?? `${rule.name}[${subconditionIndex}]`
                }"'s approvers should have exactly ${
                  rule.subconditions[subconditionIndex].min_approvals
                } approvals`,
              )
            }
            outcomes.push(new RuleSuccess(rule))
          } else {
            const unfulfilledSubconditionsErrorMessage = approvalGroups.reduce(
              (acc, { subcondition }, subconditionIndex) => {
                const approversCount =
                  bestApproversArrangement.get(subconditionIndex)?.size ?? 0

                if (approversCount === subcondition.min_approvals) {
                  return acc
                }

                assert(
                  approversCount <= subcondition.min_approvals,
                  "Subconditions should not accumulate more approvals than necessary",
                )

                const missingApprovers: Set<string> = new Set()

                for (const user of subcondition.users ?? []) {
                  if (!approvedBy.has(user)) {
                    missingApprovers.add(user)
                  }
                }

                for (const team of subcondition.teams ?? []) {
                  for (const [user, userInfo] of rule.users) {
                    if (
                      userInfo?.teamsHistory?.has(team) &&
                      !approvedBy.has(user)
                    ) {
                      missingApprovers.add(user)
                    }
                  }
                }

                return `${acc}\nSubcondition "${
                  subcondition.name ?? `${rule.name}[${subconditionIndex}]`
                }" does not have approval from the following users: ${Array.from(
                  rule.users.entries(),
                )
                  .filter(([username]) => {
                    return missingApprovers.has(username)
                  })
                  .map(([user, { teams }]) => {
                    return displayUserWithTeams(user, teams)
                  })
                  .join(", ")}.`
              },
              "",
            )

            const problem = `Rule "${rule.name}" needs in total ${rule.min_approvals} DISTINCT approvals, but ${approvalCountOfBestApproversArrangement} were given. Users whose approvals counted towards one criterion are excluded from other criteria. For example: even if a user belongs multiple teams, their approval will only count towards one of them; or even if a user is referenced in multiple subconditions, their approval will only count towards one subcondition.${unfulfilledSubconditionsErrorMessage}`

            const usersToAskForReview: Map<string, RuleUserInfo> = new Map(
              Array.from(rule.users.entries()).filter(([username]) => {
                return !approvedBy.has(username)
              }),
            )

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
            .map(([user, { teams }]) => {
              return displayUserWithTeams(user, teams)
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
