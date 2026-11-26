import { S3ConfigSchema } from "../../src/config";

// Only the disposable harness supplies this; never read the user's opsync.toml.
export const s3Fixture = process.env.OPSYNC_S3_TEST_CONFIG
    ? S3ConfigSchema.parse(JSON.parse(process.env.OPSYNC_S3_TEST_CONFIG))
    : undefined;
