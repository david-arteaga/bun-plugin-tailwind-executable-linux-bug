import { join } from 'node:path';
// import { isDefined } from './utils/is-defined';
import { readFileSync } from 'node:fs';

export const Environment = {
  /**
   * This is needed because `process.env[VAR_NAME]` doesn't work with Bun bundled code
   * with env vars like `BUN_PUBLIC_*`
   *
   * So this is meant to be used like this:
   * ```ts
   * const value = Environment.assert(process.env.VAR_NAME);
   * ```
   */
  assert: (value: string | undefined) => {
    if (value === undefined) {
      const error = new Error(`Missing required environment variable`);
      Error.captureStackTrace(error, Environment.assert);
      throw error;
    }
    return value;
  },
  /**
   * This is needed because `process.env[VAR_NAME]` doesn't work with Bun bundled code
   * with env vars like `BUN_PUBLIC_*`
   *
   * So this is meant to be used like this:
   * ```ts
   * const value = Environment.assertInt(process.env.VAR_NAME);
   * ```
   */
  assertInt: (value: string | undefined) => {
    const stringValue = Environment.assert(value);
    const parsed = Number(stringValue);
    if (isNaN(parsed) || !Number.isInteger(parsed)) {
      const error = new Error(`Environment variable value is not an integer`);
      Error.captureStackTrace(error, Environment.assertInt);
      throw error;
    }
    return parsed;
  },

  getOrThrow: (name: string) => {
    const value = process.env[name];

    const filePathSuffix = '_FILE';

    if (!value) {
      const nameWithFileSuffix = name + filePathSuffix;
      const filePathValue = process.env[nameWithFileSuffix];
      if (filePathValue) {
        return Environment.getFromFileOrThrow(filePathValue, name);
      }

      const error = new Error(
        `Missing required environment variable: "${name}"`
      );
      Error.captureStackTrace(error, Environment.getOrThrow);
      throw error;
    }

    if (name.endsWith(filePathSuffix)) {
      return Environment.getFromFileOrThrow(value, name);
    }

    return value;
  },
  getFromFileOrThrow: (filePath: string, asFallbackFromEnvVarName?: string) => {
    const file = Bun.file(filePath);
    if (!file.exists()) {
      const error = new Error(
        `File "${filePath}" does not exist${
          asFallbackFromEnvVarName
            ? `. Tried to read from file because env var ${asFallbackFromEnvVarName} is not set`
            : ''
        }`
      );
      Error.captureStackTrace(error, Environment.getFromFileOrThrow);
      throw error;
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, 'utf-8');
    } catch (e) {
      if (e instanceof Error) {
        Error.captureStackTrace(e, Environment.getFromFileOrThrow);
        throw e;
      }
      throw e;
    }
    if (!fileContent) {
      const error = new Error(
        `File "${filePath}" is empty${
          asFallbackFromEnvVarName
            ? `. Tried to read from file because env var ${asFallbackFromEnvVarName} is not set`
            : ''
        }`
      );
      Error.captureStackTrace(error, Environment.getFromFileOrThrow);
      throw error;
    }
    return fileContent;
  },
  getEnumOrThrow: <T extends string>(name: string, values: readonly T[]) => {
    const value = Environment.getOrThrow(name);
    if (!values.includes(value as T)) {
      const error = new Error(
        `Environment variable "${name}" must be one of: ${values.join(
          ', '
        )}. Got: "${value}"`
      );
      Error.captureStackTrace(error, Environment.getEnumOrThrow);
      throw error;
    }
    return value as T;
  },
  getOrDefault: (name: string, defaultValue: string) => {
    return process.env[name] ?? defaultValue;
  },
  maybeGet: (name: string) => {
    return process.env[name];
  },
  isTest: () => process.env.NODE_ENV === 'test',
  isProduction: () => process.env.NODE_ENV === 'production',
  isDev: () => process.env.NODE_ENV === 'development',

  getIntOrThrow: (name: string) => {
    const value = Environment.getOrThrow(name);
    const parsed = Number(value);
    if (isNaN(parsed) || !Number.isInteger(parsed)) {
      const error = new Error(
        `Environment variable "${name}" is not an integer`
      );
      Error.captureStackTrace(error, Environment.getIntOrThrow);
      throw error;
    }
    return parsed;
  },
  getIntOrDefault: (name: string, defaultValue: number) => {
    const value = Environment.maybeGet(name);
    if (!value) {
      return defaultValue;
    }
    const parsed = Number(value);
    if (isNaN(parsed) || !Number.isInteger(parsed)) {
      return defaultValue;
    }
    return parsed;
  },
  maybeGetInt: (name: string) => {
    const value = Environment.maybeGet(name);
    if (!value) {
      return undefined;
    }
    const parsed = Number(value);
    if (isNaN(parsed) || !Number.isInteger(parsed)) {
      return undefined;
    }
    return parsed;
  },
};

const isValidNodeEnv =
  Environment.isTest() || Environment.isDev() || Environment.isProduction();

if (!isValidNodeEnv) {
  throw new Error('Invalid NODE_ENV ' + process.env.NODE_ENV);
}
