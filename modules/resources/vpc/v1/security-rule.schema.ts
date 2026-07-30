import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// SecurityRule Props (user input)
// ---------------------------------------------------------------------------

const securityRuleValid = Schema.makeFilter((rule: Record<string, unknown>) => {
  const issues: Array<Schema.FilterIssue> = []

  // Priority must be 0–1000
  if (rule.priority !== undefined && typeof rule.priority === 'number') {
    if (!Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 1000) {
      issues.push({ path: ['priority'], issue: `Priority must be 0-1000, got ${rule.priority}` })
    }
  }

  // Check ingress/egress alignment with direction
  if (rule.direction === 'INGRESS' && rule.egress !== undefined) {
    issues.push({ path: ['egress'], issue: 'Egress rules cannot be specified when direction is INGRESS' })
  }
  if (rule.direction === 'EGRESS' && rule.ingress !== undefined) {
    issues.push({ path: ['ingress'], issue: 'Ingress rules cannot be specified when direction is EGRESS' })
  }

  return issues
})

const ruleIngressValid = Schema.makeFilter((ingress: Record<string, unknown>) => {
  const issues: Array<Schema.FilterIssue> = []
  const cidrs = ingress.sourceCidrs as string[] | undefined
  if (cidrs && cidrs.length > 8) {
    issues.push({ path: ['sourceCidrs'], issue: `Maximum 8 source CIDRs allowed, got ${cidrs.length}` })
  }
  const ports = ingress.destinationPorts as number[] | undefined
  if (ports && ports.length > 8) {
    issues.push({ path: ['destinationPorts'], issue: `Maximum 8 destination ports allowed, got ${ports.length}` })
  }
  return issues
})

const ruleEgressValid = Schema.makeFilter((egress: Record<string, unknown>) => {
  const issues: Array<Schema.FilterIssue> = []
  const cidrs = egress.destinationCidrs as string[] | undefined
  if (cidrs && cidrs.length > 8) {
    issues.push({ path: ['destinationCidrs'], issue: `Maximum 8 destination CIDRs allowed, got ${cidrs.length}` })
  }
  const ports = egress.destinationPorts as number[] | undefined
  if (ports && ports.length > 8) {
    issues.push({ path: ['destinationPorts'], issue: `Maximum 8 destination ports allowed, got ${ports.length}` })
  }
  return issues
})

const RuleIngressSchema = Schema.Struct({
  sourceSecurityGroupId: Schema.optional(Ids.SecurityGroupId),
  sourceCidrs: Schema.optional(Schema.Array(Schema.String)),
  destinationPorts: Schema.optional(Schema.Array(Schema.Finite.check(Validation.isValidPort))),
}).check(ruleIngressValid)

const RuleEgressSchema = Schema.Struct({
  destinationSecurityGroupId: Schema.optional(Ids.SecurityGroupId),
  destinationCidrs: Schema.optional(Schema.Array(Schema.String)),
  destinationPorts: Schema.optional(Schema.Array(Schema.Finite.check(Validation.isValidPort))),
}).check(ruleEgressValid)

export const SecurityRulePropsSchema = Schema.Struct({
  parentId: Ids.SecurityGroupId,
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  direction: Schema.Union([Schema.Literal('INGRESS'), Schema.Literal('EGRESS')]),
  protocol: Schema.Union([Schema.Literal('ANY'), Schema.Literal('TCP'), Schema.Literal('UDP'), Schema.Literal('ICMP')]),
  access: Schema.Union([Schema.Literal('ALLOW'), Schema.Literal('DENY')]),
  priority: Schema.optional(Schema.Finite),
  type: Schema.optional(Schema.Union([Schema.Literal('STATEFUL'), Schema.Literal('STATELESS')])),
  ingress: Schema.optional(RuleIngressSchema),
  egress: Schema.optional(RuleEgressSchema),
  description: Schema.optional(Schema.String),
}).check(securityRuleValid)

export type SecurityRuleProps = typeof SecurityRulePropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateSecurityRuleProps = Validation.makeValidateProps(SecurityRulePropsSchema)

// ---------------------------------------------------------------------------
// SecurityRule Attributes (output)
// ---------------------------------------------------------------------------

export const SecurityRuleId = Schema.String.pipe(Schema.brand('SecurityRuleId'))
export type SecurityRuleId = typeof SecurityRuleId.Type

export const SecurityRuleAttributesSchema = Schema.Struct({
  id: SecurityRuleId,
  parentId: Ids.SecurityGroupId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  direction: Schema.Union([Schema.Literal('INGRESS'), Schema.Literal('EGRESS')]),
  protocol: Schema.Union([Schema.Literal('ANY'), Schema.Literal('TCP'), Schema.Literal('UDP'), Schema.Literal('ICMP')]),
  access: Schema.Union([Schema.Literal('ALLOW'), Schema.Literal('DENY')]),
  priority: Schema.Finite,
  type: Schema.Union([Schema.Literal('STATEFUL'), Schema.Literal('STATELESS')]),
  description: Schema.String,
  state: Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')]),
  effectivePriority: Schema.Finite,
})

export type SecurityRuleAttributes = typeof SecurityRuleAttributesSchema.Type
