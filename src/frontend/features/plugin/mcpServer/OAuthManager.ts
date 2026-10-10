import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import { saveRemoteMcpOAuthTokens } from '@/shared/services/remoteMcpCredentials';

const REDIRECT_URI = 'cherrystudio://oauth/callback';
const FETCH_HEADERS = { Accept: 'application/json' };

type OAuthServerMetadata = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  issuer?: string;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
};

function requireHttps(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return url.toString();
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    return json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resourceMetadataUrls(serverUrl: URL): string[] {
  const path = serverUrl.pathname === '/' ? '' : serverUrl.pathname.replace(/\/$/, '');
  return [
    `${serverUrl.origin}/.well-known/oauth-protected-resource${path}`,
    `${serverUrl.origin}/.well-known/oauth-protected-resource`,
  ];
}

function authorizationServerMetadataUrls(issuerValue: string): string[] {
  const issuer = new URL(requireHttps(issuerValue, 'OAuth issuer'));
  const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
  ];
}

async function discoverAuthorizationServer(serverUrl: string): Promise<OAuthServerMetadata> {
  const resource = new URL(requireHttps(serverUrl, 'MCP server URL'));
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const url of resourceMetadataUrls(resource)) {
    resourceMetadata = await fetchJson(url);
    if (resourceMetadata) break;
  }

  const issuers = Array.isArray(resourceMetadata?.authorization_servers)
    ? resourceMetadata.authorization_servers.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
    : [];
  const candidateIssuers = issuers.length > 0 ? issuers : [resource.origin];

  for (const issuer of candidateIssuers) {
    for (const metadataUrl of authorizationServerMetadataUrls(issuer)) {
      const metadata = await fetchJson(metadataUrl);
      if (
        typeof metadata?.authorization_endpoint === 'string' &&
        typeof metadata?.token_endpoint === 'string'
      ) {
        if (
          Array.isArray(metadata.code_challenge_methods_supported) &&
          !metadata.code_challenge_methods_supported.includes('S256')
        ) {
          throw new Error('This OAuth provider does not advertise PKCE S256 support.');
        }
        return {
          authorization_endpoint: requireHttps(metadata.authorization_endpoint, 'Authorization endpoint'),
          token_endpoint: requireHttps(metadata.token_endpoint, 'Token endpoint'),
          registration_endpoint:
            typeof metadata.registration_endpoint === 'string'
              ? requireHttps(metadata.registration_endpoint, 'Registration endpoint')
              : undefined,
          issuer: typeof metadata.issuer === 'string' ? metadata.issuer : issuer,
          code_challenge_methods_supported: metadata.code_challenge_methods_supported as
            | string[]
            | undefined,
        };
      }
    }
  }

  throw new Error(
    'OAuth metadata was not found for this MCP server. Use Advanced: Manual Headers, or configure an OAuth-compatible server that publishes Protected Resource and Authorization Server metadata.',
  );
}

async function registerPublicClient(metadata: OAuthServerMetadata): Promise<string> {
  if (!metadata.registration_endpoint) {
    throw new Error(
      'This provider does not support automatic client registration. It requires a preconfigured OAuth client ID, which this server form does not collect.',
    );
  }

  const response = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Cherry Studio Mobile',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`OAuth client registration failed (HTTP ${response.status}).`);
  const clientId =
    payload && typeof payload === 'object' && 'client_id' in payload
      ? (payload as { client_id?: unknown }).client_id
      : undefined;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('OAuth client registration returned no client ID.');
  }
  return clientId;
}

function randomHex(byteLength: number): string {
  const bytes = Crypto.getRandomBytes(byteLength);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const base64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * RFC 9728/RFC 8414 discovery + dynamic registration + OAuth 2.0 PKCE.
 * Access/refresh tokens are persisted only via expo-secure-store on this device.
 * Arbitrary URLs are not treated as OAuth providers unless they publish metadata.
 */
export async function startOAuthFlow(serverUrl: string): Promise<void> {
  const endpointUrl = requireHttps(serverUrl.trim(), 'MCP server URL');
  const metadata = await discoverAuthorizationServer(endpointUrl);
  const clientId = await registerPublicClient(metadata);
  const codeVerifier = randomHex(32); // 64 chars, within the PKCE 43–128 char range.
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const state = randomHex(32);

  const authorizationUrl = new URL(metadata.authorization_endpoint!);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('resource', endpointUrl);

  const result = await WebBrowser.openAuthSessionAsync(
    authorizationUrl.toString(),
    REDIRECT_URI,
  );
  if (result.type !== 'success' || !result.url) {
    throw new Error(result.type === 'cancel' ? 'OAuth connection was cancelled.' : 'OAuth did not complete.');
  }

  const callback = new URL(result.url);
  const returnedState = callback.searchParams.get('state');
  const code = callback.searchParams.get('code');
  const oauthError = callback.searchParams.get('error');
  if (oauthError) {
    throw new Error(`OAuth authorization was denied (${oauthError}).`);
  }
  if (!returnedState || returnedState !== state) {
    throw new Error('OAuth state validation failed. Please connect again.');
  }
  if (!code) throw new Error('The OAuth callback did not contain an authorization code.');

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
    resource: endpointUrl,
  });
  const tokenResponse = await fetch(metadata.token_endpoint!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: tokenBody.toString(),
  });
  const tokens = (await tokenResponse.json().catch(() => null)) as TokenResponse | null;
  if (!tokenResponse.ok) {
    throw new Error(`OAuth token exchange failed (HTTP ${tokenResponse.status}).`);
  }
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('OAuth token exchange returned no access token.');
  }

  await saveRemoteMcpOAuthTokens(endpointUrl, {
    accessToken: tokens.access_token,
    clientId,
    expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : null,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
    tokenEndpoint: metadata.token_endpoint!,
  });
}
