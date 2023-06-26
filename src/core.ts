import assert from "assert";
import Permutator from "iterative-permutation";

import { actionReviewTeamFiles, commitStateFailure, commitStateSuccess } from "./constants";
import { ActionData } from "./github/action/types";
import { GitHubApi } from "./github/api";
import { CommitState } from "./github/types";
import { BaseRule, Context, MatchedRule, PR, RuleCriteria, RuleFailure, RuleUserInfo } from "./types";

const displayUserWithTeams = (user: string, teams: Set<string> | undefined | null) =>
  `${user}${teams ? ` (team${teams.size === 1 ? "" : "s"}: ${Array.from(teams).join(", ")})` : ""}`;

const updateUserToAskForReview = (
  usersToAskForReview: Map<string, RuleUserInfo>,
  user: string,
  userInfo: RuleUserInfo,
) => {
  let userToAskForReview = usersToAskForReview.get(user);
  if (userToAskForReview === undefined) {
    /*
      Shallow-copy the userInfo so that further updates don't affect the initial
      RuleUserInfo
    */
    userToAskForReview = { ...userInfo };
  } else if (userInfo.teams === null) {
    userToAskForReview.teams = null;
  } else if (
    /*
      Avoid registering a team for this user if their approval is supposed
      to be requested individually
    */
    userToAskForReview.teams !== null
  ) {
    userToAskForReview.teams = new Set([...(userToAskForReview.teams ?? []), ...(userInfo?.teams ?? [])]);
  }
  usersToAskForReview.set(user, userToAskForReview);
};

const processSubconditionMissingApprovers = (
  approvedBy: Set<string>,
  usersToAskForReview: Map<string, RuleUserInfo>,
  usersInfo: Map<string, RuleUserInfo>,
) => {
  const missingApprovers: Map<string, RuleUserInfo> = new Map();

  for (const [user, userInfo] of usersInfo) {
    if (approvedBy.has(user)) {
      continue;
    }
    updateUserToAskForReview(usersToAskForReview, user, userInfo);
    missingApprovers.set(user, userInfo);
  }

  return missingApprovers;
};

type TeamsCache = Map<string /* Team slug */, string[] /* Usernames of team members */>;
export const combineUsers = async (
  api: GitHubApi,
  pr: PR,
  presetUsers: string[],
  teams: string[],
  teamsCache: TeamsCache,
) => {
  const users: Map<string, RuleUserInfo> = new Map();

  for (const user of presetUsers) {
    users.set(user, { ...users.get(user), teams: null });
  }

  for (const team of teams) {
    let teamMembers = teamsCache.get(team);

    if (teamMembers === undefined) {
      teamMembers = await api.getTeamMembers(team);
      teamsCache.set(team, teamMembers);
    }

    for (const teamMember of teamMembers) {
      const userInfo = users.get(teamMember);
      if (userInfo === undefined) {
        users.set(teamMember, { teams: new Set([team]) });
      } else if (
        /*
          Avoid registering a team for this user if their approval is supposed
          to be requested individually
        */
        userInfo.teams !== null
      ) {
        userInfo.teams.add(team);
      }
    }
  }

  return users;
};

