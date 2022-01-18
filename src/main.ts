import { getInput, setFailed } from "@actions/core"
import { context, getOctokit } from "@actions/github"

import { runChecks } from "./core"
import Logger from "./logger"
import { CommitState, PR } from "./types"

const main = function () {
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_review"
  ) {
    setFailed(
      `Invalid event: ${context.eventName}. This action should be triggered on pull_request and pull_request_review`,
    )
    return
  }

  const logger = new Logger()

  const pr = context.payload.pull_request as PR
  const octokit = getOctokit(getInput("token", { required: true }))

  const finish = async function (state: CommitState) {
    // Fallback URL in case we are not able to detect the current job
    let detailsUrl = `${context.serverUrl}/${pr.base.repo.owner}/${pr.base.repo.name}/actions/runs/${context.runId}`

    if (state === "failure") {
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

  runChecks(pr, octokit, logger, {
    configFilePath: getInput("config-file"),
    locksReviewTeam: getInput("locks-review-team"),
    teamLeadsTeam: getInput("team-leads-team"),
  })
    .then(function (state) {
      finish(state)
    })
    .catch(function (error) {
      logger.failure(error)
      finish("failure")
    })
}

main()
