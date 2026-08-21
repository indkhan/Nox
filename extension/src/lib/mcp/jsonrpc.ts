export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcErrorObject
}

let nextId = 0

export function nextRequestId(): number {
  return ++nextId
}

/** Test seam. */
export function resetRequestIds(): void {
  nextId = 0
}

export function buildRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextRequestId(), method, params }
}

export function buildNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params }
}
