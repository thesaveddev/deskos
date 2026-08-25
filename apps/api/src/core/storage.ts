import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { AppConfig } from '../config.js'
import { AppError } from './errors.js'

export interface StorageConfig {
  /** 'local' or 's3'. Defaults to 'local'. */
  driver: 'local' | 's3'
  /** Local filesystem base directory (when driver=local). */
  localUploadDir: string
  localRecordingDir: string
  /** S3 endpoint URL (e.g. https://s3.amazonaws.com or http://localhost:9000 for MinIO). */
  s3Endpoint: string
  /** S3 region (e.g. us-east-1). */
  s3Region: string
  /** S3 bucket name. */
  s3Bucket: string
  /** S3 access key ID. */
  s3AccessKey: string
  /** S3 secret access key. */
  s3SecretKey: string
  /** Public base URL for serving files (e.g. https://cdn.example.com). Falls back to endpoint/bucket. */
  s3PublicBaseUrl: string
}

/**
 * Compute the HMAC-SHA256 signature required by S3.
 * See: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-auth-using-headers.html
 */
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function hmacHex(key: string | Buffer, data: string): string {
  return hmac(key, data).toString('hex')
}


async function s3Request(
  config: StorageConfig,
  method: string,
  key: string,
  body?: Buffer,
  contentType?: string,
): Promise<{ status: number; headers: Record<string, string>; body?: Buffer }> {
  const url = new URL(`/${key}`, config.s3Endpoint)
  const host = url.host
  const now = new Date()
  const dateStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8)
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
  const region = config.s3Region || 'us-east-1'
  const service = 's3'

  const payloadHash = body
    ? createHash('sha256').update(body).digest('hex')
    : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  // Canonical request
  const canonicalUri = url.pathname || '/'
  const canonicalQueryString = url.search ? url.search.slice(1) : ''
  const signedHeaders = contentType
    ? 'content-type;host;x-amz-content-sha256;x-amz-date'
    : 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    : `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const canonicalRequest = [
    method, canonicalUri, canonicalQueryString,
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')

  // String to sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  // Signing key
  const kDate = hmac(`AWS4${config.s3SecretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')

  const signature = hmacHex(kSigning, stringToSign)

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.s3AccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers: Record<string, string> = {
    'Host': host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization': authorization,
  }
  if (contentType) headers['Content-Type'] = contentType

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  })

  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => { resHeaders[k] = v })

  if (res.status === 204 || res.status === 200) {
    const buffer = method === 'GET' ? Buffer.from(await res.arrayBuffer()) : undefined
    return { status: res.status, headers: resHeaders, body: buffer }
  }

  const text = await res.text()
  return { status: res.status, headers: resHeaders, body: Buffer.from(text) }
}

function generateStorageKey(prefix: string, tenantId: string, filename: string): string {
  const hex = randomBytes(16).toString('hex')
  const safe = filename.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120) || 'file'
  return `${prefix}/${tenantId}/${hex}-${safe}`
}

function generateRecordingKey(tenantId: string): string {
  return `recordings/${tenantId}/${randomBytes(16).toString('hex')}.webm`
}

/**
 * Core storage abstraction.
 * Supports local filesystem and any S3-compatible provider (AWS S3, R2, MinIO, etc.)
 */
export class ObjectStorage {
  private config: StorageConfig

  constructor(config: StorageConfig) {
    this.config = config
  }

  /** Upload a file from a readable stream. Returns the storage key. */
  async uploadStream(
    prefix: string,
    tenantId: string,
    filename: string,
    mimeType: string,
    stream: AsyncIterable<Buffer>,
    maxSizeBytes: number,
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const storageKey = generateStorageKey(prefix, tenantId, filename)

    if (this.config.driver === 's3') {
      return this.uploadS3(storageKey, mimeType, stream, maxSizeBytes)
    }
    return this.uploadLocal(storageKey, stream, maxSizeBytes)
  }

