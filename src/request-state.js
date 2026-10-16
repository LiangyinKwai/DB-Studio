/**
 * Ignore an asynchronous response once either its request generation or
 * connection context has changed.
 */
export function isCurrentConnectionRequest(
  requestId,
  currentRequestId,
  connectionId,
  currentConnectionId,
) {
  return requestId === currentRequestId && connectionId === currentConnectionId;
}
