import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpaqueBrokerColossusHttpTransport
} from '../src/transport/opaque-broker-colossus-http.mjs';
import { ColossusDispatchError } from '../src/dispatch/common.mjs';

const ENDPOINT = 'https://colossus.test/v1/dispatch';
const HANDLE = 'credh_test-handle-001';

function envelope(overrides = {}) {
  return {
    requestId: 'request-1',
    traceId: 'trace-1',
    envelopeFingerprint: 'sha256:envelope-1',
    payload: { sourceId: 'file-1' },
    ...overrides
  };
}

function fakeResponse({
  status = 200,
  contentType = 'application/json',
  contentLength,
  body = '{"status":"dispatched"}',
  url = ENDPOINT,
  onRead
} = {}) {
  const bytes = Buffer.from(body, 'utf8');
  const headers = new Map([['content-type', contentType]]);
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return {
    status,
    url,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    async arrayBuffer() {
      onRead?.();
      return Uint8Array.from(bytes).buffer;
    }
  };
}

function broker(handler) {
  return {
    supportsOpaqueHandles: true,
    authorizedFetch: handler
  };
}

function transport(overrides = {}) {
  return new OpaqueBrokerColossusHttpTransport({
    endpoint: ENDPOINT,
    credentialHandle: HANDLE,
    credentialBroker: broker(async () => fakeResponse()),
    ...overrides
  });
}

test('sends one canonical POST through the broker without exposing authorization', async () => {
  let captured;
  const instance = transport({
    credentialBroker: broker(async (input) => {
      captured = input;
      return fakeResponse({ body: '{"status":"dispatched","receiptId":"receipt-1"}' });
    })
  });
  const controller = new AbortController();
  const result = await instance.dispatch(envelope(), { signal: controller.signal });

  assert.equal(result.status, 'dispatched');
  assert.equal(captured.credentialHandle, HANDLE);
  assert.equal(captured.url, ENDPOINT);
  assert.equal(captured.request.method, 'POST');
  assert.equal(captured.request.redirect, 'error');
  assert.equal(captured.request.credentials, 'omit');
  assert.equal(Object.hasOwn(captured.request.headers, 'authorization'), false);
  assert.equal(captured.request.headers['x-sigma-request-id'], 'request-1');
  assert.equal(captured.request.body, '{"envelopeFingerprint":"sha256:envelope-1","payload":{"sourceId":"file-1"},"requestId":"request-1","traceId":"trace-1"}');
  assert.ok(Object.isFrozen(captured.request));
  assert.ok(Object.isFrozen(captured.request.headers));
});

test('requires an explicitly opaque broker and handle', () => {
  assert.throws(
    () => new OpaqueBrokerColossusHttpTransport({
      endpoint: ENDPOINT,
      credentialHandle: HANDLE,
      credentialBroker: { authorizedFetch: async () => fakeResponse() }
    }),
    (error) => error instanceof ColossusDispatchError && error.code === 'CREDENTIAL_BROKER_INVALID'
  );
  assert.throws(
    () => transport({ credentialHandle: 'raw-token-value' }),
    (error) => error instanceof ColossusDispatchError && error.code === 'CREDENTIAL_HANDLE_INVALID'
  );
});

test('rejects insecure or secret-bearing endpoint URLs', () => {
  for (const endpoint of [
    'http://colossus.test/v1/dispatch',
    'https://user:pass@colossus.test/v1/dispatch',
    'https://colossus.test/v1/dispatch?token=value',
    'https://colossus.test/v1/dispatch#fragment'
  ]) {
    assert.throws(
      () => transport({ endpoint }),
      (error) => error instanceof ColossusDispatchError &&
        ['COLOSSUS_ENDPOINT_INSECURE', 'COLOSSUS_ENDPOINT_UNSAFE'].includes(error.code)
    );
  }
});

test('rejects endpoints outside the configured origin policy', () => {
  assert.throws(
    () => transport({ allowedOrigins: ['https://other.test'] }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_ORIGIN_NOT_ALLOWED'
  );
});

test('rejects redirects even when a broker follows one', async () => {
  const instance = transport({
    credentialBroker: broker(async () => fakeResponse({ url: 'https://other.test/v1/dispatch' }))
  });
  await assert.rejects(
    instance.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_REDIRECT_REJECTED'
  );
});

test('rejects non-success HTTP status without reading a response body', async () => {
  let reads = 0;
  const instance = transport({
    credentialBroker: broker(async () => fakeResponse({ status: 403, onRead: () => { reads += 1; } }))
  });
  await assert.rejects(
    instance.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_HTTP_REJECTED'
  );
  assert.equal(reads, 0);
});

test('rejects invalid content type and malformed JSON', async () => {
  const textTransport = transport({
    credentialBroker: broker(async () => fakeResponse({ contentType: 'text/plain' }))
  });
  await assert.rejects(
    textTransport.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_CONTENT_TYPE_INVALID'
  );

  const malformed = transport({
    credentialBroker: broker(async () => fakeResponse({ body: '{not-json' }))
  });
  await assert.rejects(
    malformed.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RESPONSE_JSON_INVALID'
  );
});

test('enforces declared and actual response-size limits', async () => {
  const declared = transport({
    maxResponseBytes: 8,
    credentialBroker: broker(async () => fakeResponse({ contentLength: 100, body: '{}' }))
  });
  await assert.rejects(
    declared.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RESPONSE_TOO_LARGE'
  );

  const actual = transport({
    maxResponseBytes: 8,
    credentialBroker: broker(async () => fakeResponse({ body: '{"long":true}' }))
  });
  await assert.rejects(
    actual.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RESPONSE_TOO_LARGE'
  );
});

test('maps broker failure and abort without leaking broker details', async () => {
  const failed = transport({
    credentialBroker: broker(async () => { throw new Error('Bearer secret-must-not-surface'); })
  });
  await assert.rejects(
    failed.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError &&
      error.code === 'CREDENTIAL_BROKER_REQUEST_FAILED' &&
      !error.message.includes('secret-must-not-surface')
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    transport().dispatch(envelope(), { signal: controller.signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_REQUEST_ABORTED'
  );
});

test('requires an object response body', async () => {
  const instance = transport({
    credentialBroker: broker(async () => fakeResponse({ body: '["not","an","object"]' }))
  });
  await assert.rejects(
    instance.dispatch(envelope(), { signal: new AbortController().signal }),
    (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RESPONSE_SHAPE_INVALID'
  );
});
