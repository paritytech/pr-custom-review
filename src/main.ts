import * as core from "@actions/core"
import * as github from "@actions/github"
import * as Webhooks from "@octokit/webhooks-types"
import * as fs from "fs"
import Joi from "joi"
import * as YAML from "yaml"

import { commitStateFailure, commitStateSuccess } from "./constants"
import Logger from "./logger"
import { CommitState } from "./types"

type Octokit = ReturnType<typeof github.getOctokit>
type PR =
  | Webhooks.PullRequestEvent["pull_request"]
  | Webhooks.PullRequestReviewEvent["pull_request"]

type Rule = {
  name: string
  condition: string
  check_type: "diff" | "changed_files"
  min_approvals: number
  users: Array<string> | undefined | null
  teams: Array<string> | undefined | null
}
const ruleSchema = Joi.object<Rule>().keys({
  name: Joi.string().required(),
  condition: Joi.string().required(),
  check_type: Joi.string().valid("diff", "changed_files").required(),
  min_approvals: Joi.number().required(),
  users: Joi.array().items(Joi.string()).optional().allow(null),
  teams: Joi.array().items(Joi.string()).optional().allow(null),
})
type Configuration = {
  rules: Rule[]
}
const configurationSchema = Joi.object<Configuration>().keys({
  rules: Joi.array().items(ruleSchema).required(),
})

type RuleUserInfo = { team: string | null }

const combineUsers = async function (
  pr: PR,
  client: Octokit,
  presetUsers: string[],
  teams: string[],
) {
  const users: Map<string, RuleUserInfo> = new Map()

  for (const user of presetUsers) {
    if (pr.user.login != user) {
      users.set(user, { team: null })
    }
  }

  for (const team of teams) {
    const teamMembersResponse = await client.rest.teams.listMembersInOrg({
      org: pr.base.repo.owner.login,
      team_slug: team,
    })
    if (teamMembersResponse.status !== 200) {
      return new Error(`Failed to fetch team members from ${team}`)
    }

    for (const member of teamMembersResponse.data) {
      if (member === null) {
        continue
      }
      if (
        pr.user.login != member.login &&
        // We do not want to register a team for this user if their approval is
        // supposed to be requested individually
        users.get(member.login) === undefined
      ) {
        users.set(member.login, { team })
      }
    }
  }

  return users
}

