import Joi from "joi"

import { Configuration, Rule } from "./types"

const ruleSchema = Joi.object<Rule>().keys({
  name: Joi.string().required(),
  condition: Joi.string().required(),
  check_type: Joi.string().valid("diff", "changed_files").required(),
  min_approvals: Joi.number().required(),
  users: Joi.array().items(Joi.string()).optional().allow(null),
  teams: Joi.array().items(Joi.string()).optional().allow(null),
})

export const configurationSchema = Joi.object<Configuration>().keys({
  rules: Joi.array().items(ruleSchema).required(),
})
