import { GitHub } from "@actions/github/lib/utils";
import YAML from "yaml";

import { configFilePath } from "src/constants";
import { Configuration, Context, PR } from "src/types";
import { configurationSchema } from "src/validation";

import { ActionLoggerInterface } from "./action/logger";

export class GitHubApi {
  private readonly octokit: InstanceType<typeof GitHub>;
  private readonly logger: ActionLoggerInterface;
  constructor(private readonly pr: PR, { octokit, logger }: Context) {
    this.octokit = octokit;
    this.logger = logger;
  }

  async fetchConfigFile(): Promise<Configuration | null> {
    const configFileResponse = await this.octokit.rest.repos.getContent({
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      path: configFilePath,
    });
    if (!("content" in configFileResponse.data)) {
      this.logger.fatal(`Did not find "content" key in the response for ${configFilePath}`);
      this.logger.info(configFileResponse.data);
      return null;
    }

    const { content: configFileContentsEnconded } = configFileResponse.data;
    if (typeof configFileContentsEnconded !== "string") {
      this.logger.fatal(`Content response for ${configFilePath} had unexpected type (expected string)`);
      this.logger.info(configFileResponse.data);
      return null;
    }

    const configFileContents = Buffer.from(configFileContentsEnconded, "base64").toString("utf-8");

    const configValidationResult = configurationSchema.validate(YAML.parse(configFileContents));
    if (configValidationResult.error) {
      this.logger.fatal("Configuration file is invalid");
      this.logger.info(configValidationResult.error);
      return null;
    }

    return configValidationResult.value;
  }
}
