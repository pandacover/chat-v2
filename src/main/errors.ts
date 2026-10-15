import { Schema } from 'effect'

export class DbError extends Schema.TaggedError<DbError>()('DbError', {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  message: Schema.String
}) {}

export class InvalidInput extends Schema.TaggedError<InvalidInput>()('InvalidInput', {
  message: Schema.String
}) {}

export class MissingApiKey extends Schema.TaggedError<MissingApiKey>()('MissingApiKey', {
  message: Schema.String
}) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class ProviderError extends Schema.TaggedError<ProviderError>()('ProviderError', {
  provider: Schema.String,
  status: Schema.optional(Schema.Number),
  message: Schema.String
}) {}

export class FileError extends Schema.TaggedError<FileError>()('FileError', {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : JSON.stringify(cause)
