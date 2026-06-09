import crypto from 'crypto';

export type DeskAuthorizationFlowStatus = 'pending' | 'completed' | 'failed' | 'expired';

export interface DeskAuthorizationParams {
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

export interface DeskAuthorizationFlow {
  flowId: string;
  issuer: string;
  params: DeskAuthorizationParams;
  status: DeskAuthorizationFlowStatus;
  expiresAt: number;
  redirect?: string;
  error?: string;
  errorDescription?: string;
}

export class DeskAuthorizationFlowService {
  private flows = new Map<string, DeskAuthorizationFlow>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  createFlow(params: DeskAuthorizationParams, issuer: string): DeskAuthorizationFlow {
    this.cleanupExpired();
    const flow: DeskAuthorizationFlow = {
      flowId: crypto.randomBytes(32).toString('base64url'),
      issuer,
      params,
      status: 'pending',
      expiresAt: Date.now() + this.ttlMs,
    };
    this.flows.set(flow.flowId, flow);
    return flow;
  }

  getReusableFlow(flowId: string, params: DeskAuthorizationParams, issuer: string): DeskAuthorizationFlow | null {
    const flow = this.getFlow(flowId);
    if (!flow || (flow.status !== 'pending' && flow.status !== 'completed')) {
      return null;
    }
    if (flow.issuer !== issuer) {
      return null;
    }
    if (!this.paramsMatch(flow.params, params)) {
      return null;
    }
    return flow;
  }

  getFlow(flowId: string): DeskAuthorizationFlow | null {
    const flow = this.flows.get(flowId);
    if (!flow) {
      return null;
    }
    if (flow.status === 'pending' && flow.expiresAt <= Date.now()) {
      flow.status = 'expired';
      flow.error = 'expired';
      flow.errorDescription = 'Authorization flow has expired';
    }
    return flow;
  }

  completeFlow(flowId: string, redirect: string): DeskAuthorizationFlow | null {
    const flow = this.getFlow(flowId);
    if (!flow || flow.status !== 'pending') {
      return flow;
    }
    flow.status = 'completed';
    flow.redirect = redirect;
    return flow;
  }

  failFlow(flowId: string, error: string, errorDescription: string): DeskAuthorizationFlow | null {
    const flow = this.getFlow(flowId);
    if (!flow || flow.status !== 'pending') {
      return flow;
    }
    flow.status = 'failed';
    flow.error = error;
    flow.errorDescription = errorDescription;
    return flow;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [flowId, flow] of this.flows.entries()) {
      if (flow.status === 'pending' && flow.expiresAt <= now) {
        flow.status = 'expired';
        flow.error = 'expired';
        flow.errorDescription = 'Authorization flow has expired';
        continue;
      }
      if (flow.expiresAt + this.ttlMs <= now && flow.status !== 'completed') {
        this.flows.delete(flowId);
      }
    }
  }

  private paramsMatch(a: DeskAuthorizationParams, b: DeskAuthorizationParams): boolean {
    const keys: Array<keyof DeskAuthorizationParams> = [
      'client_id',
      'redirect_uri',
      'scope',
      'state',
      'code_challenge',
      'code_challenge_method',
      'resource',
    ];
    return keys.every(key => (a[key] ?? undefined) === (b[key] ?? undefined));
  }
}

export const deskAuthorizationFlowService = new DeskAuthorizationFlowService();
