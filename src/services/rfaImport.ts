// src/services/rfaImport.ts
import axios from 'axios';
import type { IfcAPI } from 'web-ifc';

/**
 * Import a BIM .rfa family by translating it to IFC through Autodesk
 * Platform Services (APS) Model Derivative, then loading the translated IFC
 * with web-ifc.
 *
 * Flow (each step verified against the live APS API shape the server
 * already uses in server/index.mjs):
 *   1. Authenticate with client credentials (scope includes bucket:read
 *      and bucket:create, which bucket provisioning needs).
 *   2. Verify the OSS bucket exists; create it when it does not, and fail
 *      loudly when it can neither be verified nor created.
 *   3. Upload the file bytes to OSS and take the returned objectId.
 *   4. Submit a Model Derivative job translating the object to IFC.
 *   5. Poll the job manifest until it succeeds, fails, or the attempt
 *      budget is exhausted.
 *   6. Download the IFC *derivative* named by the manifest (never the
 *      manifest JSON itself) and load it via web-ifc.
 *
 * The file is supplied as a File / ArrayBuffer / Uint8Array — a local file
 * path is not accepted, because a path cannot be fetched as a URL.
 * No live APS call is made unless APS_CLIENT_ID / APS_CLIENT_SECRET are
 * set in the environment (the legacy FORGE_CLIENT_ID / FORGE_CLIENT_SECRET
 * names are also accepted). Without either pair the import refuses with a
 * typed RfaApsNotConfiguredError naming exactly which variables are
 * missing — it never silently pretends the import succeeded.
 */

const APS_AUTH_URL = 'https://developer.api.autodesk.com/authentication/v1/authenticate';
const APS_OSS_BASE = 'https://developer.api.autodesk.com/oss/v2';
const APS_MD_BASE = 'https://developer.api.autodesk.com/modelderivative/v2/designdata';

/** Default OSS bucket used when the caller does not override it. */
export const DEFAULT_RFA_BUCKET_KEY = 'openbimstudio-temp';

export const DEFAULT_RFA_MAX_POLL_ATTEMPTS = 60;
export const DEFAULT_RFA_POLL_INTERVAL_MS = 5_000;

/**
 * Stable code for the missing-credentials refusal, so callers (and
 * tests) can distinguish "APS is not configured" from a failed APS
 * call without parsing the message.
 */
export const RFA_APS_NOT_CONFIGURED_CODE = 'RFA_APS_NOT_CONFIGURED';

/**
 * Thrown when importRFA is called without configured APS credentials.
 * The import cannot run at all in that state — there is no local .rfa
 * reader — so the refusal is a hard, typed error naming exactly which
 * credential variables are missing, never a silent no-op: an earlier
 * version only logged a warning and resolved, so a caller awaiting the
 * import could believe the family had been imported when nothing had
 * happened. `missing` lists the canonical variable names that are
 * unset; the legacy FORGE_* spellings are accepted as fallbacks (see
 * resolveApsCredentials) but are never the names the error asks for.
 */
