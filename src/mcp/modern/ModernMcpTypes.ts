import type { Request, Response } from 'express';
import type { AuthContext } from '../../types/auth.types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type JsonRpcId = string | number;

export interface ModernJsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export type ModernClientInfo = JsonObject & {
  name: string;
  version: string;
};

export type ModernRequestMeta = JsonObject & {
  'io.modelcontextprotocol/protocolVersion': string;
  'io.modelcontextprotocol/clientInfo'?: ModernClientInfo;
  'io.modelcontextprotocol/clientCapabilities': JsonObject;
};

export interface ModernRequestContext {
  req: Request;
  res: Response;
  authContext: AuthContext;
  protocolVersion: string;
  clientInfo?: ModernClientInfo;
  clientCapabilities: JsonObject;
  requestId: JsonRpcId | undefined;
  uniformRequestId: string;
  isPublicEndpoint: boolean;
}

export interface ModernValidationResult {
  request: ModernJsonRpcRequest;
  meta: ModernRequestMeta;
  notification: boolean;
}

export interface ModernSubscriptionFilter {
  methods: Set<string>;
  serverIds: Set<string>;
  resourceUris: Set<string>;
  notifications: JsonObject;
}
