import { Octokit } from "@octokit/rest"

import { getOctokit } from "src/github/octokit"
import { envNumberVar, envVar } from "src/utils"

import { ServerLogger } from "./logger"
import { setup } from "./setup"
import { ServerContext } from "./types"

const main = async () => {
  const logFormat = (() => {
    const logFormatVar = envVar("LOG_FORMAT")
    switch (logFormatVar) {
      case undefined: {
        return null
      }
      case "json": {
        return logFormatVar
      }
      default: {
        throw new Error(`Invalid $LOG_FORMAT: ${logFormatVar}`)
      }
    }
  })()

  const logger = new ServerLogger({
    name: "app",
    impl: console,
    logFormat,
    minLogLevel: "info",
  })

  /*
    Instead of spamming error messages once some uncaught error is found, log
    only the first event as "error" and subsequent ones as "info", then
    immediately exit the application.
  */
  let isTerminating = false
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    /*
      https://nodejs.org/api/process.html#event-uncaughtexception
      https://nodejs.org/api/process.html#event-unhandledrejection
    */
    process.on(event, (error, origin) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const errorData = { event, error, origin }

      if (isTerminating) {
        logger.info(
          errorData,
          "Caught error event; it will not be logged as an error because the application is being terminated...",
        )
        return
      }
      isTerminating = true

      logger.error(
        errorData,
        "Caught error event; application will exit with an error exit code",
      )

      process.exit(1)
    })
  }

  const serverPort = envNumberVar("PORT")

  const githubAccessToken = envVar("GITHUB_ACCESS_TOKEN")

  const octokit = getOctokit(new Octokit(), logger, () => {
    return { authorization: `token ${githubAccessToken}` }
  })

  const serverContext: ServerContext = { logger, octokit }

  const server = setup(serverContext)
  await server.listen(serverPort)
}

void main()