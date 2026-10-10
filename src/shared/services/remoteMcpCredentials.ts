import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const STORAGE_PREFIX = 'remote-mcp.credentials.v1.';
const STORAGE_OPTIONS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type RemoteMcpOAuthTokens = {
  accessToken: string;
  clientId: string;
  expiresAt: number | null;
  refreshToken: string | null;
  tokenEndpoint: string;
};

type StoredCredentials = {
  manualHeaders: Record<string, string>;
  oauth: RemoteMcpOAuthTokens | null;
  version: 1;
};

function normalizeEndpoint(endpointUrl: string): string {
  const endpoint = new URL(endpointUrl.trim());
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('MCP credentials may only be used with HTTPS endpoints, except localhost.');
  }
  endpoint.hash = '';
  return endpoint.toString();
}

async function storageKey(endpointUrl: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    normalizeEndpoint(endpointUrl),
  );
  return `${STORAGE_PREFIX}${digest}`;
}

function emptyCredentials(): StoredCredentials {
  return { version: 1, manualHeaders: {}, oauth: null };
}

async function readCredentials(endpointUrl: string): Promise<StoredCredentials> {
  const key = await storageKey(endpointUrl);
  const raw = await SecureStore.getItemAsync(key, STORAGE_OPTIONS);
  if (!raw) return emptyCredentials();

  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    const manualHeaders =
      parsed.manualHeaders && typeof parsed.manualHeaders === 'object' && !Array.isArray(parsed.manualHeaders)
        ? Object.fromEntries(
            Object.entries(parsed.manualHeaders).filter(
              ([name, value]) => name.trim().length > 0 && typeof value === 'string',
            ),
          )
        : {};
    const oauth = parsed.oauth;
    return {
      version: 1,
      manualHeaders,
      oauth:
        oauth &&
        typeof oauth.accessToken === 'string' &&
        typeof oauth.clientId === 'string' &&
        typeof oauth.tokenEndpoint === 'string'
          ? {
              accessToken: oauth.accessToken,
              clientId: oauth.clientId,
              expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
              refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : null,
              tokenEndpoint: oauth.tokenEndpoint,
            }
          : null,
    };
  } catch {
    throw new Error('Stored MCP credentials are invalid. Remove them and connect again.');
  }
}

async function writeCredentials(endpointUrl: string, credentials: StoredCredentials) {
  const key = await storageKey(endpointUrl);
  await SecureStore.setItemAsync(key, JSON.stringify(credentials), STORAGE_OPTIONS);
}

/** Store manual headers only in device-protected storage, never in SQLite or sync payloads. */
export async function saveRemoteMcpManualHeaders(
  endpointUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  const current = await readCredentials(endpointUrl);
  await writeCredentials(endpointUrl, {
    ...current,
    manualHeaders: { ...headers },
  });
}

export async function saveRemoteMcpOAuthTokens(
  endpointUrl: string,
  oauth: RemoteMcpOAuthTokens,
): Promise<void> {
  const current = await readCredentials(endpointUrl);
  await writeCredentials(endpointUrl, { ...current, oauth });
}

/**
 * Resolve device-local headers at connection time. The legacy fallback is only
 * for servers configured by older app versions; new UI writes never persist
 * credentials to the MCP SQLite row.
 */
export async function getRemoteMcpHeaders(
  endpointUrl: string,
  legacyHeaders: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const stored = await readCredentials(endpointUrl);
  const headers = { ...(legacyHeaders ?? {}), ...stored.manualHeaders };
  if (!stored.oauth) return headers;

  const oauth = await getFreshOAuthTokens(endpointUrl, stored);
  headers.Authorization = `Bearer ${oauth.accessToken}`;
  return headers;
}

async function getFreshOAuthTokens(
  endpointUrl: string,
  stored: StoredCredentials,
): Promise<RemoteMcpOAuthTokens> {
  const oauth = stored.oauth;
  if (!oauth) throw new Error('OAuth is not connected.');

  if (!oauth.expiresAt || oauth.expiresAt > Date.now() + 60_000) return oauth;
  if (!oauth.refreshToken) {
    throw new Error('The OAuth session expired. Connect via OAuth again.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
  });
  const response = await fetch(oauth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed (HTTP ${response.status}).`);

  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error('OAuth token refresh returned no access token.');
  }

  const next: RemoteMcpOAuthTokens = {
    accessToken: json.access_token,
    clientId: oauth.clientId,
    expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : null,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : oauth.refreshToken,
    tokenEndpoint: oauth.tokenEndpoint,
  };
  await writeCredentials(endpointUrl, { ...stored, oauth: next });
  return next;
}

/** Best-effort cleanup called when a custom MCP server is deleted. */
export async function deleteRemoteMcpCredentials(endpointUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await storageKey(endpointUrl), STORAGE_OPTIONS);
}
