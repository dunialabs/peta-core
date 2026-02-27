/**
 * PolicyEngine - Content-Aware Tool Policy Evaluation Orchestrator
 *
 * Evaluates tool call arguments against configured policies to produce
 * a decision: ALLOW, REQUIRE_APPROVAL, or DENY.
 *
 * Integration flow:
 * 1. ProxySession.handleToolCall() invokes PolicyEngine.evaluate()
 * 2. PolicyEngine loads effective policies (global + server-specific)
 * 3. PolicyDslEvaluator evaluates DSL rules against tool call context
 * 4. Returns PolicyDecision that determines the approval flow
 *
 * When no policies are configured, the engine falls through to the
 * existing DangerLevel system (backward compatible).
 */

import { createLogger } from '../../logger/index.js';
import { DangerLevel, PolicyDecision } from '../../types/enums.js';
import { PolicyRepository } from '../../repositories/PolicyRepository.js';
import {
  policyDslEvaluator,
  PolicyDsl,
  PolicyEvaluationResult,
} from './PolicyDslEvaluator.js';

const logger = createLogger('PolicyEngine');

export interface PolicyEvaluateParams {
  userId: string;
  serverId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  dangerLevel: DangerLevel;
}

export interface PolicyEvaluateResult {
  decision: PolicyDecision;
  policyVersion: number;
  matchedRuleId: string | null;
  reason: string | null;
}

export class PolicyEngine {
  private static instance: PolicyEngine;

  private constructor() {}

  static getInstance(): PolicyEngine {
    if (!PolicyEngine.instance) {
      PolicyEngine.instance = new PolicyEngine();
    }
    return PolicyEngine.instance;
  }

  /**
   * Evaluate a tool call against configured policies.
   *
   * Priority chain:
   * 1. Content-aware DSL policies (if any are configured)
   * 2. Fallback to DangerLevel system (existing behavior)
   *
   * @returns PolicyEvaluateResult with the final decision
   */
  async evaluate(params: PolicyEvaluateParams): Promise<PolicyEvaluateResult> {
    const { userId, serverId, toolName, args, dangerLevel } = params;

    const policies = await PolicyRepository.getEffectivePolicy(serverId);

    if (policies.length === 0) {
      return this.fallbackToDangerLevel(dangerLevel);
    }

    for (const policySet of policies) {
      const dsl = policySet.dsl as unknown as PolicyDsl;

      if (!dsl || !dsl.rules || dsl.rules.length === 0) {
        continue;
      }

      const result: PolicyEvaluationResult = policyDslEvaluator.evaluate(dsl, {
        serverId,
        toolName,
        args,
      });

      if (result.matchedRuleId !== null) {
        const decision = this.mapDecision(result.decision);

        logger.info(
          {
            userId,
            serverId,
            toolName,
            ruleId: result.matchedRuleId,
            decision: result.decision,
            policySetId: policySet.id,
            policyVersion: policySet.version,
          },
          'Policy rule matched'
        );

        return {
          decision,
          policyVersion: policySet.version,
          matchedRuleId: result.matchedRuleId,
          reason: result.reason,
        };
      }
    }


    logger.debug(
      { userId, serverId, toolName },
      'No policy rule matched, falling back to DangerLevel'
    );

    return this.fallbackToDangerLevel(dangerLevel);
  }

  private fallbackToDangerLevel(dangerLevel: DangerLevel): PolicyEvaluateResult {
    let decision: PolicyDecision;

    switch (dangerLevel) {
      case DangerLevel.Approval:
        decision = PolicyDecision.RequireApproval;
        break;
      case DangerLevel.Notification:
      case DangerLevel.Silent:
      default:
        decision = PolicyDecision.Allow;
        break;
    }

    return {
      decision,
      policyVersion: 0,
      matchedRuleId: null,
      reason: null,
    };
  }

  private mapDecision(decision: string): PolicyDecision {
    switch (decision) {
      case 'ALLOW':
        return PolicyDecision.Allow;
      case 'REQUIRE_APPROVAL':
        return PolicyDecision.RequireApproval;
      case 'DENY':
        return PolicyDecision.Deny;
      default:
        logger.warn({ decision }, 'Unknown policy decision, defaulting to ALLOW');
        return PolicyDecision.Allow;
    }
  }
}

export const policyEngine = PolicyEngine.getInstance();