export class RfaApsNotConfiguredError extends Error {
  readonly code = RFA_APS_NOT_CONFIGURED_CODE;
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `RFA import needs Autodesk Platform Services credentials, but ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Set APS_CLIENT_ID and APS_CLIENT_SECRET in the environment ' +
        '(the legacy FORGE_CLIENT_ID / FORGE_CLIENT_SECRET names are also accepted). ' +
        'No file was uploaded and no APS call was made. ' +
        'Unblockers: a real .rfa file plus APS credentials — there is no local .rfa reader.',
    );
    this.name = 'RfaApsNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Read the APS client credentials. The server (server/index.mjs) reads
 * APS_CLIENT_ID / APS_CLIENT_SECRET and tells the user to configure
 * those, so they are canonical here too; the FORGE_CLIENT_ID /
 * FORGE_CLIENT_SECRET names this module originally read are kept as a
 * legacy fallback so existing setups keep working. Returns the missing
 * canonical names when either side of the pair is unset in both
 * spellings — the caller turns that into RfaApsNotConfiguredError.
 */
export function resolveApsCredentials(): {
  clientId: string | undefined;
  clientSecret: string | undefined;
  missing: string[];
} {
  const clientId = process.env.APS_CLIENT_ID ?? process.env.FORGE_CLIENT_ID;
  const clientSecret = process.env.APS_CLIENT_SECRET ?? process.env.FORGE_CLIENT_SECRET;
  const missing: string[] = [];
  if (!clientId) missing.push('APS_CLIENT_ID');
  if (!clientSecret) missing.push('APS_CLIENT_SECRET');
  return { clientId, clientSecret, missing };
}

/** Minimal HTTP surface the importer needs. Implementations follow axios
 * semantics: a non-2xx response rejects with an error carrying
 * `response.status`. The default implementation is axios itself. */
export interface ApsHttpResponse {
  status: number;
  data: unknown;
}

export interface ApsHttpClient {
  get(url: string, config?: Record<string, unknown>): Promise<ApsHttpResponse>;
  post(url: string, data?: unknown, config?: Record<string, unknown>): Promise<ApsHttpResponse>;
  put(url: string, data?: unknown, config?: Record<string, unknown>): Promise<ApsHttpResponse>;
}

/** axios adapter — the only place the real HTTP client is referenced. */
export const axiosHttpClient: ApsHttpClient = {
  async get(url, config) {
    const res = await axios.get(url, config);
    return { status: res.status, data: res.data };
  },
  async post(url, data, config) {
    const res = await axios.post(url, data, config);
    return { status: res.status, data: res.data };
  },
  async put(url, data, config) {
    const res = await axios.put(url, data, config);
    return { status: res.status, data: res.data };
  },
};

export interface RfaImportOptions {
  /** OSS bucket key. Defaults to DEFAULT_RFA_BUCKET_KEY. */
  bucketKey?: string;
  /** HTTP client. Defaults to axios. Tests inject a mock. */
  http?: ApsHttpClient;
  /** Maximum manifest polls before giving up. Defaults to 60. */
  maxPollAttempts?: number;
  /** Delay between manifest polls in ms. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Delay implementation. Defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human-readable form of an HTTP/client error, including the status
 * when the client reported one. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const status = httpStatus(error);
    return status === undefined ? error.message : `HTTP ${status}: ${error.message}`;
  }
  return String(error);
}

/** axios-style status carried on a rejected response error, if any. */
function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The objectId APS assigns an uploaded object:
 * `urn:adsk.objects:os.object:<bucketKey>/<objectKey>`. */
function objectIdFor(bucketKey: string, objectKey: string): string {
  return `urn:adsk.objects:os.object:${bucketKey}/${objectKey}`;
}

/** The Model Derivative URN for an object: base64 of its objectId —
 * NOT base64 of `bucketKey/objectKey`. */
export function urnForObjectId(objectId: string): string {
  return Buffer.from(objectId).toString('base64');
}

async function readFileBytes(input: File | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new Error(
    'importRFA expects a File, ArrayBuffer or Uint8Array — a file path is not accepted ' +
      '(a local path cannot be fetched as a URL; pass the uploaded file bytes instead).',
  );
}

/** Strip any directory components so a caller-supplied name can never
 * smuggle a path into the OSS object key. */
function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return base.trim();
}

/**
 * Verify the OSS bucket exists; create it when it does not. A bucket that
 * can neither be verified nor created is a hard error — the import never
 * silently assumes the bucket is there.
 */
async function ensureBucketExists(http: ApsHttpClient, token: string, bucketKey: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  let missing = false;
  try {
    const res = await http.get(`${APS_OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}`, { headers });
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 404) {
      missing = true;
    } else {
      throw new Error(`APS bucket check for '${bucketKey}' returned unexpected status ${res.status}`);
    }
  } catch (error) {
    if (httpStatus(error) === 404) {
      missing = true;
    } else if (error instanceof Error && /unexpected status/.test(error.message)) {
      throw error;
    } else {
      throw new Error(`APS bucket '${bucketKey}' could not be verified: ${describeError(error)}`);
    }
  }
  if (!missing) return;

  try {
    await http.post(
      `${APS_OSS_BASE}/buckets`,
      { bucketKey, policyKey: 'transient' },
      { headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    // 409: another client created the bucket between our check and our
    // create — the bucket now exists, which is all we need.
    if (httpStatus(error) === 409) return;
    throw new Error(
      `APS bucket '${bucketKey}' does not exist and could not be created: ${describeError(error)}`,
    );
  }
}

interface ManifestDerivative {
  urn: string;
  outputType: string;
}

interface JobManifest {
  status: string;
  progress?: string;
  derivatives?: ManifestDerivative[];
}

async function fetchManifest(http: ApsHttpClient, token: string, urn: string): Promise<JobManifest> {
  const res = await http.get(`${APS_MD_BASE}/${urn}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!isRecord(res.data) || typeof res.data.status !== 'string') {
    throw new Error('APS manifest response was malformed (no job status)');
  }
  return res.data as unknown as JobManifest;
}

