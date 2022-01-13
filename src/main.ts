import * as core from "@actions/core"
import * as github from "@actions/github"
import { Context } from "@actions/github/lib/context"
import * as Webhooks from "@octokit/webhooks-types"
import * as fs from "fs"
import Joi from "joi"
import * as YAML from "yaml"

type Octokit = ReturnType<typeof github.getOctokit>
type PR =
  | Webhooks.PullRequestEvent["pull_request"]
  | Webhooks.PullRequestReviewEvent["pull_request"]

type Rule = {
  name: string
  condition: string
  check_type: "diff" | "changed_files"
  min_approvals: number
  users: Array<string> | undefined
  teams: Array<string> | undefined
}
const approvalGroupSchema = Joi.object<Rule>().keys({
  name: Joi.string().required(),
  condition: Joi.string().required(),
  check_type: Joi.string().valid("diff", "changed_files").required(),
  min_approvals: Joi.number().required(),
  users: Joi.array().items(Joi.string()).optional(),
  teams: Joi.array().items(Joi.string()).optional(),
})
type Configuration = {
  rules: Rule[]
}
const configurationSchema = Joi.object<Configuration>().keys({
  rules: Joi.array().items(approvalGroupSchema).required(),
})

type RuleUser = { team: string | null }

const combineUsers = async function (
  pr: PR,
  client: Octokit,
  context: Context,
  presetUsers: string[],
  teams: string[],
) {
  const users: Map<string, RuleUser> = new Map()

  for (const user of presetUsers) {
    if (pr.user.login != user) {
      users.set(user, { team: null })
    }
  }

  const org = pr.base.repo.owner.login
  for (const team of teams) {
    const teamMembersResponse = await client.rest.teams.listMembersInOrg({
      org,
      team_slug: team,
    })
    if (teamMembersResponse.status !== 200) {
      return new Error(`Failed to fetch team members from ${org}/${team}`)
    }

    for (const member of teamMembersResponse.data) {
      if (member === null) {
        continue
      }
      if (
        pr.user.login != member.login &&
        users.get(member.login) === undefined
      ) {
        users.set(member.login, { team })
      }
    }
  }

  return users
}

type Env = {
  GITHUB_SERVER_URL: string
  GITHUB_WORKFLOW: string
  GITHUB_RUN_ID: string
  GITHUB_REPOSITORY: string
}

