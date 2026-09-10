Add explicit `error`, `manual`, and `follow` HTTP redirect policies with
cross-origin credential stripping, and add an optional decoded response-body
byte limit for buffered and streamed consumers. Existing transport-native
redirect behavior and unlimited bodies remain unchanged when the new options
are omitted. Browser Fetch implementations that hide manual redirect responses,
and transports that buffer a complete response before SnapReq can enforce its
byte limit, fail explicitly with `SnapReqUnsupportedFeatureError` instead of
claiming those safety contracts are supported. Followed-response HTTP errors
now report the final method and URL, and every completed redirect hop resets the
idle header watchdog.
