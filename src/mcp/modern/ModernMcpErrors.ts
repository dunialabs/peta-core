import type { JsonRpcId, JsonValue } from './ModernMcpTypes.js';

export class ModernMcpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly rpcCode: number,
    message: string,
    public readonly data?: JsonValue,
  ) {
    super(message);
    this.name = 'ModernMcpError';
  }
}

export function modernErrorResponse(id: JsonRpcId | undefined, error: ModernMcpError) {
  return {
    jsonrpc: '2.0' as const,
    error: {
      code: error.rpcCode,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
    id: id ?? null,
  };
}

export const ModernErrorCodes = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HeaderMismatch: -32001,
  UnsupportedProtocolVersion: -32004,
} as const;