const runChecks = async function (
  pr: PR,
  octokit: Octokit,
  env: Env,
  log: typeof console.log,
  context: Context,
): Promise<"failure" | "success"> {
  const diffResponse: { data: string; status: number } = await octokit.request(
    pr.diff_url,
  )
  if (diffResponse.status !== 200) {
    log(
      `Failed to get the diff from ${pr.diff_url} (code ${diffResponse.status})`,
    )
    return "failure"
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
    log(
      `Failed to get the changed files from ${pr.html_url} (code ${changedFilesResponse.status})`,
    )
    return "failure"
  }
  const { data: changedFilesData } = changedFilesResponse
  const changedFiles = new Set(changedFilesData.map(({ filename }) => filename))
  log("Changed files", changedFiles)

  type MatchedRule = {
    name: string
    min_approvals: number
    users: Map<string, RuleUser>
  }
  const matchedRules: MatchedRule[] = []

  // Built in condition to search files with changes to locked lines
  const lockExpression = /🔒.*(\n^[+|-])|^[+|-].*🔒/gm
  if (lockExpression.test(diff)) {
    log("Diff has changes to 🔒 lines or lines following 🔒")
    const users = await combineUsers(
      pr,
      octokit,
      context,
      [],
      ["pr-custom-review-team"],
    )
    if (users instanceof Error) {
      log(users)
      return "failure"
    }
    matchedRules.push({ name: "LOCKS TOUCHED", min_approvals: 2, users })
  }

  const configFilePath = core.getInput("config-file")
  if (configFilePath === null || configFilePath.length === 0) {
    log("No config file provided")
  } else if (fs.existsSync(configFilePath)) {
    const configFile = fs.readFileSync(configFilePath, "utf8")

    const validation_result = configurationSchema.validate(
      YAML.parse(configFile),
    )
    if (validation_result.error) {
      log("Configuration file is invalid", validation_result.error)
      return "failure"
    }
    const config = validation_result.value

    for (const rule of config.rules) {
      const condition: RegExp = new RegExp(rule.condition, "gm")

      let matched = false
      switch (rule.check_type) {
        case "changed_files": {
          changedFilesLoop: for (const file of changedFiles) {
            if (condition.test(file)) {
              log(`Matched ${rule.condition} on the file ${file}`)
              matched = true
              break changedFilesLoop
            }
          }
          break
        }
        case "diff": {
          if (condition.test(diff)) {
            log(`Matched ${rule.condition} on diff`)
            matched = true
          }
          break
        }
        default: {
          const exhaustivenessCheck: never = rule.check_type
          log(`Check type is not handled: ${exhaustivenessCheck}`)
          return "failure"
        }
      }
      if (!matched) {
        continue
      }

      const users = await combineUsers(
        pr,
        octokit,
        context,
        rule.users ?? [],
        rule.teams ?? [],
      )
      if (users instanceof Error) {
        log(users)
        return "failure"
      }
      matchedRules.push({
        name: rule.name,
        min_approvals: rule.min_approvals,
        users,
      })
    }
  } else {
    log(`Could not read config file at ${configFilePath}`)
    return "failure"
  }

  if (matchedRules.length !== 0) {
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pull_number: pr.number,
    })
    if (reviewsResponse.status !== 200) {
      log(
        `Failed to fetch reviews from ${pr.html_url} (code ${reviewsResponse.status})`,
      )
      return "failure"
    }
    const { data: reviews } = reviewsResponse

    const latestReviews: Map<
      number,
      { id: number; user: string; approved: boolean }
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
          approved: review.state === "APPROVED",
        })
      }
    }

    const problems: string[] = []

    type Team = string | null
    const usersToAskForReview: Map<string, Team> = new Map()

    let highestMinApprovalsRule: MatchedRule | null = null
    for (const rule of matchedRules) {
      if (rule.users.size !== 0) {
        const approvedBy: Set<string> = new Set()
        for (const review of latestReviews.values()) {
          if (rule.users.has(review.user) && review.approved) {
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
                // team, but individually. In that case we should register them
                // with a null team so that they will be asked individually.
                team === null
              ) {
                usersToAskForReview.set(username, team)
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
              .join(", ")}`,
          )
        }
      } else if (
        highestMinApprovalsRule === null ||
        highestMinApprovalsRule.min_approvals < rule.min_approvals
      ) {
        highestMinApprovalsRule = rule
      }
    }

    log("usersToAskForReview", usersToAskForReview)
    if (usersToAskForReview.size !== 0) {
      const teams: Set<string> = new Set()
      const users: Set<string> = new Set()
      for (const [user, team] of usersToAskForReview) {
        if (team === null) {
          users.add(user)
        } else {
          teams.add(team)
        }
      }
      log("reviewers", users)
      log("team_reviewers", teams)
      await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
        {
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: pr.number,
          reviewers: Array.from(users),
          team_reviewers: Array.from(teams),
        },
      )
    }

    if (highestMinApprovalsRule !== null) {
      let approvalCount = 0
      for (const review of latestReviews.values()) {
        if (review.approved) {
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
      log("The following problems were found:")
      for (const problem of problems) {
        log(problem)
      }
      return "failure"
    }
  }

  return "success"
}

const main = function () {
  const env: {
    GITHUB_SERVER_URL: string
    GITHUB_WORKFLOW: string
    GITHUB_RUN_ID: string
    GITHUB_REPOSITORY: string
  } = {
    GITHUB_SERVER_URL: "",
    GITHUB_WORKFLOW: "",
    GITHUB_REPOSITORY: "",
    GITHUB_RUN_ID: "",
  }
  for (const varName in env) {
    const value = process.env[varName]
    if (value === undefined) {
      core.setFailed(`Missing environment variable $${varName}`)
      return
    }
    env[varName as keyof typeof env] = value
  }

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

  const log = console.log

  const pr = context.payload.pull_request as PR
  const octokit = github.getOctokit(core.getInput("token"))

  const exit = async function (state: "success" | "failure") {
    const infoURL = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    await octokit.rest.repos.createCommitStatus({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      sha: pr.head.sha,
      state,
      context: env.GITHUB_WORKFLOW,
      target_url: `${infoURL}?check_suite_focus=true`,
      ...(state === "success"
        ? {}
        : { description: "Please check Details for more information" }),
    })
    log(`Final state: ${state}`)
    // We always exit with 0 so that there are no lingering failure statuses in
    // the pipeline for the action. The custom status created above will be the
    // one to inform the outcome of this action.
    process.exit(0)
  }

  runChecks(pr, octokit, env, log, context)
    .then(function (state) {
      exit(state)
    })
    .catch(function (error) {
      log(error)
      exit("failure")
    })
}

main()
