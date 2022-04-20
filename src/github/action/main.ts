import { getInput, setFailed } from "@actions/core"
import { context, getOctokit as getActionOctokit } from "@actions/github"
import fetch from "node-fetch"

import { getFinishProcessReviews, processReviews } from "src/core"
import { getOctokit } from "src/github/octokit"
import { Context, PR } from "src/types"

import { ActionLogger } from "./logger"
import { ActionData } from "./types"

const processReviewsDirectly = (
  token: string,
  logger: ActionLogger,
  actionData: ActionData,
) => {
  const octokit = getOctokit(getActionOctokit(token), logger, null)
  const finishProcessReviews = getFinishProcessReviews(
    { logger, octokit },
    actionData,
  )
  const ctx: Context = { logger, octokit, finishProcessReviews }
  return processReviews(ctx, actionData)
}

const main = async () => {
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_review"
  ) {
    setFailed(
      `Invalid event: ${context.eventName}. This action should be triggered on pull_request and pull_request_review`,
    )
    return
  }

  const pr = context.payload.pull_request as PR

  const logger = new ActionLogger((line) => {
    return process.stdout.write(line)
  })

  const jobName = process.env.GITHUB_JOB
  if (jobName === undefined) {
    logger.warn("GITHUB_JOB name was not found in the environment")
  }

  const actionRepository = process.env.GITHUB_ACTION_REPOSITORY
  if (actionRepository === undefined) {
    logger.warn("GITHUB_ACTION_REPOSITORY was not found in the environment")
  }

  const actionData = {
    detailsUrl: `${context.serverUrl}/${pr.base.repo.owner.login}/${pr.base.repo.name}/actions/runs/${context.runId}`,
    jobName,
    pr,
    runId: context.runId,
    actionRepository,
  }

  // If a token is provided, check the reviews directly in the action
  const token = getInput("token")
  if (token) {
    await processReviewsDirectly(token, logger, actionData)
    return
  }

  // Otherwise, check it through the API
  const checkReviewsApi = getInput("checks-reviews-api", { required: true })
  const logLines = (await (
    await fetch(checkReviewsApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actionData),
    })
  ).json()) as string[]

  logger.log(logLines.join("").trim())
}

void main()