/*
  This function should only depend on its inputs so that it can be tested
  without inconveniences. If you need more external input then pass it as a
  function argument.
*/
export const runChecks = async ({ pr, logger }: Context & { pr: PR }, api: GitHubApi) => {
  const config = await api.fetchConfigFile();
  if (!config) {
    return commitStateFailure;
  }

  const {
    "locks-review-team": locksReviewTeam,
    "team-leads-team": teamLeadsTeam,
    "action-review-team": actionReviewTeam,
    rules,
    "prevent-review-request": preventReviewRequest,
  } = config;

  const getUsersInfo = (() => {
    /*
      Set up a teams cache so that teams used multiple times don't have to be
      requested more than once
    */
    const teamsCache: TeamsCache = new Map();

    return (users: string[], teams: string[]) => combineUsers(api, pr, users, teams, teamsCache);
  })();

  const diff = await api.fetchDiff();

  const matchedRules: MatchedRule[] = [];

  // Built in condition to search files with changes to locked lines
  const lockExpression = /🔒[^\n]*\n[+|-]|(^|\n)[+|-][^\n]*🔒/;
  if (lockExpression.test(diff)) {
    logger.info("Diff has changes to 🔒 lines or lines following 🔒");
    const subconditions = [
      { min_approvals: 1, teams: [locksReviewTeam], name: `Locks Reviewers Approvals (team ${locksReviewTeam})` },
      { min_approvals: 1, teams: [teamLeadsTeam], name: `Team Leads Approvals (team ${teamLeadsTeam})` },
    ];
    matchedRules.push({
      name: "Locks touched",
      kind: "AndDistinctRule",
      subconditions: await Promise.all(
        subconditions.map(async (subcondition) => {
          return { ...subcondition, usersInfo: await getUsersInfo([], subcondition.teams) };
        }),
      ),
    });
  }

  const changedFiles = new Set(await api.fetchChangedFiles());
  logger.info("Changed files", changedFiles);

  for (const actionReviewFile of actionReviewTeamFiles) {
    if (changedFiles.has(actionReviewFile)) {
      const ruleName = "Action files changed";
      matchedRules.push({
        name: ruleName,
        kind: "BasicRule",
        subconditions: [{ name: ruleName, min_approvals: 1, usersInfo: await getUsersInfo([], [actionReviewTeam]) }],
      });
      break;
    }
  }

  const processComplexRule = async (
    kind: "AndDistinctRule" | "OrRule" | "AndRule",
    name: string,
    subconditions: RuleCriteria[],
  ) => {
    switch (kind) {
      case "AndDistinctRule":
      case "OrRule":
      case "AndRule": {
        matchedRules.push({
          name: name,
          kind,
          subconditions: await Promise.all(
            subconditions.map(async (subcondition, i) => {
              return {
                ...subcondition,
                name: `${name}[${i}]`,
                usersInfo: await getUsersInfo(subcondition?.users ?? [], subcondition?.teams ?? []),
              };
            }),
          ),
        });
        break;
      }
      default: {
        const exhaustivenessCheck: never = kind;
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        const failureMessage = `Rule kind is not handled: ${exhaustivenessCheck}`;
        logger.fatal(failureMessage);
        throw new Error(failureMessage);
      }
    }
  };

  for (const rule of rules) {
    const includeCondition = (() => {
      switch (typeof rule.condition) {
        case "string": {
          return new RegExp(rule.condition, "gm");
        }
        case "object": {
          assert(rule.condition);
          return new RegExp("include" in rule.condition ? rule.condition.include : ".*", "gm");
        }
        default: {
          throw new Error(`Unexpected type "${typeof rule.condition}" for rule "${rule.name}"`);
        }
      }
    })();

    const excludeCondition =
      typeof rule.condition === "object" && rule.condition !== null && "exclude" in rule.condition
        ? new RegExp(rule.condition.exclude)
        : undefined;

    let isMatched = false;
    switch (rule.check_type) {
      case "changed_files": {
        changedFilesLoop: for (const file of changedFiles) {
          isMatched = includeCondition.test(file) && !excludeCondition?.test(file);
          if (isMatched) {
            logger.info(
              `Matched expression "${
                typeof rule.condition === "string" ? rule.condition : JSON.stringify(rule.condition)
              }" of rule "${rule.name}" for the file ${file}`,
            );
            break changedFilesLoop;
          }
        }
        break;
      }
      case "diff": {
        isMatched = includeCondition.test(diff) && !excludeCondition?.test(diff);
        if (isMatched) {
          logger.info(
            `Matched expression "${
              typeof rule.condition === "string" ? rule.condition : JSON.stringify(rule.condition)
            }" of rule "${rule.name}" on diff`,
          );
        }
        break;
      }
      default: {
        const exhaustivenessCheck: never = rule.check_type;
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        logger.fatal(`Check type is not handled: ${exhaustivenessCheck}`);
        return commitStateFailure;
      }
    }
    if (!isMatched) {
      continue;
    }

    if (/* BasicRule */ "min_approvals" in rule) {
      if (typeof rule.min_approvals !== "number") {
        logger.fatal(`Rule "${rule.name}" has invalid min_approvals`);
        logger.info(rule);
        return commitStateFailure;
      }

      matchedRules.push({
        name: rule.name,
        subconditions: [
          {
            name: rule.name,
            min_approvals: rule.min_approvals,
            usersInfo: await getUsersInfo(rule.users ?? [], rule.teams ?? []),
          },
        ],
        kind: "BasicRule",
      });
    } else if (/* AndRule */ "all" in rule) {
      await processComplexRule("AndRule", rule.name, rule.all);
    } else if (/* OrRule */ "any" in rule) {
      await processComplexRule("OrRule", rule.name, rule.any);
    } else if (/* AndDistinctRule */ "all_distinct" in rule) {
      await processComplexRule("AndDistinctRule", rule.name, rule.all_distinct);
    } else {
      const unmatchedRule = rule as BaseRule;
      throw new Error(`Rule "${unmatchedRule.name}" could not be matched to any known kind`);
    }
  }

  if (matchedRules.length !== 0) {
    const reviews = await api.fetchReviews();

    const latestReviews: Map<number, { id: number; user: string; isApproval: boolean }> = new Map();

    if (!preventReviewRequest?.users?.find((u) => u === pr.user.login)) {
      latestReviews.set(-1, { id: -1, user: pr.user.login, isApproval: true });
    }
    for (const review of reviews) {
      // https://docs.github.com/en/graphql/reference/enums#pullrequestreviewstate
      if (
        // Comments do not affect the approval's status
        review.state === "COMMENTED" ||
        // The user might've been deleted
        review.user === null ||
        review.user === undefined
      ) {
        continue;
      }
      const prevReview = latestReviews.get(review.user.id);
      if (
        prevReview === undefined ||
        // The latest review is the one with the highest id
        prevReview.id < review.id
      ) {
        latestReviews.set(review.user.id, {
          id: review.id,
          user: review.user.login,
          isApproval: review.state === "APPROVED",
        });
      }
    }
    const reviewers = Array.from(latestReviews.values());
    logger.info("latestReviews are", JSON.stringify(reviewers));

    const rulesOutcomes: (RuleFailure | undefined)[] = matchedRules.map((rule) => {
      const ruleUserCount = rule.subconditions.reduce((acc, { usersInfo }) => acc + usersInfo.size, 0);

      if (ruleUserCount === 0) {
        const minApprovals = (() => {
          switch (rule.kind) {
            case "AndDistinctRule": {
              return rule.subconditions.reduce((acc, { min_approvals }) => acc + min_approvals, 0);
            }
            case "BasicRule":
            case "AndRule": {
              return Math.max(...rule.subconditions.map(({ min_approvals }) => min_approvals));
            }
            case "OrRule": {
              return Math.min(...rule.subconditions.map(({ min_approvals }) => min_approvals));
            }
            default: {
              const exhaustivenessCheck: never = rule.kind;
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              const message = `Rule kind not handled: ${exhaustivenessCheck}`;
              logger.fatal(message);
              throw new Error(message);
            }
          }
        })();

        let approvalCount = 0;
        for (const review of latestReviews.values()) {
          if (review.isApproval && ++approvalCount >= minApprovals) {
            return;
          }
        }

        return new RuleFailure(
          rule,
          `Rule "${rule.name}" requires at least ${minApprovals} approvals, but ${approvalCount} were given.`,
          new Map(),
        );
      }

      switch (rule.kind) {
        case "AndDistinctRule": {
          const approvedBy: Set<string> = new Set();

          for (const review of latestReviews.values()) {
            if (review.isApproval && rule.subconditions.find(({ usersInfo }) => usersInfo.has(review.user))) {
              approvedBy.add(review.user);
            }
          }

          const minApprovals = rule.subconditions.reduce((acc, { min_approvals }) => acc + min_approvals, 0);

          const approvalGroups = rule.subconditions.map((subcondition) => {
            const subconditionApprovedBy: Set<string> = new Set();

            for (const user of subcondition.usersInfo.keys()) {
              if (approvedBy.has(user)) {
                subconditionApprovedBy.add(user);
              }
            }

            return { subcondition, subconditionApprovedBy };
          });

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
              available permutation of approvals' orders and picking the best
              one found, with bailouts for when the overall target approval
              count is reached.
            */
          type CombinationApprovedBy = Map<
            /* subcondition Index */ number,
            /* users which approved the subcondition */ Set<string>
          >;
          let bestApproversCombination: CombinationApprovedBy = new Map();

          for (let i = 0; i < approvalGroups.length; i++) {
            subconditionCombinationsLoop: for (const userStartingCombination of approvalGroups[i]
              .subconditionApprovedBy) {
              /*
                  The combinations are tried by alternating which user starts
                  the combination on each pass.

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
                  2: Iterate through all approvers of Subcondition 1
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
              const combinationApprovers: CombinationApprovedBy = new Map([[i, new Set([userStartingCombination])]]);

              /*
                  The least bad combination is the first one tried, since at
                  least it has one approval
                */
              if (bestApproversCombination.size === 0) {
                bestApproversCombination = combinationApprovers;
              }

              subconditionsLoop: for (let j = 0; j < approvalGroups.length; j++) {
                const { subcondition, subconditionApprovedBy } = approvalGroups[j];

                /*
                    Check if the subcondition's min_approvals target has already
                    been fulfilled by the initialization of
                    combinationApprovedBy
                  */
                if (j === i) {
                  const approversCount = combinationApprovers.get(j)?.size;
                  assert(approversCount, "approversCount should be >=0 because combinationApprovers was initialized");
                  if (approversCount === subcondition.min_approvals) {
                    continue;
                  }
                }

                let approvalCountAtStartOfPermutation = 0;
                for (const approvers of combinationApprovers.values()) {
                  approvalCountAtStartOfPermutation += approvers.size;
                }

                const subconditionApproversPermutator = new Permutator(
                  /*
                       Permutator mutates the input array, therefore make sure
                       to *not* pass an array reference to it
                    */
                  Array.from(subconditionApprovedBy),
                );
                while (subconditionApproversPermutator.hasNext()) {
                  const usersPermutation = subconditionApproversPermutator.next();

                  /*
                      Initialize a new Set here so that the effects of this
                      permutation doesn't affect combinationApprovers until it
                      is the right time to commit the results
                    */
                  const subconditionApprovers = new Set(combinationApprovers.get(j)?.values());

                  usersPermutationLoop: for (const user of usersPermutation) {
                    for (const approvers of combinationApprovers.values()) {
                      if (approvers.has(user)) {
                        continue usersPermutationLoop;
                      }
                    }

                    if (subconditionApprovers.has(user)) {
                      continue usersPermutationLoop;
                    }

                    subconditionApprovers.add(user);

                    /*
                        We only want to commit subconditionApprovers to
                        combinationApprovers if the current approval count is
                        higher than the current best one
                      */
                    if (subconditionApprovers.size < (combinationApprovers.get(j)?.size ?? 0)) {
                      continue;
                    }

                    combinationApprovers.set(j, subconditionApprovers);

                    let approvalCountNow = 0;
                    for (const users of combinationApprovers.values()) {
                      approvalCountNow += users.size;
                    }
                    if (approvalCountNow === minApprovals) {
                      /*
                          Bail out when combination which fulfills all
                          subconditions is found
                        */
                      bestApproversCombination = combinationApprovers;
                      break subconditionCombinationsLoop;
                    }

                    let approvalCountOfBestCombination = 0;
                    for (const approvers of bestApproversCombination.values()) {
                      approvalCountOfBestCombination += approvers.size;
                    }
                    if (approvalCountNow > approvalCountOfBestCombination) {
                      bestApproversCombination = combinationApprovers;
                    }

                    if (approvalCountNow - approvalCountAtStartOfPermutation === subcondition.min_approvals) {
                      continue subconditionsLoop;
                    }
                  }
                }
              }
            }
          }

          let approvalCountOfBestApproversArrangement = 0;
          for (const approvers of bestApproversCombination.values()) {
            approvalCountOfBestApproversArrangement += approvers.size;
          }
          assert(
            approvalCountOfBestApproversArrangement <= minApprovals,
            "Subconditions should not accumulate more approvals than necessary",
          );

          // It's only meaningful to log this if some approval was had
          if (approvalCountOfBestApproversArrangement > 0) {
            logger.log({
              ruleName: rule.name,
              approvalCountOfBestCombination: approvalCountOfBestApproversArrangement,
              combinationApprovedByMostPeopleOverall: new Map(
                Array.from(bestApproversCombination).map(([subconditionIndex, approvers]) => [
                  rule.subconditions[subconditionIndex].name ?? `${rule.name}[${subconditionIndex}]`,
                  approvers,
                ]),
              ),
            });
          }

          if (approvalCountOfBestApproversArrangement === minApprovals) {
            for (const [subconditionIndex, approvers] of bestApproversCombination) {
              const subcondition = rule.subconditions[subconditionIndex];
              assert(
                approvers.size === subcondition.min_approvals,
                `Subcondition "${
                  subcondition.name ?? `${rule.name}[${subconditionIndex}]`
                }"'s approvers should have exactly ${rule.subconditions[subconditionIndex].min_approvals} approvals`,
              );
            }
          } else {
            const usersToAskForReview: Map<string, RuleUserInfo> = new Map();

            const unfulfilledSubconditionsErrorMessage = approvalGroups.reduce(
              (acc, { subcondition }, subconditionIndex) => {
                const approversCount = bestApproversCombination.get(subconditionIndex)?.size ?? 0;

                if (approversCount === subcondition.min_approvals) {
                  return acc;
                }

                assert(
                  approversCount <= subcondition.min_approvals,
                  "Subconditions should not accumulate more approvals than necessary",
                );

                const missingApprovers = processSubconditionMissingApprovers(
                  approvedBy,
                  usersToAskForReview,
                  subcondition.usersInfo,
                );

                return `${acc}\nSubcondition "${
                  subcondition.name
                }" does not have approval from the following users: ${Array.from(missingApprovers.entries())
                  .map(([user, { teams }]) => displayUserWithTeams(user, teams))
                  .join(", ")}.`;
              },
              "",
            );

            const problem = `Rule "${rule.name}" needs in total ${minApprovals} DISTINCT approvals, but ${approvalCountOfBestApproversArrangement} were given. Users whose approvals counted towards one criterion are excluded from other criteria. For example: even if a user belongs multiple teams, their approval will only count towards one of them; or even if a user is referenced in multiple subconditions, their approval will only count towards one subcondition.${unfulfilledSubconditionsErrorMessage}`;

            return new RuleFailure(rule, problem, usersToAskForReview);
          }
          break;
        }
        case "AndRule":
        case "BasicRule":
        case "OrRule": {
          const usersToAskForReview: Map<string, RuleUserInfo> = new Map();
          const problems: string[] = [];

          for (const subcondition of rule.subconditions) {
            const approvedBy: Set<string> = new Set();

            for (const review of latestReviews.values()) {
              if (review.isApproval && subcondition.usersInfo.has(review.user)) {
                approvedBy.add(review.user);
              }
            }

            if (approvedBy.size >= subcondition.min_approvals) {
              if (rule.kind === "OrRule") {
                return;
              } else {
                continue;
              }
            }

            const missingApprovers = processSubconditionMissingApprovers(
              approvedBy,
              usersToAskForReview,
              subcondition.usersInfo,
            );

            problems.push(
              `${
                rule.subconditions.length === 1 ? `Rule "${rule.name}"` : `Subcondition "${subcondition.name}"`
              } needs at least ${subcondition.min_approvals} approvals, but ${
                approvedBy.size
              } were given. The following users have not approved yet: ${Array.from(missingApprovers.entries())
                .map(([user, { teams }]) => displayUserWithTeams(user, teams))
                .join(", ")}.`,
            );
          }

          if (problems.length) {
            return new RuleFailure(rule, problems.join("\n"), usersToAskForReview);
          }

          break;
        }
        default: {
          const exhaustivenessCheck: never = rule.kind;
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          const failureMessage = `Rule kind is not handled: ${exhaustivenessCheck}`;
          logger.fatal(failureMessage);
          throw new Error(failureMessage);
        }
      }
    });

    const problems: string[] = [];
    const usersToAskForReview: Map<string, RuleUserInfo> = new Map();

    for (const outcome of rulesOutcomes) {
      if (outcome === undefined) {
        continue;
      }

      problems.push(outcome.problem);

      for (const [user, userInfo] of outcome.usersToAskForReview) {
        updateUserToAskForReview(usersToAskForReview, user, userInfo);
      }
    }

    if (usersToAskForReview.size !== 0) {
      logger.info("usersToAskForReview", usersToAskForReview);
      const teams: Set<string> = new Set();
      const users: Set<string> = new Set();
      for (const [user, userInfo] of usersToAskForReview) {
        if (userInfo.teams === null) {
          if (!preventReviewRequest?.users?.includes(user)) {
            users.add(user);
          }
        } else {
          for (const team of userInfo.teams) {
            if (!preventReviewRequest?.teams?.includes(team)) {
              teams.add(team);
            }
          }
        }
      }
      const usersToRequest = Array.from(users).filter((u) => u !== pr.user.login);
      if (usersToRequest.length || teams.size) {
        await api.requestReviewers(usersToRequest, Array.from(teams));
      }
    }

    if (problems.length !== 0) {
      logger.fatal("The following problems were found:");
      for (const problem of problems) {
        logger.info(problem);
      }
      logger.info("");
      return commitStateFailure;
    }
  }

  return commitStateSuccess;
};

