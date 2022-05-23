import Fastify from "fastify"

import { getFinishProcessReviews, processReviews } from "src/core"
import { ActionLogger } from "src/github/action/logger"
import { ActionData } from "src/github/action/types"
import { Context } from "src/types"

import { ServerContext } from "./types"

enum ApiVersion {
  v1 = "v1",
}
const getApiRoute = (version: ApiVersion, route: string) => {
  return `/api/${version}/${route}`
}

const checkReviewsV1Route = getApiRoute(ApiVersion.v1, "check_reviews")

export const setupApi = ({ octokit, logger, github }: ServerContext) => {
  const server = Fastify({ logger: logger.getFastifyLogger() })

  server.route({
    method: "POST",
    url: checkReviewsV1Route,
    schema: {
      body: {
        type: "object",
        properties: {
          detailsUrl: { type: "string" },
          jobName: { type: "string" },
          runId: { type: "number" },
          pr: {
            type: "object",
            properties: {
              number: { type: "number" },
              base: {
                type: "object",
                properties: {
                  repo: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      owner: {
                        type: "object",
                        properties: { login: { type: "string" } },
                        required: ["login"],
                      },
                    },
                    required: ["name", "owner"],
                  },
                },
                required: ["repo"],
              },
              head: {
                type: "object",
                properties: { sha: { type: "string" } },
                required: ["sha"],
              },
              user: {
                type: "object",
                properties: { login: { type: "string" } },
                required: ["login"],
              },
            },
            required: ["number", "base", "head", "user"],
          },
        },
        required: ["detailsUrl", "runId", "pr"],
      },
    },
    handler: async (req, reply) => {
      const actionData = req.body as ActionData

      if (actionData.pr.base.repo.owner.login !== github.accessTokenOwner) {
        reply.statusCode = 403
        return {
          error: `${actionData.pr.base.repo.owner.login} != ${github.accessTokenOwner}`,
        }
      }

      const lines: string[] = []
      const actionLogger = new ActionLogger((line) => {
        return lines.push(line)
      })

      const incompleteContext = { logger: actionLogger, octokit }
      const finishProcessReviews = getFinishProcessReviews(
        incompleteContext,
        actionData,
      )
      const ctx: Context = { ...incompleteContext, finishProcessReviews }

      await processReviews(ctx, actionData)

      reply.statusCode = 200
      return lines
    },
  })

  server.route({
    method: "GET",
    url: "/ping",
    handler: async (req, reply) => {
      reply.statusCode = 200
      return { status: "ok" }
    },
  })

  return server
}