const runChecks = async function (
  pr: PR,
  octokit: Octokit,
  logger: Logger,
): Promise<CommitState> {
  const diffResponse: { data: string; status: number } = await octokit.request(
    pr.diff_url,
  )
  if (diffResponse.status !== 200) {
    logger.failure(
      `Failed to get the diff from ${pr.diff_url} (code ${diffResponse.status})`,
    )
    logger.log(diffResponse.data)
    return commitStateFailure
  }
  const { data: diff } = diffResponse

  const changedFilesResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    {
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pull_number: pr.number,
    },
  )
  if (changedFilesResponse.status !== 200) {
    logger.failure(
      `Failed to get the changed files from ${pr.html_url} (code ${changedFilesResponse.status})`,
    )
    logger.log(changedFilesResponse.data)
    return commitStateFailure
  }
  const { data: changedFilesData } = changedFilesResponse
  const changedFiles = new Set(changedFilesData.map(({ filename }) => filename))
  logger.log("Changed files", changedFiles)

  type MatchedRule = {
    name: string
    min_approvals: number
    users: Map<string, RuleUserInfo>
  }
  const matchedRules: MatchedRule[] = []

  // Built in condition to search files with changes to locked lines
  const lockExpression = /🔒.*(\n^[+|-])|^[+|-].*🔒/gm
  if (lockExpression.test(diff)) {
    logger.log("Diff has changes to 🔒 lines or lines following 🔒")
    const users = await combineUsers(pr, octokit, [], ["pr-custom-review-team"])
    if (users instanceof Error) {
      logger.failure(users)
      return commitStateFailure
    }
    matchedRules.push({ name: "LOCKS TOUCHED", min_approvals: 2, users })
  }

  const configFilePath = core.getInput("config-file")
  if (configFilePath === null || configFilePath.length === 0) {
    logger.log("No config file provided")
  } else if (fs.existsSync(configFilePath)) {
    const configFile = fs.readFileSync(configFilePath, "utf8")

    const validation_result = configurationSchema.validate(
      YAML.parse(configFile),
    )
    if (validation_result.error) {
      logger.failure("Configuration file is invalid")
      logger.log(validation_result.error)
      return commitStateFailure
    }
    const config = validation_result.value

    for (const rule of config.rules) {
      const condition: RegExp = new RegExp(rule.condition, "gm")

      let matched = false
      switch (rule.check_type) {
        case "changed_files": {
          changedFilesLoop: for (const file of changedFiles) {
            if (condition.test(file)) {
              logger.log(
                `Matched expression "${rule.condition}" of rule "${rule.name}" for the file ${file}`,
              )
              matched = true
              break changedFilesLoop
            }
          }
          break
        }
        case "diff": {
          if (condition.test(diff)) {
            logger.log(
              `Matched expression "${rule.condition}" of rule "${rule.name}" on diff`,
            )
            matched = true
          }
          break
        }
        default: {
          const exhaustivenessCheck: never = rule.check_type
          logger.failure(`Check type is not handled: ${exhaustivenessCheck}`)
          return commitStateFailure
        }
      }
      if (!matched) {
        continue
      }

      const users = await combineUsers(
        pr,
        octokit,
        rule.users ?? [],
        rule.teams ?? [],
      )
      if (users instanceof Error) {
        logger.failure(users)
        return commitStateFailure
      }
      matchedRules.push({
        name: rule.name,
        min_approvals: rule.min_approvals,
        users,
      })
    }
  } else {
    logger.failure(`Could not read config file at ${configFilePath}`)
    return commitStateFailure
  }

  if (matchedRules.length !== 0) {
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pull_number: pr.number,
    })
    if (reviewsResponse.status !== 200) {
      logger.failure(
        `Failed to fetch reviews from ${pr.html_url} (code ${reviewsResponse.status})`,
      )
      logger.log(reviewsResponse.data)
      return commitStateFailure
    }
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

    const problems: string[] = []

    const usersToAskForReview: Map<string, RuleUserInfo> = new Map()
    let highestMinApprovalsRule: MatchedRule | null = null
    for (const rule of matchedRules) {
      if (rule.users.size !== 0) {
        const approvedBy: Set<string> = new Set()
        for (const review of latestReviews.values()) {
          if (rule.users.has(review.user) && review.isApproval) {
            approvedBy.add(review.user)
          }
        }
        if (approvedBy.size < rule.min_approvals) {
          const missingApprovals: {
            username: string
            team: string | null
          }[] = []
          for (const [username, { team }] of rule.users) {
            if (!approvedBy.has(username)) {
              missingApprovals.push({ username, team })
              const prevUser = usersToAskForReview.get(username)
              if (
                // Avoid registering the same user twice
                prevUser === undefined ||
                // If the team is null, this user was not asked as part of a
                // team, but individually. They should always be registered with
                // "team: null" that case to be sure the review will be
                // requested individually, even if they were previously
                // registered as part of a team.
                team === null
              ) {
                usersToAskForReview.set(username, { team })
              }
            }
          }
          problems.push(
            `Rule "${rule.name}" needs at least ${
              rule.min_approvals
            } approvals, but ${
              approvedBy.size
            } were matched. The following users have not approved yet: ${missingApprovals
              .map(function (user) {
                return `${
                  user.username
                }${user.team ? ` (team: ${user.team})` : ""}`
              })
              .join(", ")}.`,
          )
        }
      } else if (
        highestMinApprovalsRule === null ||
        highestMinApprovalsRule.min_approvals < rule.min_approvals
      ) {
        highestMinApprovalsRule = rule
      }
    }

    if (usersToAskForReview.size !== 0) {
      logger.log("usersToAskForReview", usersToAskForReview)
      const teams: Set<string> = new Set()
      const users: Set<string> = new Set()
      for (const [user, { team }] of usersToAskForReview) {
        if (team === null) {
          users.add(user)
        } else {
          teams.add(team)
        }
      }
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

const main = function () {
  const context = github.context
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_review"
  ) {
    core.setFailed(
      `Invalid event: ${context.eventName}. This action should be triggered on pull_request and pull_request_review`,
    )
    return
  }

  const logger = new Logger()

  const pr = context.payload.pull_request as PR
  const octokit = github.getOctokit(core.getInput("token", { required: true }))

  const finish = async function (state: CommitState) {
    // Fallback URL in case we are not able to detect the current job
    let detailsUrl = `${context.serverUrl}/${pr.base.repo.name}/runs/${context.runId}`

    if (state === commitStateFailure) {
      const jobName = process.env.GITHUB_JOB
      if (jobName === undefined) {
        logger.warning("Job name was not found in the environment")
      } else {
        // Fetch the jobs so that we'll be able to detect this step and provide a
        // more accurate logging location
        const jobsResponse = await octokit.rest.actions.listJobsForWorkflowRun({
          owner: pr.base.repo.owner.login,
          repo: pr.base.repo.name,
          run_id: context.runId,
        })
        if (jobsResponse.status === 200) {
          const {
            data: { jobs },
          } = jobsResponse
          for (const job of jobs) {
            if (job.name === jobName) {
              let stepNumber: number | undefined = undefined
              const actionRepository = process.env.GITHUB_ACTION_REPOSITORY
              if (actionRepository === undefined) {
                logger.warning(
                  "Action repository was not found in the environment",
                )
              } else {
                const actionRepositoryMatch = actionRepository.match(/[^/]*$/)
                if (actionRepositoryMatch === null) {
                  logger.warning(
                    `Action repository name could not be extracted from ${actionRepository}`,
                  )
                } else {
                  const actionStep = job.steps?.find(function ({ name }) {
                    return name === actionRepositoryMatch[0]
                  })
                  if (actionStep === undefined) {
                    logger.warning(
                      `Failed to find ${actionRepositoryMatch[0]} in the job's steps`,
                      job.steps,
                    )
                  } else {
                    stepNumber = actionStep.number
                  }
                }
              }
              detailsUrl = `${job.html_url}${
                stepNumber
                  ? `#step:${stepNumber}:${logger.relevantStartingLine}`
                  : ""
              }`
              break
            }
          }
        } else {
          logger.failure(
            `Failed to fetch jobs for workflow run ${context.runId} (code ${jobsResponse.status})`,
          )
        }
      }
    }

    await octokit.rest.repos.createCommitStatus({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      sha: pr.head.sha,
      state,
      context: context.workflow,
      target_url: detailsUrl,
      description: "Please check Details for more information",
    })

    logger.log(`Final state: ${state}`)

    // We always exit with 0 so that there are no lingering failure statuses in
    // the pipeline for the action. The custom status created above will be the
    // one to inform the outcome of this action.
    process.exit(0)
  }

  runChecks(pr, octokit, logger)
    .then(function (state) {
      finish(state)
    })
    .catch(function (error) {
      logger.failure(error)
      finish(commitStateFailure)
    })
}

main()
