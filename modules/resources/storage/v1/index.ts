export { NebiusBucket as Bucket, NebiusBucketProvider as BucketProvider, type NebiusBucket as BucketResource } from './bucket.ts'
export { NebiusTransfer as Transfer, NebiusTransferProvider as TransferProvider, type NebiusTransfer as TransferResource } from './transfer.ts'
export {
  GetObject,
  GetObjectHttp,
  PutObject,
  PutObjectHttp,
  ObjectNotFound,
  BucketNotFound,
  AccessDenied,
  InvalidCredentials,
  S3Error,
  type GetObjectRequest,
  type GetObjectResult,
  type PutObjectRequest,
  type PutObjectResult,
  type StorageError,
} from './bindings.ts'
// Branded ids as **values** (AGENTS.md §"Branded IDs") — a bucket referenced by an env-provided id
// needs `Nebius.storage.BucketId` (a `Transfer`'s source/destination likewise).
export { BucketId, TransferId } from './ids.ts'
