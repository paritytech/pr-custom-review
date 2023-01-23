import { Octokit } from "@octokit/rest";
import nock from "nock";
import {
  basePR,
  changedFilesApiPath,
  condition,
  configFileContentsApiPath,
  defaultTeamsNames,
  githubApi,
  prApiPath,
  rulesExamples,
} from "test/constants";
import { TestLogger } from "test/logger";
import YAML from "yaml";

import { rulesConfigurations } from "src/constants";
import { runChecks } from "src/core";

const setup = ({ rules }: { rules?: Record<string, unknown>[] }) => {
  nock(githubApi)
    .get(configFileContentsApiPath)
    .reply(200, { content: Buffer.from(YAML.stringify({ ...defaultTeamsNames, rules })).toString("base64") });
};

describe("Configuration", () => {
  let logger: TestLogger;
  let octokit: Octokit;
  let logHistory: string[];

  beforeEach(() => {
    nock.disableNetConnect();
    logHistory = [];
    logger = new TestLogger(logHistory);
    octokit = new Octokit();
    nock(githubApi).get(prApiPath).matchHeader("accept", "application/vnd.github.v3.diff").reply(200, condition);
    nock(githubApi)
      .get(changedFilesApiPath)
      .reply(200, [{ filename: condition }]);
  });

  for (const { kind, invalidFields } of Object.values(rulesConfigurations)) {
    const goodRule = rulesExamples[kind];

    for (const invalidField of invalidFields) {
      const invalidFieldValidValue = (() => {
        switch (invalidField) {
          case "all":
          case "all_distinct":
          case "teams":
          case "users":
          case "any": {
            return [];
          }
          case "min_approvals": {
            return 1;
          }
          default: {
            const exhaustivenessCheck: never = invalidField;
            throw new Error(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `invalidField is not handled: ${exhaustivenessCheck}`,
            );
          }
        }
      })();

      it(`Rule kind ${kind} does not allow invalid field ${invalidField}`, async () => {
        const badRule = { ...goodRule, [invalidField]: invalidFieldValidValue };

        setup({ rules: [badRule] });

        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null })).toBe("failure");

        expect(logHistory).toMatchSnapshot();
      });
    }
  }

  for (const [kind, exampleRule] of Object.entries(rulesExamples)) {
    for (const [invalidValue, description] of [
      [0, "less than 1"],
      [null, "null"],
    ]) {
      it(`min_approvals is invalid for ${kind} if it is ${String(description)}`, async () => {
        setup({
          rules: [
            {
              ...exampleRule,
              ...("min_approvals" in exampleRule
                ? { min_approvals: invalidValue }
                : "all" in exampleRule
                ? { all: [{ min_approvals: invalidValue }] }
                : "any" in exampleRule
                ? { any: [{ min_approvals: invalidValue }] }
                : "all_distinct" in exampleRule
                ? { all_distinct: [{ min_approvals: invalidValue }] }
                : {}),
            },
          ],
        });

        expect(await runChecks({ pr: basePR, octokit, logger, finishProcessReviews: null })).toBe("failure");

        expect(logHistory).toMatchSnapshot();
      });
    }
  }

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });
});
