import { PR } from "src/types";

export type ActionData = {
  detailsUrl: string;
  jobName: string | undefined;
  actionRepository: string | undefined;
  pr: PR;
  runId: number;
};
