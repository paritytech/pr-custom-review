import Joi from "joi"

import { Configuration, Rule, RuleCriteria } from "./types"

const ruleCriteria = {
  min_approvals: Joi.number().optional().min(1).allow(null),
  users: Joi.array().items(Joi.string()).optional().allow(null),
  teams: Joi.array().items(Joi.string()).optional().allow(null),
}

const ruleSchema = Joi.object<Rule>().keys({
  name: Joi.string().required(),
  condition: Joi.string().required(),
  check_type: Joi.string().valid("diff", "changed_files").required(),
  ...ruleCriteria,
  all: Joi.array()
    .items(Joi.object<RuleCriteria>().keys(ruleCriteria))
    .optional()
    .allow(null),
  any: Joi.array()
    .items(Joi.object<RuleCriteria>().keys(ruleCriteria))
    .optional()
    .allow(null),
})

export const configurationSchema = Joi.object<Configuration>().keys({
  rules: Joi.array().items(ruleSchema).required(),
})