  /** Upload a file from a buffer. Returns the storage key. */
  async uploadBuffer(
    prefix: string,
    tenantId: string,
    filename: string,
    mimeType: string,
    buffer: Buffer,
    maxSizeBytes: number,
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    if (buffer.length > maxSizeBytes) {
      throw AppError.badRequest('File exceeds the size limit', 'file_too_large')
    }

    const storageKey = generateStorageKey(prefix, tenantId, filename)

    if (this.config.driver === 's3') {
      const res = await s3Request(this.config, 'PUT', storageKey, buffer, mimeType)
      if (res.status !== 200 && res.status !== 204) {
        throw new Error(`S3 upload failed: ${res.status} ${res.body?.toString()}`)
      }
      return { storageKey, sizeBytes: buffer.length }
    }

    const fullPath = path.join(this.config.localUploadDir, storageKey)
    await mkdir(path.dirname(fullPath), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(fullPath, buffer)
    return { storageKey, sizeBytes: buffer.length }
  }

  /** Upload profile avatar. Returns the storage key and public URL. */
  async uploadAvatar(
    tenantId: string,
    userId: string,
    filename: string,
    mimeType: string,
    buffer: Buffer,
  ): Promise<{ storageKey: string; sizeBytes: number; publicUrl: string }> {
    const maxBytes = 2 * 1024 * 1024 // 2MB
    if (buffer.length > maxBytes) {
      throw AppError.badRequest('Image must be under 2MB', 'file_too_large')
    }

    const hex = randomBytes(16).toString('hex')
    const ext = path.extname(filename).toLowerCase() || '.jpg'
    const storageKey = `avatars/${tenantId}/${userId}/${hex}${ext}`

    if (this.config.driver === 's3') {
      const res = await s3Request(this.config, 'PUT', storageKey, buffer, mimeType)
      if (res.status !== 200 && res.status !== 204) {
        throw new Error(`S3 avatar upload failed: ${res.status} ${res.body?.toString()}`)
      }
    } else {
      const fullPath = path.join(this.config.localUploadDir, storageKey)
      await mkdir(path.dirname(fullPath), { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(fullPath, buffer)
    }

    const publicUrl = this.getPublicUrl(storageKey)
    return { storageKey, sizeBytes: buffer.length, publicUrl }
  }

  /** Download a file as a readable stream. Throws if not found. */
  async downloadStream(storageKey: string): Promise<Readable> {
    if (this.config.driver === 's3') {
      const res = await s3Request(this.config, 'GET', storageKey)
      if (res.status !== 200) {
        throw AppError.notFound('File missing from storage')
      }
      return Readable.from(res.body!)
    }

    const fullPath = this.getFullPath(storageKey)
    try {
      await stat(fullPath)
    } catch {
      throw AppError.notFound('File missing from storage')
    }
    return createReadStream(fullPath)
  }

  /** Get the content type for a file (best effort). */
  getContentType(mimeType: string): string {
    return mimeType || 'application/octet-stream'
  }

  /** Get the public URL for a storage key. */
  getPublicUrl(storageKey: string): string {
    if (this.config.driver === 's3') {
      if (this.config.s3PublicBaseUrl) {
        return `${this.config.s3PublicBaseUrl.replace(/\/$/, '')}/${storageKey}`
      }
      return `${this.config.s3Endpoint.replace(/\/$/, '')}/${this.config.s3Bucket}/${storageKey}`
    }
    // Local: public URL served through the API static route
    return `/api/v1/files/${storageKey}`
  }

  /** Delete a file. Best-effort (no-throw). */
  async delete(storageKey: string): Promise<void> {
    if (this.config.driver === 's3') {
      await s3Request(this.config, 'DELETE', storageKey).catch(() => {})
      return
    }

    const fullPath = this.getFullPath(storageKey)
    await unlink(fullPath).catch(() => {})
  }

  /** Get the local filesystem path (only for local driver). */
  getFullPath(storageKey: string): string {
    return path.join(this.config.localUploadDir, storageKey)
  }

  private async uploadLocal(
    storageKey: string,
    stream: AsyncIterable<Buffer>,
    maxSizeBytes: number,
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const fullPath = path.join(this.config.localUploadDir, storageKey)
    await mkdir(path.dirname(fullPath), { recursive: true })

    let size = 0
    const counting = async function* () {
      for await (const chunk of stream) {
        size += chunk.length
        if (size > maxSizeBytes) throw AppError.badRequest('File exceeds the size limit', 'file_too_large')
        yield chunk
      }
    }
    await pipeline(counting(), createWriteStream(fullPath))
    return { storageKey, sizeBytes: size }
  }

  private async uploadS3(
    storageKey: string,
    mimeType: string,
    stream: AsyncIterable<Buffer>,
    maxSizeBytes: number,
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      size += chunk.length
      if (size > maxSizeBytes) throw AppError.badRequest('File exceeds the size limit', 'file_too_large')
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks)

    const res = await s3Request(this.config, 'PUT', storageKey, body, mimeType)
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`S3 upload failed: ${res.status} ${res.body?.toString()}`)
    }
    return { storageKey, sizeBytes: size }
  }
}

/** Create the storage instance from app config. */
export function createStorage(config: AppConfig): ObjectStorage {
  return new ObjectStorage({
    driver: config.storage.driver,
    localUploadDir: config.uploadDir,
    localRecordingDir: config.recordingDir,
    s3Endpoint: config.storage.s3Endpoint,
    s3Region: config.storage.s3Region,
    s3Bucket: config.storage.s3Bucket,
    s3AccessKey: config.storage.s3AccessKey,
    s3SecretKey: config.storage.s3SecretKey,
    s3PublicBaseUrl: config.storage.s3PublicBaseUrl,
  })
}
