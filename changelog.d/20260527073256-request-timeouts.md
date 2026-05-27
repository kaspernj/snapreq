HTTP requests now support `timeoutMs` on both the client and individual request options. Timeouts abort stalled response headers or body reads and reject with `SnapReqTimeoutError`.