/** Poll the translation job until it succeeds, fails, or the attempt
 * budget is exhausted. Returns the manifest of the successful job. */
async function pollJobToCompletion(
  http: ApsHttpClient,
  token: string,
  urn: string,
  maxAttempts: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<JobManifest> {
  let last: JobManifest | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const manifest = await fetchManifest(http, token, urn);
    last = manifest;
    if (manifest.status === 'success') return manifest;
    if (manifest.status === 'failed' || manifest.status === 'timeout') {
      throw new Error(
        `APS translation failed (job status: ${manifest.status}` +
          (manifest.progress ? `, progress: ${manifest.progress}` : '') +
          ')',
      );
    }
    if (attempt === maxAttempts) break;
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `APS translation did not finish after ${maxAttempts} status checks` +
      (last?.progress ? ` (last progress: ${last.progress})` : '') +
      ' — the job may still be running on APS; try again later.',
  );
}

export async function importRFA(
  input: File | ArrayBuffer | Uint8Array,
  fileName: string,
  api: IfcAPI,
  options: RfaImportOptions = {},
): Promise<void> {
  const { clientId, clientSecret, missing } = resolveApsCredentials();
  if (!clientId || !clientSecret) {
    throw new RfaApsNotConfiguredError(missing);
  }

  const file = sanitizeFileName(fileName);
  if (!file || !/\.rfa$/i.test(file)) {
    throw new Error(`importRFA expects an .rfa file name, got '${fileName}'`);
  }
  const fileBytes = await readFileBytes(input);
  if (fileBytes.byteLength === 0) {
    throw new Error('importRFA received an empty file');
  }

  const http = options.http ?? axiosHttpClient;
  const bucketKey = options.bucketKey ?? DEFAULT_RFA_BUCKET_KEY;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_RFA_MAX_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RFA_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  if (maxPollAttempts < 1) throw new Error('maxPollAttempts must be at least 1');

  // 1️⃣ Authenticate. bucket:read / bucket:create are required for the
  // bucket verify-or-create step below.
  const tokenRes = await http.post(
    APS_AUTH_URL,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'data:read data:write bucket:read bucket:create',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  const token = isRecord(tokenRes.data) ? tokenRes.data.access_token : undefined;
  if (typeof token !== 'string' || !token) {
    throw new Error('APS authentication did not return an access token');
  }
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 2️⃣ Verify the OSS bucket exists, creating it when it does not.
  await ensureBucketExists(http, token, bucketKey);

  // 3️⃣ Upload the .rfa bytes to OSS.
  const objectKey = file;
  const uploadRes = await http.put(
    `${APS_OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}`,
    fileBytes,
    { headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' } },
  );
  const objectId = isRecord(uploadRes.data) && typeof uploadRes.data.objectId === 'string'
    ? uploadRes.data.objectId
    : objectIdFor(bucketKey, objectKey);
  // The URN is the base64 of the objectId
  // (`urn:adsk.objects:os.object:<bucket>/<key>`), not of `<bucket>/<key>`.
  const urn = urnForObjectId(objectId);

  // 4️⃣ Ask APS to translate the object to IFC.
  await http.post(
    `${APS_MD_BASE}/job`,
    {
      input: { urn },
      output: { formats: [{ type: 'ifc', views: ['3d'] }] },
    },
    { headers: { ...authHeaders, 'Content-Type': 'application/json' } },
  );

  // 5️⃣ Poll the job manifest to completion (bounded attempts).
  const manifest = await pollJobToCompletion(http, token, urn, maxPollAttempts, pollIntervalMs, sleep);

  // 6️⃣ Download the IFC *derivative* named by the manifest. The manifest
  // itself is JSON job metadata, not the IFC file.
  const ifcDerivative = manifest.derivatives?.find((d) => d.outputType === 'ifc');
  if (!ifcDerivative) {
    throw new Error('APS translation succeeded but the manifest lists no IFC derivative');
  }
  const ifcRes = await http.get(`${APS_MD_BASE}/${urn}/manifest/${ifcDerivative.urn}`, {
    headers: authHeaders,
    responseType: 'arraybuffer',
  });
  const raw = ifcRes.data;
  const buffer = raw instanceof ArrayBuffer
    ? new Uint8Array(raw)
    : raw instanceof Uint8Array
      ? raw
      : null;
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('APS returned an empty or unexpected response when downloading the IFC derivative');
  }
  const modelID = api.OpenModel(buffer);
  console.log('Imported RFA as IFC model', modelID);
}
