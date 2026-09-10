Add explicit `error`, `manual`, and `follow` HTTP redirect policies with
cross-origin credential stripping, and add an optional decoded response-body
byte limit for buffered and streamed consumers. Existing transport-native
redirect behavior and unlimited bodies remain unchanged when the new options
are omitted.
