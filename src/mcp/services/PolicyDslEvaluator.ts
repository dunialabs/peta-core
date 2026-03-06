import { createLogger } from '../../logger/index.js';

const logger = createLogger('PolicyDslEvaluator');

export interface PolicyRule {
  id: string;
  priority?: number;
  match: { tool?: string; serverId?: string };
  extract?: Record<string, { path: string; type: 'string' | 'number' | 'boolean' | 'url.host' | 'bytes.length' }>;
  when?: Array<{ left: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'matches'; right: unknown }>;
  effect: { decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'; reason?: string };
}

export interface PolicyDsl {
  rules: PolicyRule[];
}

export interface PolicyEvaluationContext {
  serverId: string | null;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicyEvaluationResult {
  decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  matchedRuleId: string | null;
  reason: string | null;
}

export class PolicyDslEvaluator {
  evaluate(dsl: PolicyDsl, context: PolicyEvaluationContext): PolicyEvaluationResult {
    const sortedRules = [...dsl.rules].sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));

    for (const rule of sortedRules) {
      if (!this.matchesRule(rule, context)) {
        continue;
      }

      const extractedVars = this.extractVariables(rule.extract ?? {}, context.args);
      const conditionScope = {
        ...context.args,
        ...extractedVars,
        args: context.args,
      };

      const allConditionsPass = (rule.when ?? []).every((condition) =>
        this.evaluateCondition(
          this.resolveOperand(condition.left, conditionScope),
          condition.op,
          this.resolveOperand(condition.right, conditionScope)
        )
      );

      if (!allConditionsPass) {
        continue;
      }

      logger.debug({ ruleId: rule.id, decision: rule.effect.decision }, 'DSL rule matched');
      return {
        decision: rule.effect.decision,
        matchedRuleId: rule.id,
        reason: rule.effect.reason ?? null,
      };
    }

    return {
      decision: 'ALLOW',
      matchedRuleId: null,
      reason: null,
    };
  }

  private matchesRule(rule: PolicyRule, context: PolicyEvaluationContext): boolean {
    if (rule.match.serverId !== undefined) {
      if (context.serverId === null) {
        return false;
      }
      if (!this.matchGlob(rule.match.serverId, context.serverId)) {
        return false;
      }
    }

    if (rule.match.tool !== undefined && !this.matchGlob(rule.match.tool, context.toolName)) {
      return false;
    }

    return true;
  }

  private extractVariables(
    extractors: Record<string, { path: string; type: 'string' | 'number' | 'boolean' | 'url.host' | 'bytes.length' }>,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const vars: Record<string, unknown> = {};

    for (const [name, extractor] of Object.entries(extractors)) {
      const rawValue = this.extractByPath(args, extractor.path);
      if (rawValue === undefined) {
        continue;
      }

      const coercedValue = this.coerceType(rawValue, extractor.type);
      if (coercedValue !== undefined) {
        vars[name] = coercedValue;
      }
    }

    return vars;
  }

  private coerceType(
    value: unknown,
    type: 'string' | 'number' | 'boolean' | 'url.host' | 'bytes.length'
  ): unknown {
    switch (type) {
      case 'string':
        return String(value);
      case 'number': {
        const parsed = parseFloat(String(value));
        return Number.isNaN(parsed) ? undefined : parsed;
      }
      case 'boolean':
        if (typeof value === 'boolean') {
          return value;
        }
        if (typeof value === 'string') {
          if (value.toLowerCase() === 'true') {
            return true;
          }
          if (value.toLowerCase() === 'false') {
            return false;
          }
        }
        if (typeof value === 'number') {
          return value !== 0;
        }
        return Boolean(value);
      case 'url.host':
        try {
          return new URL(String(value)).hostname;
        } catch {
          return undefined;
        }
      case 'bytes.length':
        return Buffer.byteLength(String(value));
      default:
        return undefined;
    }
  }

  private resolveOperand(operand: unknown, scope: Record<string, unknown>): unknown {
    if (typeof operand !== 'string') {
      return operand;
    }

    // $-prefixed strings are explicit variable references into the scope
    if (operand.startsWith('$')) {
      return this.extractByPath(scope, operand.slice(1));
    }

    // Plain strings are always treated as literal values — no path fallback
    return operand;
  }

  private evaluateCondition(
    left: unknown,
    op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'matches',
    right: unknown
  ): boolean {
    switch (op) {
      case 'eq':
        return left === right;
      case 'neq':
        return left !== right;
      case 'gt':
        return Number(left) > Number(right);
      case 'gte':
        return Number(left) >= Number(right);
      case 'lt':
        return Number(left) < Number(right);
      case 'lte':
        return Number(left) <= Number(right);
      case 'in':
        return Array.isArray(right) && right.includes(left);
      case 'not_in':
        return Array.isArray(right) && !right.includes(left);
      case 'matches': {
        const pattern = String(right);
        if (pattern.length > 512) {
          logger.warn({ patternLength: pattern.length }, 'Regex pattern too long in DSL condition');
          return false;
        }
        const subject = String(left);
        if (subject.length > 4096) {
          logger.warn({ subjectLength: subject.length }, 'Regex subject too long in DSL condition');
          return false;
        }
        try {
          return new RegExp(pattern).test(subject);
        } catch {
          logger.warn({ pattern: right }, 'Invalid regex in DSL condition');
          return false;
        }
      }
      default:
        return false;
    }
  }

  private matchGlob(pattern: string, value: string): boolean {
    if (pattern.length > 512) {
      logger.warn({ patternLength: pattern.length }, 'Glob pattern too long in DSL matcher');
      return false;
    }
    let regexPattern = '^';

    for (const char of pattern) {
      if (char === '*') {
        regexPattern += '.*';
      } else if (char === '?') {
        regexPattern += '.';
      } else if ('\\^$+?.()|{}[]'.includes(char)) {
        regexPattern += `\\${char}`;
      } else {
        regexPattern += char;
      }
    }

    regexPattern += '$';
    return new RegExp(regexPattern).test(value);
  }

  private extractByPath(obj: unknown, path: string): unknown {
    if (!path) {
      return obj;
    }

    return path.split('.').reduce<unknown>((current, segment) => {
      if (current && typeof current === 'object' && segment in current) {
        return (current as Record<string, unknown>)[segment];
      }
      return undefined;
    }, obj);
  }
}

export const policyDslEvaluator = new PolicyDslEvaluator();
