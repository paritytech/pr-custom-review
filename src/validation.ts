import Joi from "joi"

import {
  AndDistinctRule,
  AndRule,
  BasicRule,
  Configuration,
  OrRule,
  RuleCriteria,
} from "./types"

const ruleCriterion = ({
  isMinApprovalsAllowed,
  isNameOptional,
}: {
  isMinApprovalsAllowed: boolean
  isNameOptional: boolean
}) => {
  let name = Joi.string()
  if (isNameOptional) {
    name = name.optional().allow(null)
  } else {
    name = name.required()
  }

  return {
    name,
    users: Joi.array().items(Joi.string()).optional().allow(null),
    teams: Joi.array().items(Joi.string()).optional().allow(null),
    ...(isMinApprovalsAllowed
      ? { min_approvals: Joi.number().min(1).required() }
      : {}),
  }
}

const ruleCriterionArraySchema = Joi.array()
  .items(
    Joi.object<RuleCriteria>().keys(
      ruleCriterion({ isMinApprovalsAllowed: true, isNameOptional: true }),
    ),
  )
  .required()

const includeConditionSchema = Joi.string().required()
const excludeConditionSchema = Joi.string().required()
const commonRuleSchema = {
  name: Joi.string().required(),
  condition: Joi.alternatives([
    includeConditionSchema,
    Joi.object().keys({ include: includeConditionSchema }),
    Joi.object().keys({ exclude: excludeConditionSchema }),
    Joi.object().keys({
      include: includeConditionSchema,
      exclude: excludeConditionSchema,
    }),
  ]).required(),
  check_type: Joi.string().valid("diff", "changed_files").required(),
}

const ruleSchema = Joi.alternatives([
  Joi.object<BasicRule>().keys({
    ...commonRuleSchema,
    ...ruleCriterion({ isMinApprovalsAllowed: true, isNameOptional: false }),
  }),
  Joi.object<AndRule>().keys({
    ...commonRuleSchema,
    all: ruleCriterionArraySchema,
  }),
  Joi.object<OrRule>().keys({
    ...commonRuleSchema,
    any: ruleCriterionArraySchema,
  }),
  Joi.object<AndDistinctRule>().keys({
    ...commonRuleSchema,
    all_distinct: ruleCriterionArraySchema,
  }),
])

export const configurationSchema = Joi.object<Configuration>().keys({
  "locks-review-team": Joi.string().required(),
  "team-leads-team": Joi.string().required(),
  "action-review-team": Joi.string().required(),
  rules: Joi.array().items(ruleSchema).required(),
  "prevent-review-request": Joi.object<
    Configuration["prevent-review-request"]
  >()
    .keys({
      users: Joi.array().items(Joi.string()).optional().allow(null),
      teams: Joi.array().items(Joi.string()).optional().allow(null),
    })
    .optional()
    .allow(null),
})
