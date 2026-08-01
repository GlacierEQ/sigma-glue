# Opaque credential-broker Colossus transport

## Purpose

`OpaqueBrokerColossusHttpTransport` is the concrete HTTPS transport between the permit-gated dispatch adapter and a Colossus endpoint. The credential broker performs authenticated network I/O; Sigma Glue receives neither the credential value nor an authorization header.

```text
immutable Colossus envelope
→ fixed HTTPS request
→ opaque credential handle
→ credential broker authorizedFetch
→ bounded JSON response
→ dispatch receipt validation
```

## Credential isolation

The transport requires a broker that explicitly declares `supportsOpaqueHandles: true` and implements:

```text
authorizedFetch({ credentialHandle, url, request, signal })
```

The transport passes a `credh_...` handle separately from the request. The request contains no authorization, cookie, API-key, access-token, or refresh-token field. Credential attachment and custody remain inside the broker.

## Network policy

- HTTPS is mandatory.
- Endpoint userinfo, query parameters, and fragments are rejected.
- The endpoint origin must be allowlisted.
- Redirect mode is `error`.
- A response URL change is rejected even if a broker follows a redirect.
- Requests are POST-only, no-store, and abort-aware.
- The transport makes one request and performs no hidden retry.

## Response policy

- Only HTTP 2xx is accepted.
- Error bodies are not read or surfaced.
- JSON content type is mandatory.
- Declared and actual response sizes are bounded.
- Malformed JSON and non-object responses fail closed.
- Broker exceptions are wrapped without copying their message into user-visible diagnostics.

## Boundary

This module is production-shaped but has not been exercised against a live Colossus deployment or a production credential broker. It does not define broker storage, token refresh, mTLS, endpoint discovery, or provider execution. Those remain separate components and evidence requirements.