export const getFinishProcessReviews =
  (
    { octokit, logger }: Omit<Context, "finishProcessReviews">,
    { jobName, detailsUrl, pr, runId, actionRepository }: ActionData,
  ) =>
  async (state: CommitState) => {
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
      });
      for (const job of jobs) {
        if (job.name === jobName) {
          let stepNumber: number | undefined = undefined;
          if (actionRepository !== undefined) {
            const actionRepositoryMatch = actionRepository.match(/[^/]*$/);
            if (actionRepositoryMatch === null) {
              logger.warn(`Action repository name could not be extracted from ${actionRepository}`);
            } else {
              const actionStep = job.steps?.find(({ name }) => name === actionRepositoryMatch[0]);
              if (actionStep === undefined) {
                logger.warn(`Failed to find ${actionRepositoryMatch[0]} in the job's steps`, job.steps);
              } else {
                stepNumber = actionStep.number;
              }
            }
          }
          detailsUrl = `${job.html_url as string}${
            stepNumber ? `#step:${stepNumber}:${logger.relevantStartingLine}` : ""
          }`;
          break;
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
    });

    logger.info(`Final state: ${state}`);
  };

export const processReviews = async (ctx: Context, { pr }: ActionData) => {
  const { finishProcessReviews, logger } = ctx;
  const githubApi = new GitHubApi(pr, ctx);
  return await runChecks({ ...ctx, pr }, githubApi)
    .then((state) => {
      if (finishProcessReviews) {
        return finishProcessReviews(state);
      }
    })
    .catch((error) => {
      logger.fatal(error);
      if (finishProcessReviews) {
        return finishProcessReviews("failure");
      }
    });
};
