import { Octokit } from "@octokit/core";
import { OctokitResponse } from "@octokit/plugin-paginate-rest/dist-types/types";
import { RequestError } from "@octokit/request-error";
import { Mutex } from "async-mutex";

import { CommonLoggerInterface } from "src/types";
import { delayMilliseconds, Err, Ok } from "src/utils";

const wasOctokitExtendedByApplication = Symbol();
export type ExtendedOctokit<OctokitInstance extends Octokit> = OctokitInstance & {
  [wasOctokitExtendedByApplication]?: true;
};

// Funnel all GitHub requests through a Mutex in order to avoid rate limits
const requestMutex = new Mutex();
let requestDelay = Promise.resolve();

const rateLimitRemainingHeader = "x-ratelimit-remaining";
const rateLimitResetHeader = "x-ratelimit-reset";
const retryAfterHeader = "retry-after";
export const getOctokit = <OctokitInstance extends Octokit>(
  octokit: OctokitInstance,
  logger: CommonLoggerInterface,
  getAuthHeaders: (() => { authorization: string } | Promise<{ authorization: string }>) | null,
): ExtendedOctokit<OctokitInstance> => {
  /*
    Check that this Octokit instance has not been augmented before because
    side-effects of this function should not be stacked; e.g. registering
    request wrappers more than once will break the application
  */
  if ((octokit as ExtendedOctokit<OctokitInstance>)[wasOctokitExtendedByApplication]) {
    return octokit as ExtendedOctokit<OctokitInstance>;
  }

  octokit.hook.wrap("request", async (request, options) => {
    if (logger.enableRequestLogging) {
      logger.info({ request, options }, "Preparing to send a request to the GitHub API");
    }

    let triesCount = 0;
    const result: Ok<OctokitResponse<any>> | Err<any> | undefined = await requestMutex.runExclusive(async () => {
      try {
        await requestDelay;

        for (; triesCount < 3; triesCount++) {
          if (triesCount) {
            logger.info(`Retrying Octokit request (tries so far: ${triesCount})`);
          }

          if (getAuthHeaders !== null) {
            const authHeaders = await getAuthHeaders();
            options.headers = { ...options.headers, ...authHeaders };
          }

          try {
            return new Ok(await request(options));
          } catch (error) {
            if (!(error instanceof RequestError)) {
              return new Err(error);
            }

            const { status, message } = error;
            const isApiRateLimitResponse = message.startsWith("You have exceeded a secondary rate limit.");
            /*
              4XX status codes indicates a "client error", thus we assume the
              request is invalid and therefore there's no point in retrying it
              */
            if (!isApiRateLimitResponse && status >= 400 && status < 500) {
              return new Err(error);
            }

            const { response } = error;
            const fallbackWaitDuration = 1000;
            const waitDuration =
              response === undefined
                ? /*
                    We don't know what to make of this error since its response is
                    empty, so just use a fallback wait duration
                  */ fallbackWaitDuration
                : (() => {
                    const { headers } = response;
                    if (parseInt(headers[rateLimitRemainingHeader] ?? "") === 0) {
                      // https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limit-http-headers
                      logger.warn(
                        `GitHub API limits were hit! The "${rateLimitResetHeader}" response header will be read to figure out until when we're supposed to wait...`,
                      );
                      const rateLimitResetHeaderValue = headers[rateLimitResetHeader];
                      const resetEpoch = parseInt(rateLimitResetHeaderValue ?? "") * 1000;
                      if (Number.isNaN(resetEpoch)) {
                        logger.error(
                          { rateLimitResetHeaderValue, rateLimitResetHeader, headers },
                          `GitHub response header "${rateLimitResetHeader}" could not be parsed as epoch`,
                        );
                      } else {
                        const currentEpoch = Date.now();
                        const duration = resetEpoch - currentEpoch;
                        if (duration < 0) {
                          logger.error(
                            { rateLimitResetHeaderValue, resetEpoch, currentEpoch, headers },
                            `Parsed epoch value for GitHub response header "${rateLimitResetHeader}" is smaller than the current date`,
                          );
                        } else {
                          return duration;
                        }
                      }
                    } else if (headers[retryAfterHeader] !== undefined) {
                      // https://docs.github.com/en/rest/guides/best-practices-for-integrators#dealing-with-secondary-rate-limits
                      const retryAfterHeaderValue = headers[retryAfterHeader];
                      const duration = parseInt(String(retryAfterHeaderValue)) * 1000;
                      if (Number.isNaN(duration)) {
                        logger.error(
                          { retryAfterHeader, retryAfterHeaderValue, headers },
                          `GitHub response header "${retryAfterHeader}" could not be parsed as seconds`,
                        );
                      } else {
                        return duration;
                      }
                    } else if (
                      /*
                        If this is an API Rate Limit response error and we
                        haven't been able to parse the precise required wait
                        duration, it's not sane to try to recover from this
                        error by using a fallback wait duration because it might
                        be imprecise
                      */
                      !isApiRateLimitResponse
                    ) {
                      logger.info(
                        { headers, fallbackWaitDuration, message },
                        "Falling back to default wait duration since other heuristics were not fulfilled",
                      );
                      return fallbackWaitDuration;
                    }
                  })();

            if (waitDuration === undefined) {
              return new Err(error);
            }

            logger.info(`Waiting for ${waitDuration}ms until requests can be made again...`);
            await delayMilliseconds(waitDuration);
          }
        }
      } catch (error) {
        return new Err(error);
      }
    });

    /*
      3600 (seconds in an hour) / 5000 (requests limit) = 0.72, or 720
      milliseconds, which is the minimum value we can use for this delay
    */
    requestDelay = delayMilliseconds(768);

    if (result instanceof Err) {
      throw result.value;
    } else if (result === undefined) {
      throw new Error(`Unable to fetch GitHub response within ${triesCount} tries`);
    }

    return result.value;
  });

  const extendedOctokit = octokit as ExtendedOctokit<OctokitInstance>;
  extendedOctokit[wasOctokitExtendedByApplication] = true;
  return extendedOctokit;
};
